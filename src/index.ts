import TelegramBot from "node-telegram-bot-api";
import { ethers } from "ethers";
import mongoose from "mongoose";
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Configuration
const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  ABSTRACT_RPC_URL:
    process.env.ABSTRACT_RPC_URL || "https://abstract-chain-rpc-url",
  RESERVOIR_API_URL: process.env.RESERVOIR_API_URL || "https://api.relay.link",
  DB_CONNECTION_STRING:
    process.env.DB_CONNECTION_STRING ||
    "mongodb://localhost:27017/abstract_trading_bot",
  ENCRYPTION_KEY:
    process.env.ENCRYPTION_KEY || "default-encryption-key-32-chars-long",
  GAS_LIMIT: process.env.GAS_LIMIT || "500000",
  GAS_PRICE: process.env.GAS_PRICE || "1000000000",
};

// Database Models
interface IUser extends mongoose.Document {
  telegramId: number;
  walletAddress?: string;
  encryptedPrivateKey?: string;
  createdAt: Date;
}

interface IOrder extends mongoose.Document {
  userId: number;
  type: "BUY" | "SELL";
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  slippage: number;
  status: "ACTIVE" | "FILLED" | "CANCELLED";
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new mongoose.Schema<IUser>({
  telegramId: { type: Number, required: true, unique: true },
  walletAddress: { type: String },
  encryptedPrivateKey: { type: String },
  createdAt: { type: Date, default: Date.now },
});

const orderSchema = new mongoose.Schema<IOrder>({
  userId: { type: Number, required: true },
  type: { type: String, enum: ["BUY", "SELL"], required: true },
  tokenIn: { type: String, required: true },
  tokenOut: { type: String, required: true },
  amountIn: { type: String, required: true },
  amountOut: { type: String, required: true },
  slippage: { type: Number, default: 0.5 },
  status: {
    type: String,
    enum: ["ACTIVE", "FILLED", "CANCELLED"],
    default: "ACTIVE",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const User = mongoose.model<IUser>("User", userSchema);
const Order = mongoose.model<IOrder>("Order", orderSchema);

// Encryption Service
class EncryptionService {
  private algorithm = "aes-256-cbc";
  private key: Buffer;

  constructor() {
    this.key = crypto.scryptSync(config.ENCRYPTION_KEY, "salt", 32);
  }

  encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    return `${iv.toString("hex")}:${encrypted}`;
  }

  decrypt(encryptedText: string): string {
    const [ivHex, encrypted] = encryptedText.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  }
}

const encryptionService = new EncryptionService();

// Abstract Chain Service
class AbstractChainService {
  private provider: ethers.Provider;
  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.ABSTRACT_RPC_URL);
  }
  async getWallet(telegramId: number) {
    const user = await User.findOne({ telegramId });
    if (!user || !user.encryptedPrivateKey) {
      throw new Error("Wallet not set up for this user");
    }

    const privateKey = encryptionService.decrypt(user.encryptedPrivateKey);
    return new ethers.Wallet(privateKey, this.provider);
  }

  async getBalance(telegramId: number, tokenAddress: string) {
    const wallet = await this.getWallet(telegramId);

    if (tokenAddress === "0x0000000000000000000000000000000000000000") {
      if (!wallet.provider) throw new Error("Provider is not initialized");
      return wallet.provider.getBalance(wallet.address);
    } else {
      const erc20Abi = [
        "function balanceOf(address owner) view returns (uint256)",
        "function decimals() view returns (uint8)",
      ];
      const contract = new ethers.Contract(tokenAddress, erc20Abi, wallet);
      const balance = await contract.balanceOf(wallet.address);
      const decimals = await contract.decimals();
      return ethers.formatUnits(balance, decimals);
    }
  }
  async sendTransaction(
    telegramId: number,
    transaction: ethers.TransactionRequest
  ) {
    const wallet = await this.getWallet(telegramId);
    const tx = await wallet.sendTransaction({
      ...transaction,
      gasLimit: config.GAS_LIMIT,
      gasPrice: ethers.parseUnits(config.GAS_PRICE, "wei"),
    });
    return tx.wait();
  }
}

const abstractChainService = new AbstractChainService();

// Reservoir Service
class ReservoirService {
  private api = axios.create({
    baseURL: config.RESERVOIR_API_URL,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });

  async getTokenPrice(tokenIn: string, tokenOut: string): Promise<number> {
    try {
      const response = await this.api.get<{ price: number }>(
        `/tokens/price?tokenIn=${tokenIn}&tokenOut=${tokenOut}`
      );
      return response.data.price;
    } catch (error) {
      console.error("Error fetching token price:", error);
      throw new Error("Failed to fetch token price");
    }
  }

  async getTokenInfo(tokenAddress: string): Promise<{ symbol: string }> {
    try {
      const response = await this.api.get<{ symbol: string }>(
        `/tokens/${tokenAddress}`
      );
      return response.data;
    } catch (error) {
      console.error("Error fetching token info:", error);
      throw new Error("Failed to fetch token info");
    }
  }

  async executeSwap(order: IOrder, telegramId: number) {
    try {
      const currentPrice = await this.getTokenPrice(
        order.tokenIn,
        order.tokenOut
      );
      const orderPrice =
        parseFloat(ethers.formatUnits(order.amountOut, 18)) /
        parseFloat(ethers.formatUnits(order.amountIn, 18));

      if (
        (order.type === "BUY" && currentPrice > orderPrice) ||
        (order.type === "SELL" && currentPrice < orderPrice)
      ) {
        throw new Error("Price condition no longer met");
      }

      const swapParams = {
        tokenIn: order.tokenIn,
        tokenOut: order.tokenOut,
        amountIn: order.amountIn,

        amountOutMin: ethers
          .parseUnits(
            (
              parseFloat(order.amountOut) *
              (1 - order.slippage / 100)
            ).toString(),
            18
          )
          .toString(),
        to: "", // Will be set to user's wallet
        deadline: Math.floor(Date.now() / 1000) + 60 * 20,
      };

      const response = await this.api.post("/swap", swapParams);
      const txData = response.data.txData;

      const tx = await abstractChainService.sendTransaction(telegramId, {
        to: txData.to,
        data: txData.data,
        value: txData.value,
      });

      return tx;
    } catch (error) {
      console.error("Error executing swap:", error);
      throw error;
    }
  }
}

const reservoirService = new ReservoirService();

// Telegram Bot Messages
const messages = {
  welcome: `🚀 *Welcome to Abstract Chain Trading Bot* 🚀

This bot allows you to trade tokens on Abstract Chain via Reservoir Tools.

*Available Commands:*
/setupwallet <private_key> - Setup your wallet
/buy <token_in> <token_out> <amount> <price> - Create buy order
/sell <token_in> <token_out> <amount> <price> - Create sell order
/orders - List your active orders
/balance <token_address> - Check your token balance

*Example:*
/buy 0xETH 0xABC 1 100 - Buy 1 ABC for 100 ETH each
/sell 0xABC 0xETH 10 0.01 - Sell 10 ABC for 0.01 ETH each`,

  orderCreated: (order: IOrder) => {
    return `✅ *Order Created* ✅

*Type:* ${order.type}
*Token In:* ${order.tokenIn}
*Token Out:* ${order.tokenOut}
*Amount In:* ${order.amountIn}
*Amount Out:* ${order.amountOut}
*Slippage:* ${order.slippage}%
*Status:* ${order.status}

Order ID: \`${order._id}\``;
  },

  orderDetails: (order: IOrder) => {
    return `📝 *Order Details* 📝

*Type:* ${order.type}
*Token In:* ${order.tokenIn}
*Token Out:* ${order.tokenOut}
*Amount In:* ${order.amountIn}
*Amount Out:* ${order.amountOut}
*Slippage:* ${order.slippage}%
*Status:* ${order.status}
*Created:* ${order.createdAt.toLocaleString()}

Order ID: \`${order._id}\``;
  },

  orderFilled: (order: IOrder, txHash: string) => {
    return `🎉 *Order Filled* 🎉

*Type:* ${order.type}
*Token In:* ${order.tokenIn}
*Token Out:* ${order.tokenOut}
*Amount In:* ${order.amountIn}
*Amount Out:* ${order.amountOut}

Transaction: \`${txHash}\``;
  },
};

// Telegram Bot Setup
const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });

// Start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  (await User.findOne({ telegramId: msg.from?.id })) ||
    (await User.create({ telegramId: msg.from?.id }));
  bot.sendMessage(chatId, messages.welcome, { parse_mode: "Markdown" });
});

// Setup wallet command
bot.onText(/\/setupwallet(?:\s(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId) return;

  try {
    const privateKey = match?.[1];
    if (!privateKey || !privateKey.match(/^[a-fA-F0-9]{64}$/)) {
      throw new Error("Invalid private key format");
    }

    const wallet = new ethers.Wallet(privateKey);
    const encryptedKey = encryptionService.encrypt(privateKey);

    console.log("encryptedKey", encryptedKey);

    await User.updateOne(
      { telegramId: userId },
      { walletAddress: wallet.address, encryptedPrivateKey: encryptedKey },
      { upsert: true }
    );

    bot.sendMessage(
      chatId,
      `✅ Wallet setup complete!\n\nAddress: \`${wallet.address}\``,
      {
        parse_mode: "Markdown",
      }
    );
  } catch (error) {
    bot.sendMessage(
      chatId,
      `❌ Error setting up wallet: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
});

// Create buy order command
bot.onText(
  /\/buy(?:\s(\S+))?(?:\s(\S+))?(?:\s([\d.]+))?(?:\s([\d.]+))?/,
  async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;

    try {
      const [, tokenIn, tokenOut, amountIn, price] = match || [];
      const amountOut = (parseFloat(amountIn) * parseFloat(price)).toString();

      const order = await Order.create({
        userId,
        type: "BUY",
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        slippage: 0.5,
      });

      bot.sendMessage(chatId, messages.orderCreated(order), {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Cancel Order", callback_data: `cancel_${order._id}` }],
          ],
        },
      });
    } catch (error) {
      bot.sendMessage(
        chatId,
        `❌ Error creating buy order: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
);

// Create sell order command
bot.onText(
  /\/sell(?:\s(\S+))?(?:\s(\S+))?(?:\s([\d.]+))?(?:\s([\d.]+))?/,
  async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;

    try {
      const [, tokenIn, tokenOut, amountIn, price] = match || [];
      const amountOut = (parseFloat(amountIn) * parseFloat(price)).toString();

      const order = await Order.create({
        userId,
        type: "SELL",
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        slippage: 0.5,
      });

      bot.sendMessage(chatId, messages.orderCreated(order), {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Cancel Order", callback_data: `cancel_${order._id}` }],
          ],
        },
      });
    } catch (error) {
      bot.sendMessage(
        chatId,
        `❌ Error creating sell order: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
);

// List orders command
bot.onText(/\/orders/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId) return;

  try {
    const orders = await Order.find({ userId, status: "ACTIVE" }).sort({
      createdAt: -1,
    });
    if (orders.length === 0) {
      bot.sendMessage(chatId, "You have no active orders.");
      return;
    }

    for (const order of orders) {
      bot.sendMessage(chatId, messages.orderDetails(order), {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Cancel Order", callback_data: `cancel_${order._id}` }],
          ],
        },
      });
    }
  } catch (error) {
    bot.sendMessage(
      chatId,
      `❌ Error fetching orders: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
});

// Balance command
bot.onText(/\/balance(?:\s(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId) return;

  try {
    const tokenAddress = match?.[1];
    if (!tokenAddress) {
      bot.sendMessage(chatId, "Please provide a valid token address");
      return;
    }
    const balance = await abstractChainService.getBalance(userId, tokenAddress);
    const tokenInfo = await reservoirService.getTokenInfo(tokenAddress);

    bot.sendMessage(chatId, `Balance: ${balance} ${tokenInfo.symbol}`, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    bot.sendMessage(
      chatId,
      `❌ Error fetching balance: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
});
// Handle inline buttons
bot.on("callback_query", async (callbackQuery) => {
  const message = callbackQuery.message;
  const data = callbackQuery.data;

  if (!message || !data) return;

  try {
    if (data.startsWith("cancel_")) {
      const orderId = data.split("_")[1];
      const order = await Order.findByIdAndUpdate(
        orderId,
        { status: "CANCELLED", updatedAt: new Date() },
        { new: true }
      );

      if (order) {
        bot.editMessageText(`❌ Order cancelled: ${orderId}`, {
          chat_id: message.chat.id,
          message_id: message.message_id,
        });
      }
    }
  } catch (error) {
    bot.sendMessage(
      message.chat.id,
      `❌ Error processing action: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
});

// Order Monitoring
const orderMonitor = setInterval(async () => {
  try {
    console.log("Checking active orders...");
    // In a real implementation, we would check and execute orders here
    // For simplicity, this is omitted in the single-file version
  } catch (error) {
    console.error("Error in order monitoring:", error);
  }
}, 60000);

// Database Connection and Startup
mongoose
  .connect(config.DB_CONNECTION_STRING)
  .then(() => {
    console.log("Connected to database");
    console.log("Bot is running...");
  })
  .catch((error) => {
    console.error("Database connection error:", error);
    process.exit(1);
  });

// Graceful shutdown
process.on("SIGINT", () => {
  clearInterval(orderMonitor);
  bot.stopPolling();
  mongoose.disconnect();
  console.log("Bot has been stopped");
  process.exit();
});

process.on("SIGTERM", () => {
  clearInterval(orderMonitor);
  bot.stopPolling();
  mongoose.disconnect();
  console.log("Bot has been stopped");
  process.exit();
});
