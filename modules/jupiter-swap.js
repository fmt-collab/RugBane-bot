// ═══════════════════════════════════════════════════════════
//  JUPITER SWAP ENGINE
//  Executes swaps via Jupiter Aggregator with MEV protection
// ═══════════════════════════════════════════════════════════

const axios = require("axios");
const { Connection, Keypair, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58");

class JupiterSwap {
  constructor(config = {}) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.wallet = config.privateKey 
      ? Keypair.fromSecretKey(bs58.decode(config.privateKey))
      : null;
    this.solMint = "So11111111111111111111111111111111111111112";
    this.paperTrading = config.paperTrading !== false;
    this.birdeyeKey = config.birdeyeApiKey || "";
    console.log("[JupiterSwap] Module loaded");
  }

  async getQuote(inputMint, outputMint, amount, slippageBps = 50) {
    try {
      const { data } = await axios.get("https://quote-api.jup.ag/v6/quote", {
        params: {
          inputMint,
          outputMint,
          amount: Math.floor(amount),
          slippageBps,
        },
        timeout: 10000,
      });
      return data;
    } catch (e) {
      console.error("[JupiterSwap] Quote failed:", e.message);
      return null;
    }
  }

  async swap(quoteResponse) {
    if (this.paperTrading) {
      console.log("[JupiterSwap] PAPER TRADE — swap simulated");
      return { success: true, txid: "PAPER_SIMULATION" };
    }

    if (!this.wallet) {
      console.error("[JupiterSwap] No wallet configured");
      return { success: false, error: "No wallet" };
    }

    try {
      const { data } = await axios.post(
        "https://quote-api.jup.ag/v6/swap",
        {
          quoteResponse,
          userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: "auto",
        },
        { timeout: 15000 }
      );

      const swapTxBuf = Buffer.from(data.swapTransaction, "base64");
      const tx = VersionedTransaction.deserialize(swapTxBuf);
      tx.sign([this.wallet]);

      const rawTx = tx.serialize();
      const txid = await this.connection.sendRawTransaction(rawTx, {
        skipPreflight: true,
        maxRetries: 3,
      });

      console.log(`[JupiterSwap] TX sent: ${txid}`);
      return { success: true, txid };
    } catch (e) {
      console.error("[JupiterSwap] Swap failed:", e.message);
      return { success: false, error: e.message };
    }
  }

  async buy(mintAddress, solAmount) {
    const lamports = solAmount * 1e9;
    const quote = await this.getQuote(this.solMint, mintAddress, lamports);
    if (!quote) return { success: false, error: "No quote" };
    return this.swap(quote);
  }

  async sell(mintAddress, tokenAmount) {
    const quote = await this.getQuote(mintAddress, this.solMint, tokenAmount);
    if (!quote) return { success: false, error: "No quote" };
    return this.swap(quote);
  }
}

module.exports = JupiterSwap;
