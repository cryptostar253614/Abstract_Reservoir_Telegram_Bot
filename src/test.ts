import { ethers } from "ethers";
import crypto from "crypto";
import { resolve } from "path";

const provider = new ethers.JsonRpcProvider("https://api.mainnet.abs.xyz");
const signer = new ethers.Wallet("", provider);

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

async function executeReservoirSwap(
  steps: ReservoirSwapStep[],
  signer: ethers.Signer
) {
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
        console.log(
          `📤 Sending ${step.id.toUpperCase()} tx to ${txData.to}...`
        );
        const txResponse = await signer.sendTransaction(tx);
        const receipt = await txResponse.wait();
        console.log(`✅ ${step.id} confirmed: ${receipt!.hash}`);
      } catch (err) {
        console.error(`❌ Failed on step ${step.id}:`, err);
        throw err; // You may want to handle or log it better
      }
    }
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
  amount: string;
}) {
  const options = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: `{"useReceiver":true,"user":"${user}","originChainId":2741,"destinationChainId":2741,"originCurrency":"${originCurrency}","destinationCurrency":"${destinationCurrency}","amount":"${amount}","tradeType":"EXACT_INPUT"}`,
  };

  const response = await fetch("https://api.relay.link/quote", options);
  const json = await response.json();

  if (!response.ok) {
    console.error("Relay API error:", json);
    throw new Error("Relay API request failed");
  }

  return json;
}

async function run() {
  const user = "0x9c0dC0a5C160cbb0F81243842fEC5c6b362Fbe70";
  const originCurrency = "0x4db861A72adca3Ca978B93E2a9E797db4836A08F";
  const destinationCurrency = "0x3439153EB7AF838Ad19d56E1571FBD09333C2809";
  const amount = BigInt(47896431999383092628693).toString();

  const quote = await getQuoteForSwap({
    user,
    originCurrency,
    destinationCurrency,
    amount,
  });

  const steps = quote.steps;
  await executeReservoirSwap(steps, signer);
}

run().catch((error: any) => {
  console.error("❌ An error occurred:", error);
});
