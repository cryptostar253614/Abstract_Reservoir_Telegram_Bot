import TelegramBot from "node-telegram-bot-api";
import { ethers } from "ethers";
import mongoose from "mongoose";
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";

// Load environment variables
dotenv.config();

type ReservoirSwapStep = {
  id: string;
  items: {
    status: string;
    data: {
      from: string;
      to: string;
      data: string;
      value: string;
      gas?: string;
      gasPrice?: string;
    };
  }[];
};

// Configuration
const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  ABSTRACT_RPC_URL:
    process.env.ABSTRACT_RPC_URL || "https://api.mainnet.abs.xyz",
  RESERVOIR_API_URL: process.env.RESERVOIR_API_URL || "https://api.relay.link",
  DB_CONNECTION_STRING:
    process.env.DB_CONNECTION_STRING ||
    "mongodb://localhost:27017/reservoir_bot",
  ENCRYPTION_KEY:
    process.env.ENCRYPTION_KEY || "default-encryption-key-32-chars-long",
  GAS_LIMIT: process.env.GAS_LIMIT || "500000",
  GAS_PRICE: process.env.GAS_PRICE || "1000000000",
};

interface IWallet {
  address: string;
  encryptedKey: string;
}

interface IUser extends mongoose.Document {
  telegramId: number;
  wallets: IWallet[];
  createdAt: Date;
}

interface IOrder extends mongoose.Document {
  userId: number;
  wallet: IWallet;
  type: "BUY" | "SELL";
  tokenIn: string;
  tokenOut: string;
  amount: number;
  triggerPrice: number;
  slippage: number;
  status: "ACTIVE" | "FILLED" | "CANCELLED";
  expiry: number; // Expiry time as a timestamp (in seconds)
  createdAt: Date;
  updatedAt: Date;
}

const walletSchema = new mongoose.Schema<IWallet>({
  address: { type: String, required: true },
  encryptedKey: { type: String, required: true },
});

const userSchema = new mongoose.Schema<IUser>({
  telegramId: { type: Number, required: true, unique: true },
  wallets: { type: [walletSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});

const orderSchema = new mongoose.Schema<IOrder>(
  {
    userId: { type: Number, required: true },
    wallet: { type: walletSchema, required: true },
    type: { type: String, enum: ["BUY", "SELL"], required: true },
    tokenIn: { type: String, required: true },
    tokenOut: { type: String, required: true },
    amount: { type: Number, required: true },
    triggerPrice: { type: Number, required: true },
    slippage: { type: Number, required: true },
    status: {
      type: String,
      enum: ["ACTIVE", "FILLED", "CANCELLED"],
      default: "ACTIVE",
    },
    expiry: { type: Number, required: false }, // Store expiry as a timestamp
  },
  { timestamps: true }
);

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
  async getWallet(wallet: IWallet) {
    const privateKey = encryptionService.decrypt(wallet.encryptedKey);
    return new ethers.Wallet(privateKey, this.provider);
  }

  async getBalance(tokenAddress: string, wallet_: IWallet) {
    const wallet = await this.getWallet(wallet_);

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
      //   const decimals = await contract.decimals();
      //   ethers.formatUnits(balance, decimals);
      return balance;
    }
  }
  async executeReservoirSwap(
    steps: ReservoirSwapStep[],
    signer: ethers.Signer
  ) {
    let tx_hash: string | undefined;
    for (const step of steps) {
      for (const item of step.items) {
        const txData = item.data;

        const tx = {
          to: txData.to,
          data: txData.data,
          value: txData.value ? ethers.toBigInt(txData.value) : 0n,
          gasLimit: txData.gas ? ethers.toBigInt(txData.gas) : undefined,
          gasPrice: txData.gasPrice
            ? ethers.toBigInt(txData.gasPrice)
            : undefined,
        };

        try {
          const txResponse = await signer.sendTransaction(tx);
          const receipt = await txResponse.wait();
          if (step.id.toLowerCase() === "swap") {
            console.log(`✅ ${step.id} confirmed: ${receipt!.hash}`);
            tx_hash = receipt!.hash;
          }
        } catch (err) {
          throw err; // You may want to handle or log it better
        }
      }
    }
    return tx_hash;
  }
}

const abstractChainService = new AbstractChainService();

// Telegram Bot Messages
const messages = {
  welcome: `🚀 *Welcome to Abstract Chain Trading Bot* 🚀

`,
};

// Telegram Bot Setup
const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, {
  polling: true,
});
(async () => {
  await bot.setMyCommands([{ command: "start", description: "Start the bot" }]);
  await mongoose.connect(process.env.DB_CONNECTION_STRING!);
  console.log("✅ MongoDB connected");
})();

const userStates = new Map<number, string>();
const selectedWallets = new Map();
const pendingOrders = new Map();

// Start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  const filePath = path.join(__dirname, "1.jpg");

  (await User.findOne({ telegramId: msg.from?.id })) ||
    (await User.create({ telegramId: msg.from?.id }));
  bot.sendPhoto(chatId, filePath, {
    caption: messages.welcome,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🧾 Setup Wallet", callback_data: "setupwallet" },
          { text: "📋 View All Orders", callback_data: "viewallorders" },
        ],
        [
          { text: "🟢 Buy Limit Order", callback_data: "buylimitorder" },
          { text: "🔴 Sell Limit Order", callback_data: "selllimitorder" },
        ],
      ],
    },
  });
});
bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat.id;
  const userId = query.from.id;
  const data = query.data;

  if (!chatId || !userId || !data) return;

  if (data.startsWith("buy_wallet_")) {
    const walletAddress = data.replace("buy_wallet_", "");
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    const selectedWallet = user.wallets.find(
      (w) => w.address === walletAddress
    );

    if (!selectedWallet) {
      await bot.sendMessage(chatId, "⚠️ Wallet not found.");
      return;
    }

    pendingOrders.set(userId, {
      wallet: selectedWallet,
      type: "BUY",
      tokenIn: "0x3439153EB7AF838Ad19d56E1571FBD09333C2809",
      tokenOut: null,
      amount: null,
      triggerPrice: null,
      slippage: 1,
      expiry: "1h",
    });

    await bot.sendMessage(chatId, `🟢 *Buy Limit Order*`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔘 Token To Buy",
              callback_data: "edit_token_buy", // this lets user change token if needed
            },
          ],
          [
            { text: "✅ Slippage: Auto", callback_data: "slippage_auto_buy" },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_buy",
            },
          ],
          [
            { text: "Trigger Price: $–", callback_data: "trigger_price_buy" },
            { text: "Expire Time", callback_data: "expiry_buy" },
          ],
          [
            {
              text: "Amount: WETH",
              callback_data: "edit_amount_buy",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_buy" }],
        ],
      },
    });
  }

  if (data.startsWith("sell_wallet_")) {
    const walletAddress = data.replace("sell_wallet_", "");
    const user = await User.findOne({ telegramId: userId });
    if (!user) return;

    const selectedWallet = user.wallets.find(
      (w) => w.address === walletAddress
    );

    if (!selectedWallet) {
      await bot.sendMessage(chatId, "⚠️ Wallet not found.");
      return;
    }
    selectedWallets.set(userId, selectedWallet);

    pendingOrders.set(userId, {
      wallet: selectedWallet,
      type: "SELL",
      tokenIn: null,
      tokenOut: "0x3439153EB7AF838Ad19d56E1571FBD09333C2809",
      amount: null,
      triggerPrice: null,
      slippage: 1,
      expiry: "1h",
    });

    await bot.sendMessage(chatId, `🟢 *SELL Limit Order*`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🔘 Token To Sell",
              callback_data: "edit_token_sell",
            },
          ],
          [
            { text: "✅ Slippage: Auto", callback_data: "slippage_auto_sell" },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_sell",
            },
          ],
          [
            { text: "Trigger Price: $–", callback_data: "trigger_price_sell" },
            { text: "Expire Time", callback_data: "expiry_sell" },
          ],
          [
            {
              text: "Amount: Token",
              callback_data: "edit_amount_sell",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_sell" }],
        ],
      },
    });
  }

  if (data.startsWith("amount_sell_percent_")) {
    const selectedWallet = selectedWallets.get(userId);
    const pendingOrder = pendingOrders.get(userId);

    if (!selectedWallet || !pendingOrder?.tokenIn) {
      await bot.sendMessage(chatId, "⚠️ Wallet or token not selected.");
      return;
    }

    const percentStr = data.replace("amount_sell_percent_", "");
    const percent = parseFloat(percentStr);

    try {
      const balance = await abstractChainService.getBalance(
        pendingOrder.tokenIn,
        selectedWallet
      );

      if (Number(balance) === 0) {
        await bot.sendMessage(chatId, "😕 Your wallet has 0 token.");
        return;
      }

      const selectedAmount = Math.floor(Number(balance) * percent);
      pendingOrder.amount = selectedAmount;
      pendingOrders.set(userId, pendingOrder);
      const tokenLabel = pendingOrder.tokenIn
        ? `🔘 Token: ${pendingOrder.tokenIn.slice(
            0,
            6
          )}...${pendingOrder.tokenIn.slice(-4)}`
        : "🔘 Token To Sell";
      await bot.sendMessage(
        chatId,
        `✅ You selected *${selectedAmount} tokens* to sell.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: tokenLabel,
                  callback_data: "edit_token_sell",
                },
              ],
              [
                {
                  text: "✅ Slippage: Auto",
                  callback_data: "slippage_auto_sell",
                },
                {
                  text: "Slippage: Custom %",
                  callback_data: "slippage_custom_sell",
                },
              ],
              [
                {
                  text: "Trigger Price: $–",
                  callback_data: "trigger_price_sell",
                },
                { text: "Expire Time", callback_data: "expiry_sell" },
              ],
              [
                {
                  text: "Amount: Token",
                  callback_data: "edit_amount_sell",
                },
              ],
              [{ text: "🟣 Create Order", callback_data: "create_order_sell" }],
            ],
          },
        }
      );
    } catch (err) {
      console.error("Error handling percentage selection:", err);
      await bot.sendMessage(chatId, "❌ Failed to set amount.");
    }
  }

  if (data.startsWith("expiry_buy_")) {
    const value = data.replace("expiry_buy_", "");

    const order = pendingOrders.get(userId);
    if (!order) {
      await bot.sendMessage(chatId, "⚠️ No order in progress.");
      return;
    }

    order.expiry = value;
    pendingOrders.set(userId, order);
    const tokenLabel = order.tokenOut
      ? `🔘 Token: ${order.tokenOut.slice(0, 6)}...${order.tokenOut.slice(-4)}`
      : "🔘 Token To Buy";
    await bot.sendMessage(chatId, `✅ Expiry updated to ${value}`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tokenLabel,
              callback_data: "edit_token_buy",
            },
          ],
          [
            { text: "✅ Slippage: Auto", callback_data: "slippage_auto_buy" },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_buy",
            },
          ],
          [
            { text: "Trigger Price: $–", callback_data: "trigger_price_buy" },
            { text: "Expire Time", callback_data: "expiry_buy" },
          ],
          [
            {
              text: "Amount: WETH",
              callback_data: "edit_amount_buy",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_buy" }],
        ],
      },
    });
  }

  if (data.startsWith("expiry_sell_")) {
    const value = data.replace("expiry_sell_", "");

    const order = pendingOrders.get(userId);
    if (!order) {
      await bot.sendMessage(chatId, "⚠️ No order in progress.");
      return;
    }

    order.expiry = value;
    pendingOrders.set(userId, order);
    const tokenLabel = order.tokenIn
      ? `🔘 Token: ${order.tokenIn.slice(0, 6)}...${order.tokenIn.slice(-4)}`
      : "🔘 Token To Sell";
    await bot.sendMessage(chatId, `✅ Expiry updated to ${value}`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tokenLabel,
              callback_data: "edit_token_sell",
            },
          ],
          [
            {
              text: "✅ Slippage: Auto",
              callback_data: "slippage_auto_sell",
            },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_sell",
            },
          ],
          [
            {
              text: "Trigger Price: $–",
              callback_data: "trigger_price_sell",
            },
            { text: "Expire Time", callback_data: "expiry_sell" },
          ],
          [
            {
              text: "Amount: Token",
              callback_data: "edit_amount_sell",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_sell" }],
        ],
      },
    });
  }

  if (data.startsWith("select_token_sell_")) {
    const tokenAddress = data.replace("select_token_sell_", "");

    const existingOrder = pendingOrders.get(userId);
    if (!existingOrder || existingOrder.type !== "SELL") {
      await bot.sendMessage(chatId, "❌ No SELL order in progress.");
      return;
    }

    existingOrder.tokenIn = tokenAddress;
    pendingOrders.set(userId, existingOrder);

    const shortToken = `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(
      -4
    )}`;

    await bot.sendMessage(chatId, `✅ Token to SELL set:\n\`${shortToken}\``, {
      parse_mode: "Markdown",
    });

    // Optionally show SELL Limit Order UI again
  }

  if (data === "buylimitorder") {
    const user = await User.findOne({ telegramId: userId });
    if (!user || user.wallets.length === 0) {
      await bot.sendMessage(chatId, "❌ You have no wallets set up.");
      return;
    }

    const walletButtons = user.wallets.map((w) => [
      {
        text: `${w.address.slice(0, 6)}...${w.address.slice(-4)}`,
        callback_data: `buy_wallet_${w.address}`,
      },
    ]);

    await bot.sendMessage(
      chatId,
      "💼 Choose a wallet for your Buy Limit Order:",
      {
        reply_markup: { inline_keyboard: walletButtons },
      }
    );
  }

  if (data === "selllimitorder") {
    const user = await User.findOne({ telegramId: userId });
    if (!user || user.wallets.length === 0) {
      await bot.sendMessage(chatId, "❌ You have no wallets set up.");
      return;
    }

    const walletButtons = user.wallets.map((w) => [
      {
        text: `${w.address.slice(0, 6)}...${w.address.slice(-4)}`,
        callback_data: `sell_wallet_${w.address}`,
      },
    ]);

    await bot.sendMessage(
      chatId,
      "💼 Choose a wallet for your Sell Limit Order:",
      {
        reply_markup: { inline_keyboard: walletButtons },
      }
    );
  }

  if (data === "create_order_sell") {
    // Retrieve the pending order for this user
    const order = pendingOrders.get(userId);

    if (!order) {
      await bot.sendMessage(chatId, "⚠️ No pending buy order found.");
      return;
    }

    let expiryValue = null;

    if (order.expiry !== "none") {
      const expiryInSeconds = parseExpiry(order.expiry);
      expiryValue = Date.now() + expiryInSeconds * 1000;
    }

    // Create an order document to save in the database
    const newOrder = new Order({
      userId: userId,
      wallet: order.wallet,
      type: order.type,
      tokenIn: order.tokenIn,
      tokenOut: order.tokenOut,
      amount: order.amount,
      triggerPrice: order.triggerPrice,
      slippage: order.slippage,
      status: "ACTIVE", // Set the initial status to ACTIVE
      expiry: expiryValue,
    });

    try {
      // Save the order to the database
      await newOrder.save();

      // Clear the pending order for the user
      pendingOrders.delete(userId);

      // Notify the user that the order was created successfully
      await bot.sendMessage(
        chatId,
        `✅ Order created successfully! Your buy order is now active.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🧾 Setup Wallet", callback_data: "setupwallet" },
                {
                  text: "📋 View All Orders",
                  callback_data: "viewallorders",
                },
              ],
              [
                {
                  text: "🟢 Buy Limit Order",
                  callback_data: "buylimitorder",
                },
                {
                  text: "🔴 Sell Limit Order",
                  callback_data: "selllimitorder",
                },
              ],
            ],
          },
        }
      );
    } catch (error) {
      console.error("Error saving the order:", error);
      await bot.sendMessage(
        chatId,
        "❌ There was an error creating the order. Please try again later."
      );
    }
  }

  if (data === "create_order_buy") {
    // Retrieve the pending order for this user
    const order = pendingOrders.get(userId);

    if (!order) {
      await bot.sendMessage(chatId, "⚠️ No pending buy order found.");
      return;
    }

    let expiryValue = null;

    if (order.expiry !== "none") {
      const expiryInSeconds = parseExpiry(order.expiry);
      expiryValue = Date.now() + expiryInSeconds * 1000;
    }

    // Create an order document to save in the database
    const newOrder = new Order({
      userId: userId,
      wallet: order.wallet,
      type: order.type,
      tokenIn: order.tokenIn,
      tokenOut: order.tokenOut,
      amount: order.amount,
      triggerPrice: order.triggerPrice,
      slippage: order.slippage,
      status: "ACTIVE", // Set the initial status to ACTIVE
      expiry: expiryValue,
    });

    try {
      // Save the order to the database
      await newOrder.save();

      // Clear the pending order for the user
      pendingOrders.delete(userId);

      // Notify the user that the order was created successfully
      await bot.sendMessage(
        chatId,
        `✅ Order created successfully! Your buy order is now active.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🧾 Setup Wallet", callback_data: "setupwallet" },
                {
                  text: "📋 View All Orders",
                  callback_data: "viewallorders",
                },
              ],
              [
                {
                  text: "🟢 Buy Limit Order",
                  callback_data: "buylimitorder",
                },
                {
                  text: "🔴 Sell Limit Order",
                  callback_data: "selllimitorder",
                },
              ],
            ],
          },
        }
      );
    } catch (error) {
      console.error("Error saving the order:", error);
      await bot.sendMessage(
        chatId,
        "❌ There was an error creating the order. Please try again later."
      );
    }
  }

  if (data.startsWith("cancel_order_")) {
    const orderId = data.replace("cancel_order_", "");

    try {
      const order = await Order.findById(orderId);
      if (!order) {
        await bot.sendMessage(chatId, "❌ Order not found.");
        return;
      }

      if (order.status !== "ACTIVE") {
        await bot.sendMessage(
          chatId,
          "⚠️ Order is already cancelled or filled."
        );
        return;
      }

      // Mark as CANCELLED
      order.status = "CANCELLED";
      await order.save();

      await bot.sendMessage(chatId, `🗑️ Order cancelled successfully.`);
    } catch (err) {
      console.error("❌ Failed to cancel order:", err);
      await bot.sendMessage(
        chatId,
        "❌ Something went wrong while cancelling."
      );
    }
  }

  if (data === "slippage_auto_sell") {
    const pendingOrder = pendingOrders.get(userId);
    if (!pendingOrder) {
      await bot.sendMessage(chatId, "⚠️ No pending sell order found.");
      return;
    }

    // Set default auto slippage (e.g., 1%)
    const autoSlippage = 1;
    pendingOrder.slippage = autoSlippage;
    pendingOrders.set(userId, pendingOrder);
    // Optionally resend updated UI
    const tokenLabel = pendingOrder.tokenIn
      ? `🔘 Token: ${pendingOrder.tokenIn.slice(
          0,
          6
        )}...${pendingOrder.tokenIn.slice(-4)}`
      : "Token To Sell";

    await bot.sendMessage(chatId, `✅ Auto slippage set to ${autoSlippage}%`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tokenLabel,
              callback_data: "edit_token_sell",
            },
          ],
          [
            {
              text: `✅ Slippage: Auto`,
              callback_data: "slippage_auto_sell",
            },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_sell",
            },
          ],
          [
            {
              text: "Trigger Price: $–",
              callback_data: "trigger_price_sell",
            },
            { text: "Expire Time", callback_data: "expiry_sell" },
          ],
          [
            {
              text: `Amount: ${pendingOrder.amount || "Token"}`,
              callback_data: "edit_amount_sell",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_sell" }],
        ],
      },
    });
  }

  if (data === "slippage_auto_buy") {
    const pendingOrder = pendingOrders.get(userId);
    if (!pendingOrder) {
      await bot.sendMessage(chatId, "⚠️ No pending sell order found.");
      return;
    }

    // Set default auto slippage (e.g., 1%)
    const autoSlippage = 1;
    pendingOrder.slippage = autoSlippage;
    pendingOrders.set(userId, pendingOrder);
    // Optionally resend updated UI
    const tokenLabel = pendingOrder.tokenIn
      ? `🔘 Token: ${pendingOrder.tokenIn.slice(
          0,
          6
        )}...${pendingOrder.tokenIn.slice(-4)}`
      : "Token To Buy";

    await bot.sendMessage(chatId, `✅ Auto slippage set to ${autoSlippage}%`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tokenLabel,
              callback_data: "edit_token_buy",
            },
          ],
          [
            { text: "✅ Slippage: Auto", callback_data: "slippage_auto_buy" },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_buy",
            },
          ],
          [
            { text: "Trigger Price: $–", callback_data: "trigger_price_buy" },
            { text: "Expire Time", callback_data: "expiry_buy" },
          ],
          [
            {
              text: "Amount: WETH",
              callback_data: "edit_amount_buy",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_buy" }],
        ],
      },
    });
  }

  switch (data) {
    case "edit_token_buy":
      // Mark user as awaiting tokenOut input
      userStates.set(userId, "AWAITING_TOKEN_INPUT_BUY");
      await bot.sendMessage(
        chatId,
        "💠 Please enter the *token address* you want to BUY:",
        {
          parse_mode: "Markdown",
        }
      );
      break;
    case "edit_token_sell":
      userStates.set(userId, "AWAITING_TOKEN_INPUT_SELL");
      await bot.sendMessage(
        chatId,
        "💠 Please enter the *token address* you want to SELL:",
        {
          parse_mode: "Markdown",
        }
      );
      break;

    case "edit_amount_buy":
      userStates.set(userId, "AWAITING_AMOUNT_INPUT_BUY");
      await bot.sendMessage(
        chatId,
        "💰 Enter the amount you want to buy: (e.g., 0.5 ETH)"
      );
      break;
    case "edit_amount_sell":
      const selectedWallet = selectedWallets.get(userId);
      const pendingOrder = pendingOrders.get(userId);

      if (!selectedWallet || !pendingOrder?.tokenIn) {
        await bot.sendMessage(
          chatId,
          "⚠️ Please select a wallet and token first."
        );
        return;
      }

      try {
        const balance = await abstractChainService.getBalance(
          pendingOrder.tokenIn,
          selectedWallet
        );

        if (Number(balance) === 0) {
          await bot.sendMessage(chatId, `😕 Your wallet has 0 token.`);
          return;
        }

        // Generate percentages
        const makeButton = (percent: number) => {
          const amount = Math.floor(Number(balance) * percent);
          return {
            text: `${percent * 100}% (${amount} token)`,
            callback_data: `amount_sell_percent_${percent}`,
          };
        };

        await bot.sendMessage(
          chatId,
          `💰 Enter the amount you want to sell or choose a percentage:\n*Available: ${balance} token*`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [makeButton(0.2), makeButton(0.5)],
                [makeButton(0.7), makeButton(1.0)],
              ],
            },
          }
        );
      } catch (err) {
        console.error("Error getting token balance:", err);
        await bot.sendMessage(chatId, "❌ Failed to retrieve token balance.");
      }

      break;

    case "slippage_custom_buy":
      userStates.set(userId, "AWAITING_SLIPPAGE_INPUT_BUY");
      await bot.sendMessage(chatId, "🧮 Enter slippage % (e.g., 0.5):");
      break;

    case "slippage_custom_sell":
      userStates.set(userId, "AWAITING_SLIPPAGE_INPUT_SELL");
      await bot.sendMessage(chatId, "🧮 Enter slippage % (e.g., 0.5):");
      break;

    case "trigger_price_buy":
      userStates.set(userId, "AWAITING_TRIGGER_PRICE_INPUT_BUY");
      await bot.sendMessage(chatId, "🎯 Enter trigger price (e.g., 0.00416):");
      break;
    case "trigger_price_sell":
      userStates.set(userId, "AWAITING_TRIGGER_PRICE_INPUT_SELL");
      await bot.sendMessage(chatId, "🎯 Enter trigger price (e.g., 0.00416):");
      break;

    case "expiry_buy":
      await bot.sendMessage(chatId, "⏳ Choose expiry time:", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "30m", callback_data: "expiry_buy_30m" },
              { text: "1h", callback_data: "expiry_buy_1h" },
            ],
            [
              { text: "4h", callback_data: "expiry_buy_4h" },
              { text: "1d", callback_data: "expiry_buy_1d" },
            ],
            [
              { text: "4d", callback_data: "expiry_buy_4d" },
              { text: "♾️ No Expiry", callback_data: "expiry_buy_none" },
            ],
          ],
        },
      });
      break;

    case "expiry_sell":
      await bot.sendMessage(chatId, "⏳ Choose expiry time:", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "30m", callback_data: "expiry_sell_30m" },
              { text: "1h", callback_data: "expiry_sell_1h" },
            ],
            [
              { text: "4h", callback_data: "expiry_sell_4h" },
              { text: "1d", callback_data: "expiry_sell_1d" },
            ],
            [
              { text: "4d", callback_data: "expiry_sell_4d" },
              { text: "♾️ No Expiry", callback_data: "expiry_sell_none" },
            ],
          ],
        },
      });
      break;

    case "setupwallet":
      userStates.set(userId, "AWAITING_PRIVATE_KEY");
      await bot.sendMessage(chatId, "🔐 Please enter your private key:");
      break;

    case "viewallorders":
      const activeOrders = await Order.find({
        userId: userId,
        status: "ACTIVE",
      });

      if (!activeOrders.length) {
        await bot.sendMessage(chatId, "📭 No active orders found.");
        return;
      }

      for (const order of activeOrders) {
        const shortTokenIn = `${order.tokenIn.slice(
          0,
          6
        )}...${order.tokenIn.slice(-4)}`;
        const shortTokenOut = `${order.tokenOut.slice(
          0,
          6
        )}...${order.tokenOut.slice(-4)}`;
        const walletShort = `${order.wallet.address.slice(
          0,
          6
        )}...${order.wallet.address.slice(-4)}`;
        const expiryDate = order.expiry
          ? new Date(order.expiry).toLocaleString()
          : "No Expiry";

        const orderText =
          `📄 *${order.type} Limit Order*\n\n` +
          `🧾 *Wallet:* \`${walletShort}\`\n` +
          `💱 *Token In:* \`${shortTokenIn}\`\n` +
          `🎯 *Token Out:* \`${shortTokenOut}\`\n` +
          `💰 *Amount:* ${order.amount}\n` +
          `📌 *Trigger Price:* $${order.triggerPrice}\n` +
          `⚙️ *Slippage:* ${order.slippage}%\n` +
          `⏰ *Expires:* ${expiryDate}`;

        await bot.sendMessage(chatId, orderText, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "❌ Cancel Order",
                  callback_data: `cancel_order_${order._id}`,
                },
              ],
            ],
          },
        });
      }
      break;
  }

  // Answer callback to remove "Loading..." popup
  bot.answerCallbackQuery(query.id);
});
// Step 2: Wait for the private key input
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = msg.text?.trim();

  if (!userId || !text || text.startsWith("/")) return;

  const state = userStates.get(userId);

  if (state === "AWAITING_TOKEN_INPUT_BUY") {
    // Optionally validate address
    if (!/^0x[a-fA-F0-9]{40}$/.test(text)) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid address. Please send a valid Ethereum token address."
      );
      return;
    }

    const order = pendingOrders.get(userId);
    if (!order) {
      await bot.sendMessage(chatId, "⚠️ No order in progress.");
      return;
    }

    order.tokenOut = text;
    pendingOrders.set(userId, order);

    // Clear the state
    userStates.delete(userId);

    // Optionally resend the Buy Limit Order UI
    const shortToken = `${text.slice(0, 6)}...${text.slice(-4)}`;
    await bot.sendMessage(chatId, `✅ *Token to Buy* set:\n\`${shortToken}\``, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `🔘 Token: ${shortToken}`,
              callback_data: "edit_token_buy",
            },
          ],
          [
            { text: "✅ Slippage: Auto", callback_data: "slippage_auto_buy" },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_buy",
            },
          ],
          [
            { text: "Trigger Price: $–", callback_data: "trigger_price_buy" },
            { text: "Expire Time", callback_data: "expiry_buy" },
          ],
          [
            {
              text: "Amount: WETH",
              callback_data: "edit_amount_buy",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_buy" }],
        ],
      },
    });
  }

  if (state === "AWAITING_TOKEN_INPUT_SELL") {
    // Optionally validate address
    if (!/^0x[a-fA-F0-9]{40}$/.test(text)) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid address. Please send a valid Ethereum token address."
      );
      return;
    }

    const order = pendingOrders.get(userId);
    if (!order) {
      await bot.sendMessage(chatId, "⚠️ No order in progress.");
      return;
    }

    order.tokenIn = text;
    pendingOrders.set(userId, order);

    // Clear the state
    userStates.delete(userId);

    // Optionally resend the Buy Limit Order UI
    const shortToken = `${text.slice(0, 6)}...${text.slice(-4)}`;
    await bot.sendMessage(
      chatId,
      `✅ *Token to Sell* set:\n\`${shortToken}\``,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `🔘 Token: ${shortToken}`,
                callback_data: "edit_token_sell",
              },
            ],
            [
              {
                text: "✅ Slippage: Auto",
                callback_data: "slippage_auto_sell",
              },
              {
                text: "Slippage: Custom %",
                callback_data: "slippage_custom_sell",
              },
            ],
            [
              {
                text: "Trigger Price: $–",
                callback_data: "trigger_price_sell",
              },
              { text: "Expire Time", callback_data: "expiry_sell" },
            ],
            [
              {
                text: "Amount: Token",
                callback_data: "edit_amount_sell",
              },
            ],
            [{ text: "🟣 Create Order", callback_data: "create_order_sell" }],
          ],
        },
      }
    );
  }

  if (state === "AWAITING_PRIVATE_KEY") {
    try {
      if (!text.match(/^[a-fA-F0-9]{64}$/)) {
        throw new Error("Invalid private key format");
      }

      const wallet = new ethers.Wallet(text);
      const encryptedKey = encryptionService.encrypt(text);

      console.log("encryptedKey", encryptedKey);

      await User.updateOne(
        { telegramId: userId },
        {
          $push: {
            wallets: {
              address: wallet.address,
              encryptedKey: encryptedKey,
            },
          },
        },
        { upsert: true }
      );

      userStates.delete(userId);

      bot.sendMessage(
        chatId,
        `✅ Wallet setup complete!\n\nAddress: \`${wallet.address}\``,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🧾 Setup Wallet", callback_data: "setupwallet" },
                { text: "📋 View All Orders", callback_data: "viewallorders" },
              ],
              [
                { text: "🟢 Buy Limit Order", callback_data: "buylimitorder" },
                {
                  text: "🔴 Sell Limit Order",
                  callback_data: "selllimitorder",
                },
              ],
            ],
          },
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
    return;
  }

  if (state === "AWAITING_AMOUNT_INPUT_BUY") {
    const amount = parseFloat(text);

    if (isNaN(amount) || amount <= 0) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid amount. Please enter a number."
      );
      return;
    }

    const order = pendingOrders.get(userId);
    if (!order) {
      await bot.sendMessage(chatId, "⚠️ No order in progress.");
      return;
    }

    order.amount = amount * 1e18;
    pendingOrders.set(userId, order);
    userStates.delete(userId);
    const tokenLabel = order.tokenOut
      ? `🔘 Token: ${order.tokenOut.slice(0, 6)}...${order.tokenOut.slice(-4)}`
      : "🔘 Token To Buy";
    await bot.sendMessage(chatId, `✅ Amount set to ${amount} ETH!`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tokenLabel,
              callback_data: "edit_token_buy",
            },
          ],
          [
            { text: "✅ Slippage: Auto", callback_data: "slippage_auto_buy" },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_buy",
            },
          ],
          [
            { text: "Trigger Price: $–", callback_data: "trigger_price_buy" },
            { text: "Expire Time", callback_data: "expiry_buy" },
          ],
          [
            {
              text: "Amount: WETH",
              callback_data: "edit_amount_buy",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_buy" }],
        ],
      },
    });

    return;
  }

  if (state === "AWAITING_SLIPPAGE_INPUT_BUY") {
    const slippage = parseFloat(text);
    if (isNaN(slippage) || slippage <= 0 || slippage > 100) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid slippage. Please enter a % like 0.5"
      );
      return;
    }

    const order = pendingOrders.get(userId);
    if (!order) {
      await bot.sendMessage(chatId, "⚠️ No order in progress.");
      return;
    }

    order.slippage = slippage;
    pendingOrders.set(userId, order);
    userStates.delete(userId);
    const tokenLabel = order.tokenOut
      ? `🔘 Token: ${order.tokenOut.slice(0, 6)}...${order.tokenOut.slice(-4)}`
      : "🔘 Token To Buy";
    await bot.sendMessage(chatId, `✅ Slippage set to ${slippage}%`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tokenLabel,
              callback_data: "edit_token_buy",
            },
          ],
          [
            { text: "✅ Slippage: Auto", callback_data: "slippage_auto_buy" },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_buy",
            },
          ],
          [
            { text: "Trigger Price: $–", callback_data: "trigger_price_buy" },
            { text: "Expire Time", callback_data: "expiry_buy" },
          ],
          [
            {
              text: "Amount: WETH",
              callback_data: "edit_amount_buy",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_buy" }],
        ],
      },
    });
  }

  if (state === "AWAITING_SLIPPAGE_INPUT_SELL") {
    const slippage = parseFloat(text);
    if (isNaN(slippage) || slippage <= 0 || slippage > 100) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid slippage. Please enter a % like 0.5"
      );
      return;
    }

    const order = pendingOrders.get(userId);
    if (!order) {
      await bot.sendMessage(chatId, "⚠️ No order in progress.");
      return;
    }

    order.slippage = slippage;
    pendingOrders.set(userId, order);
    userStates.delete(userId);
    const tokenLabel = order.tokenIn
      ? `🔘 Token: ${order.tokenIn.slice(0, 6)}...${order.tokenIn.slice(-4)}`
      : "🔘 Token To Sell";
    await bot.sendMessage(chatId, `✅ Slippage set to ${slippage}%`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tokenLabel,
              callback_data: "edit_token_sell",
            },
          ],
          [
            {
              text: "✅ Slippage: Auto",
              callback_data: "slippage_auto_sell",
            },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_sell",
            },
          ],
          [
            {
              text: "Trigger Price: $–",
              callback_data: "trigger_price_sell",
            },
            { text: "Expire Time", callback_data: "expiry_sell" },
          ],
          [
            {
              text: "Amount: Token",
              callback_data: "edit_amount_sell",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_sell" }],
        ],
      },
    });
  }

  if (state === "AWAITING_TRIGGER_PRICE_INPUT_BUY") {
    const price = parseFloat(text);
    if (isNaN(price) || price <= 0) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid price. Please enter a valid number."
      );
      return;
    }

    const order = pendingOrders.get(userId);
    if (!order) {
      await bot.sendMessage(chatId, "⚠️ No order in progress.");
      return;
    }

    order.triggerPrice = price;
    pendingOrders.set(userId, order);
    userStates.delete(userId);
    const tokenLabel = order.tokenOut
      ? `🔘 Token: ${order.tokenOut.slice(0, 6)}...${order.tokenOut.slice(-4)}`
      : "🔘 Token To Buy";
    await bot.sendMessage(chatId, `✅ Trigger price set to $${price}`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tokenLabel,
              callback_data: "edit_token_buy",
            },
          ],
          [
            { text: "✅ Slippage: Auto", callback_data: "slippage_auto_buy" },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_buy",
            },
          ],
          [
            { text: "Trigger Price: $–", callback_data: "trigger_price_buy" },
            { text: "Expire Time", callback_data: "expiry_buy" },
          ],
          [
            {
              text: "Amount: WETH",
              callback_data: "edit_amount_buy",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_buy" }],
        ],
      },
    });
  }

  if (state === "AWAITING_TRIGGER_PRICE_INPUT_SELL") {
    const price = parseFloat(text);
    if (isNaN(price) || price <= 0) {
      await bot.sendMessage(
        chatId,
        "❌ Invalid price. Please enter a valid number."
      );
      return;
    }

    const order = pendingOrders.get(userId);
    if (!order) {
      await bot.sendMessage(chatId, "⚠️ No order in progress.");
      return;
    }

    order.triggerPrice = price;
    pendingOrders.set(userId, order);
    userStates.delete(userId);
    const tokenLabel = order.tokenIn
      ? `🔘 Token: ${order.tokenIn.slice(0, 6)}...${order.tokenIn.slice(-4)}`
      : "🔘 Token To Sell";
    await bot.sendMessage(chatId, `✅ Trigger price set to $${price}`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: tokenLabel,
              callback_data: "edit_token_sell",
            },
          ],
          [
            {
              text: "✅ Slippage: Auto",
              callback_data: "slippage_auto_sell",
            },
            {
              text: "Slippage: Custom %",
              callback_data: "slippage_custom_sell",
            },
          ],
          [
            {
              text: "Trigger Price: $–",
              callback_data: "trigger_price_sell",
            },
            { text: "Expire Time", callback_data: "expiry_sell" },
          ],
          [
            {
              text: "Amount: Token",
              callback_data: "edit_amount_sell",
            },
          ],
          [{ text: "🟣 Create Order", callback_data: "create_order_sell" }],
        ],
      },
    });
  }
});

const parseExpiry = (expiry: string): number => {
  const trimmed = expiry.trim().toLowerCase();

  if (trimmed === "never" || trimmed === "0") {
    return 0; // 0 means no expiry
  }

  const match = trimmed.match(/^(\d+)([dhm])$/);
  if (!match) {
    throw new Error("Invalid expiry format");
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  if (unit === "d") return value * 24 * 60 * 60;
  if (unit === "h") return value * 60 * 60;
  if (unit === "m") return value * 60;

  throw new Error("Unsupported time unit");
};

async function processOrdersLoop() {
  try {
    const activeOrders = await Order.find({ status: "ACTIVE" });

    for (const order of activeOrders) {
      try {
        const tokenToWatch =
          order.type === "BUY" ? order.tokenOut : order.tokenIn;
        const price = await getLivePrice(tokenToWatch);

        // Calculate slippage thresholds
        const slippageFactor = order.slippage / 100;
        let lowerLimit, upperLimit;

        if (order.type === "BUY") {
          upperLimit = order.triggerPrice! * (1 + slippageFactor);
          lowerLimit = order.triggerPrice!;
        } else if (order.type === "SELL") {
          lowerLimit = order.triggerPrice! * (1 - slippageFactor);
          upperLimit = order.triggerPrice!;
        }

        // Price check with slippage filter
        if (
          (order.type === "BUY" && price <= upperLimit!) ||
          (order.type === "SELL" && price >= lowerLimit!)
        ) {
          const user = order.wallet.address;
          const originCurrency = order.tokenIn;
          const destinationCurrency = order.tokenOut;
          const amount = order.amount;

          const quote = await getQuoteForSwap({
            user,
            originCurrency,
            destinationCurrency,
            amount,
          });

          const steps = quote.steps;
          const signer = await abstractChainService.getWallet(order.wallet);
          const signature = await abstractChainService.executeReservoirSwap(
            steps,
            signer
          );

          // Update order status to "FILLED"
          order.status = "FILLED";
          await order.save();

          await bot.sendMessage(
            order.userId,
            `🚀 *Order Executed Successfully!*\n\n` +
              `📄 *Order Details:*\n` +
              `• *Type:* \`${order.type}\`\n` +
              `• *Amount:* \`${order.amount}\`\n` +
              `• *Token:* \`${tokenToWatch}\`\n` +
              `• *Executed Price:* \`${price}\`\n` +
              `• *Allowed Slippage:* \`${order.slippage}%\`\n\n` +
              `🔗 *Transaction:* [View on AbScan](https://abscan.org/tx/${signature})\n\n` +
              `✅ _Your order has been filled successfully!_`,
            { parse_mode: "Markdown" }
          );
        }

        // Check expiry
        if (order.expiry !== null && Date.now() > order.expiry) {
          order.status = "CANCELLED";
          await order.save();

          await bot.sendMessage(
            order.userId,
            `⌛ Order expired and was cancelled.`
          );
        }
      } catch (err) {
        console.error("Error processing individual order:", err);
      }
    }
  } catch (err) {
    console.error("Error fetching active orders:", err);
  }

  // Delay before the next loop iteration
  setTimeout(processOrdersLoop, 5000); // 10 seconds
}

// Start the loop
processOrdersLoop();

async function getLivePrice(tokenAddress: string): Promise<number> {
  try {
    const options = { method: "GET" };

    const response = await fetch(
      `https://api.relay.link/currencies/token/price?address=${tokenAddress}&chainId=2741`,
      options
    );

    if (!response.ok) {
      throw new Error("Failed to fetch token price");
    }

    const data = await response.json();

    // Assuming the price is in the 'price' field in the response
    // Adjust this based on the actual response structure
    const price = data.price;

    return price;
  } catch (err) {
    console.error("Error fetching live price:", err);
    return 0; // or some default error value
  }
}

async function getQuoteForSwap({
  user,
  originCurrency,
  destinationCurrency,
  amount,
}: {
  user: string;
  originCurrency: string;
  destinationCurrency: string;
  amount: number;
}) {
  const formattedAmount = BigInt(amount).toString();
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: `{"useReceiver":true,"user":"${user}","originChainId":2741,"destinationChainId":2741,"originCurrency":"${originCurrency}","destinationCurrency":"${destinationCurrency}","amount":"${formattedAmount}","tradeType":"EXACT_INPUT"}`,
  };

  const response = await fetch("https://api.relay.link/quote", options);
  const json = await response.json();

  if (!response.ok) {
    console.error("Relay API error:", json);
    throw new Error("Relay API request failed");
  }

  return json;
}
