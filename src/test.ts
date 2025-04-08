import { ethers } from "ethers";
import crypto from "crypto";

// Connect to Ethereum mainnet via a public RPC (or your own provider)
const provider = new ethers.JsonRpcProvider(
  "https://mainnet.infura.io/v3/YOUR_INFURA_KEY"
);

// Wallet address
const address = "0x3fB8Aa3752dc84ECD5639C9ADA3a238FABaF12D0";

// Get balance in Wei and format to ETH
async function getBalance() {
  decrypt(
    "8621aa6dfafe09f2930cb8b5735aa924:f89cfd5c64ef79769491578f4e5c060fa8bb6ef633b085ceb205145f022e8cfc883c5428a57945e608bbe39803a60147e6200ab0a76c11bb005de5cf211ff3df0bdcafcf4f44542db0037531b37e92e1"
  );
}

function decrypt(encryptedText: string): string {
  const algorithm = "aes-256-cbc";
  let key: Buffer;
  key = crypto.scryptSync("1234567890", "salt", 32);
  const [ivHex, encrypted] = encryptedText.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  console.log(decrypted);
  return decrypted;
}

getBalance();
