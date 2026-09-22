// ═══════════════════════════════════════════════════════════
//  RUGBANE — Solana Sniper Bot (fixed build)
//  Copy Trade | Signal Engine | Profit Lock | Rug Detection
//  FOMO Tracking | Sentiment Analysis
// ═══════════════════════════════════════════════════════════

require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Transaction,
  SystemProgram,
} = require("@solana/web3.js");
const bs58 = require("bs58");

// ── Modules (folder MUST be lowercase "modules" on Linux/Render) ──
const FomoTracker = require("./modules/fomo-tracker");
const FomoSignalEngine = require("./modules/fomo-signal-engine");
const RugCheck = require("./modules/rugcheck");
const HoneypotDetector = require("./modules/honeypot-detector");
const JupiterSwap = require("./modules/jupiter-swap"); // available for advanced routing
const RealtimeMonitor = require("./modules/realtime-monitor");
const ProfitLocker = require("./modules/profit-locker");
const WashTradeDetector = require("./modules/wash-trade-detector");
const SocialSentiment = require("./modules/social-sentiment");

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
const PAPER_TRADING = process.env.PAPER_TRADING === "true";
let paperMode = PAPER_TRADING;                       // live mutable flag
const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;
const COLD_WALLET = process.env.COLD_WALLET_ADDRESS;

// ── RPC (fixed: read HELIUS_RPC_URL, not HELIUS_API_KEY) ──
const RPC_URL =
  process.env.HELIUS_RPC_URL ||
  process.env.RPC_URL ||
  "https://api.mainnet-beta.solana.com";
const WS_URL = process.env.HELIUS_WS_URL || "";
const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;
const HELIUS_KEY = process.env.HELIUS_API_KEY || "";

// ── Telegram Bot Setup (ONE poller — started in boot) ──
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
if (!TOKEN || TOKEN.includes("YOUR_")) {
  console.error("[Fatal] TELEGRAM_BOT_TOKEN is missing in .env");
  process.exit(1);
}
const bot = new TelegramBot(TOKEN, { polling: false }); // NOT true — boot() starts it
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();

bot.on("polling_error", (e) => {
  // 409 here means ANOTHER process uses the same token
  console.error("[polling_error]", e.code, e.message);
});

// ── Solana Connection ──
const connection = new Connection(RPC_URL, "confirmed");

// ── Wallet ──
let wallet = null;
if (WALLET_PRIVATE_KEY && WALLET_PRIVATE_KEY !== "paste-generated-private-key-here") {
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
    console.log(`[Wallet] Loaded: ${wallet.publicKey.toBase58()}`);
  } catch (e) {
    console.error("[Wallet] Invalid private key:", e.message);
  }
}

// ── State ──
let solPriceUsd = 150;
let isRunning = true;

// ── Only the owner chat may use commands ──
function onCmd(regex, handler) {
  bot.onText(regex, (msg, match) => {
    if (CHAT_ID && String(msg.chat.id) !== String(CHAT_ID)) {
      return bot.sendMessage(msg.chat.id, "⛔ Unauthorized.").catch(() => {});
    }
    Promise.resolve(handler(msg, match)).catch((e) =>
      console.error("[Handler]", e.message)
    );
  });
}

// ═══════════════════════════════════════════════════════════
//  SOL PRICE TRACKER
// ═══════════════════════════════════════════════════════════

async function fetchSolPrice() {
  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { timeout: 5000 }
    );
    solPriceUsd = res.data.solana.usd;
    console.log(`[Price] SOL = $${solPriceUsd}`);
  } catch {
    try {
      const res = await axios.get(
        `https://public-api.birdeye.so/defi/v3/token/price?address=So11111111111111111111111111111111111111112`,
        { headers: { "X-API-KEY": BIRDEYE_KEY, "x-chain": "solana" }, timeout: 5000 }
      );
      solPriceUsd = res.data?.data?.price || solPriceUsd;
    } catch {
      console.log("[Price] Using cached SOL price");
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  WALLET BALANCE
// ═══════════════════════════════════════════════════════════

async function getSolBalance(address = null) {
  try {
    const pubkey = address ? new PublicKey(address) : wallet?.publicKey;
    if (!pubkey) return 0;
    const bal = await connection.getBalance(pubkey);
    return bal / LAMPORTS_PER_SOL;
  } catch (e) {
    console.error("[Balance] Error:", e.message);
    return 0;
  }
}

async function getTokenBalance(mintAddress) {
  try {
    if (!wallet) return 0;
    const resp = await axios.post(
      RPC_URL,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getTokenAccountsByOwner",
        params: [
          wallet.publicKey.toBase58(),
          { mint: new PublicKey(mintAddress) },
          { encoding: "jsonParsed" },
        ],
      },
      { timeout: 10000 }
    );
    const accounts = resp.data?.result?.value || [];
    if (accounts.length === 0) return 0;
    return accounts[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
  } catch {
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════
//  JUPITER SWAP EXECUTOR  (renamed: no clash with module)
// ═══════════════════════════════════════════════════════════

const SOL_MINT = "So11111111111111111111111111111111111111112";

async function executeSwap(inputMint, outputMint, amountLamports, slippageBps = 500) {
  if (paperMode) {
    console.log(`[Paper] Swap ${inputMint} → ${outputMint}`);
    return { success: true, signature: "PAPER_TRADE", amount: amountLamports / LAMPORTS_PER_SOL };
  }
  if (!wallet) return { success: false, error: "No wallet loaded" };

  try {
    const quoteRes = await axios.get("https://quote-api.jup.ag/v6/quote", {
      params: {
        inputMint,
        outputMint,
        amount: Math.floor(amountLamports).toString(),
        slippageBps,
        swapMode: "ExactIn",
      },
      timeout: 10000,
    });

    const swapRes = await axios.post(
      "https://quote-api.jup.ag/v6/swap",
      {
        quoteResponse: quoteRes.data,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      },
      { timeout: 15000 }
    );

    const swapTxBuf = Buffer.from(swapRes.data.swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(swapTxBuf);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`[Swap] Confirmed: ${sig}`);
    return { success: true, signature: sig };
  } catch (e) {
    console.error("[Swap] Failed:", e.message);
    return { success: false, error: e.message };
  }
}

async function buyToken(mint, solAmount) {
  const lamports = solAmount * LAMPORTS_PER_SOL;
  const result = await executeSwap(SOL_MINT, mint, lamports);
  if (result.success) console.log(`[Buy] ${solAmount} SOL → ${mint}`);
  return result;
}

async function sellToken(mint, percentage = 100) {
  const balance = await getTokenBalance(mint);
  if (balance <= 0) return { success: false, error: "No tokens to sell" };

  const amount = balance * (percentage / 100);
  const lamports = amount * 1e9; // assumes 9 decimals (Solana standard)

  const result = await executeSwap(mint, SOL_MINT, lamports);
  if (result.success) console.log(`[Sell] ${percentage}% of ${mint}`);
  return result;
}

async function transferSol(toAddress, solAmount) {
  if (paperMode) {
    console.log(`[Paper] Transfer ${solAmount} SOL → ${toAddress}`);
    return { success: true, signature: "PAPER_TRANSFER" };
  }
  if (!wallet) return { success: false, error: "No wallet" };

  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(toAddress),
        lamports: Math.floor(solAmount * LAMPORTS_PER_SOL),
      })
    );
    const sig = await connection.sendTransaction(tx, [wallet]);
    await connection.confirmTransaction(sig, "confirmed");
    return { success: true, signature: sig };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
//  TELEGRAM NOTIFICATION HELPER
// ═══════════════════════════════════════════════════════════

async function sendAlert(msg) {
  try {
    if (CHAT_ID) await bot.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch (e) {
    try {
      if (CHAT_ID) await bot.sendMessage(CHAT_ID, msg);
    } catch {
      console.error("[Alert] Failed:", e.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  INITIALIZE MODULES
// ═══════════════════════════════════════════════════════════

const fomoTracker = new FomoTracker({ telegramBot: bot, chatId: CHAT_ID });

const signalEngine = new FomoSignalEngine({
  rpcUrl: RPC_URL,
  birdeyeApiKey: BIRDEYE_KEY,
  privateKey: WALLET_PRIVATE_KEY,
  telegramBot: bot,
  chatId: CHAT_ID,
  paperTrading: paperMode,
});

const rugCheck = new RugCheck();
const honeypotDetector = new HoneypotDetector({ rpcUrl: RPC_URL }); // fixed: pass RPC_URL

const realtimeMonitor = new RealtimeMonitor({
  wsUrl: WS_URL,
  telegramBot: bot,
  chatId: CHAT_ID,
});

const profitLocker = new ProfitLocker({
  rpcUrl: RPC_URL,
  birdeyeApiKey: BIRDEYE_KEY,
  coldWalletAddress: COLD_WALLET,
  privateKey: WALLET_PRIVATE_KEY,
  telegramBot: bot,
  chatId: CHAT_ID,
  paperTrading: paperMode,
  solPriceUsd,
  sellToken,
  transferSol,
});

const washDetector = new WashTradeDetector({
  heliusApiKey: HELIUS_KEY,
  heliusRpcUrl: RPC_URL,
  birdeyeApiKey: BIRDEYE_KEY,
  telegramBot: bot,
  chatId: CHAT_ID,
});

const socialEngine = new SocialSentiment({ telegramBot: bot, chatId: CHAT_ID });

// ═══════════════════════════════════════════════════════════
//  OVERRIDE SIGNAL ENGINE TRADE EXECUTION
// ═══════════════════════════════════════════════════════════

signalEngine.executeBuy = async (mint, solAmount, symbol) => {
  const safety = await washDetector.inspectToken(mint, symbol);
  if (!safety.pass) {
    await sendAlert(
      `🚨 *BLOCKED* ${symbol}\n` +
        `Trust Score: ${safety.trustScore}/100\n` +
        safety.flags.map((f) => `• ${f}`).join("\n")
    );
    return { success: false, reason: "safety_check_failed" };
  }

  const result = await buyToken(mint, solAmount);
  if (result.success) {
    profitLocker.addPosition(mint, solAmount, 0, symbol);
    await sendAlert(
      `✅ *BOUGHT* ${symbol}\n` +
        `Amount: ${solAmount.toFixed(4)} SOL\n` +
        `Safety: ${safety.trustScore}/100\n` +
        `TX: \`${result.signature}\``
    );
  }
  return result;
};

signalEngine.executeSell = async (mint, percentage, symbol) => {
  const result = await sellToken(mint, percentage);
  if (result.success) {
    await sendAlert(`💰 *SOLD* ${symbol} (${percentage}%)\nTX: \`${result.signature}\``);
  }
  return result;
};

// ═══════════════════════════════════════════════════════════
//  TELEGRAM COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════

onCmd(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `🐻 *Welcome to RugBane!*\n\n` +
      `I watch smart wallets, detect rug risks, and auto-trade on Solana.\n\n` +
      `📋 *Quick Start:*\n` +
      `1. /status — bot health\n` +
      `2. /portfolio — your positions\n` +
      `3. /autocopy on — copy trading\n\n` +
      `💡 All commands: /help`,
    { parse_mode: "Markdown" }
  );
});

onCmd(/\/help/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `📋 *RugBane Commands*\n\n` +
      `*Main:* /status /portfolio /stats /lock\n` +
      `*Trading:* /autocopy on|off /signal <ticker> /buy <mint> <sol> /sell <mint> <pct>\n` +
      `*Safety:* /safety <mint> (rug) /trust <mint> (score) /honeypot <mint>\n` +
      `*FOMO:* /fomo trending /fomo leaderboard\n` +
      `*Sell Strategy:* /ladder | /ladder set 1.5:25 2:25 3:25 5:25 | /ladder reset\n` +
      `*Social:* /social <ticker> /socialon /socialoff /watch <ticker>\n` +
      `*Tracking:* /track <wallet> /untrack <wallet> /monitor\n` +
      `*Mode:* /paper on|off`,
    { parse_mode: "Markdown" }
  );
});

onCmd(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const bal = wallet ? await getSolBalance() : 0;
    const coldBal = COLD_WALLET ? await getSolBalance(COLD_WALLET) : 0;
    await bot.sendMessage(
      chatId,
      `🐻 *RugBane Status*\n\n` +
        `⏱ Uptime: ${formatUptime()}\n` +
        `💰 SOL Balance: ${bal.toFixed(4)} ($${(bal * solPriceUsd).toFixed(2)})\n` +
        `🏦 Cold Wallet: ${coldBal.toFixed(4)} SOL\n` +
        `💵 SOL Price: $${solPriceUsd.toFixed(2)}\n\n` +
        `📊 *Modules:* Signal ✅ FOMO ✅ Locker ✅ Wash ✅ Social ✅\n\n` +
        `🎰 Mode: ${paperMode ? "📝 PAPER TRADING" : "🔴 LIVE TRADING"}`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
  }
});

onCmd(/\/portfolio/, async (msg) => profitLocker.handleCommand("/portfolio", msg.chat.id));
onCmd(/\/stats/, async (msg) => profitLocker.handleCommand("/stats", msg.chat.id));
onCmd(/\/lock/, async (msg) => profitLocker.handleCommand("/lock", msg.chat.id));
onCmd(/\/ladder(.*)/, async (msg, match) =>
  profitLocker.handleCommand(`/ladder${match[1]}`, msg.chat.id)
);

onCmd(/\/signal (.+)/, async (msg, match) => {
  const ticker = match[1].toUpperCase();
  await bot.sendMessage(msg.chat.id, `🔍 Analyzing ${ticker}...`);
  try {
    const result = await signalEngine.analyzeToken(ticker);
    await bot.sendMessage(msg.chat.id, result, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

// ── /safety — rug report (rugCheck module) ──
onCmd(/\/safety (.+)/, async (msg, match) => {
  const mint = match[1].trim();
  await bot.sendMessage(msg.chat.id, `🔍 Scanning ${mint}...`);
  try {
    const report = await rugCheck.inspect(mint);
    await bot.sendMessage(msg.chat.id, rugCheck.formatReport(report));
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

// ── /trust — wash/insider trust score (washDetector module) ──
onCmd(/\/trust (.+)/, async (msg, match) => {
  const mint = match[1].trim();
  await bot.sendMessage(msg.chat.id, `🛡 Running safety check...`);
  try {
    const result = await washDetector.inspectToken(mint, "?");
    await bot.sendMessage(
      msg.chat.id,
      `${result.pass ? "🟢" : "🔴"} *Safety Report*\n\n` +
        `Trust Score: *${result.trustScore}/100*\n` +
        `Pass: ${result.pass ? "YES" : "NO"}\n\n` +
        (result.flags.length
          ? `⚠️ *Flags:*\n${result.flags.map((f) => `• ${f}`).join("\n")}`
          : `✅ No flags detected`),
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

onCmd(/\/honeypot (.+)/, async (msg, match) => {
  const mint = match[1].trim();
  await bot.sendMessage(msg.chat.id, `🍯 Scanning for honeypot...`);
  const report = await honeypotDetector.analyze(mint);
  await bot.sendMessage(msg.chat.id, honeypotDetector.formatReport(report));
});

// ── /buy — uses built-in helper (was broken: jupiterSwap.buy) ──
onCmd(/\/buy (.+)/, async (msg, match) => {
  const [mint, amount] = match[1].split(/\s+/);
  const sol = parseFloat(amount) || 0.05;
  await bot.sendMessage(msg.chat.id, `🛒 Buying ${sol} SOL of ${mint.slice(0, 8)}...`);
  const result = await buyToken(mint, sol);
  await bot.sendMessage(
    msg.chat.id,
    result.success ? `✅ Sent! TX: ${result.signature}` : `❌ Failed: ${result.error}`
  );
});

// ── /sell — uses built-in helper (was broken: jupiterSwap.sell) ──
onCmd(/\/sell (.+)/, async (msg, match) => {
  const [mint, amount] = match[1].split(/\s+/);
  const pct = parseInt(amount) || 100;
  await bot.sendMessage(msg.chat.id, `💰 Selling ${pct}% of ${mint.slice(0, 8)}...`);
  const result = await sellToken(mint, pct);
  await bot.sendMessage(
    msg.chat.id,
    result.success ? `✅ Sold! TX: ${result.signature}` : `❌ Failed: ${result.error}`
  );
});

onCmd(/\/track (.+)/, async (msg, match) => {
  const w = match[1].trim();
  realtimeMonitor.trackWallet(w, `Manual-${w.slice(0, 4)}`);
  await bot.sendMessage(msg.chat.id, `👁️ Now tracking: ${w.slice(0, 8)}...`);
});

onCmd(/\/untrack (.+)/, async (msg, match) => {
  const w = match[1].trim();
  realtimeMonitor.untrackWallet(w);
  await bot.sendMessage(msg.chat.id, `🚫 Stopped tracking: ${w.slice(0, 8)}...`);
});

onCmd(/\/monitor/, async (msg) => {
  const status = realtimeMonitor.getStatus();
  await bot.sendMessage(
    msg.chat.id,
    `📡 MONITOR STATUS\n━━━━━━━━━━━━━━━━━\n` +
      `Connected: ${status.connected ? "✅" : "❌"}\n` +
      `Tracking: ${status.tracking} wallets\n` +
      status.wallets.map((w) => `• ${w}`).join("\n")
  );
});

onCmd(/\/autocopy (.+)/, async (msg, match) => {
  const action = match[1].toLowerCase();
  if (action === "on") {
    signalEngine.autoCopyEnabled = true;
    await bot.sendMessage(msg.chat.id, `✅ Auto-copy *enabled*.`, { parse_mode: "Markdown" });
  } else if (action === "off") {
    signalEngine.autoCopyEnabled = false;
    await bot.sendMessage(msg.chat.id, `⛔ Auto-copy *disabled*.`, { parse_mode: "Markdown" });
  }
});

onCmd(/\/fomo trending/, async (msg) => fomoTracker.handleCommand("/fomo trending", msg.chat.id));
onCmd(/\/fomo leaderboard/, async (msg) =>
  fomoTracker.handleCommand("/fomo leaderboard", msg.chat.id)
);

onCmd(/\/social (.+)/, async (msg, match) => {
  const ticker = match[1].toUpperCase();
  await bot.sendMessage(msg.chat.id, `🐦 Fetching sentiment for ${ticker}...`);
  try {
    const result = await socialEngine.getSentimentReport(ticker);
    await bot.sendMessage(msg.chat.id, result, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
  }
});

onCmd(/\/socialon/, async (msg) => {
  socialEngine.enabled = true;
  await bot.sendMessage(msg.chat.id, "✅ Sentiment analysis *enabled*.", { parse_mode: "Markdown" });
});

onCmd(/\/socialoff/, async (msg) => {
  socialEngine.enabled = false;
  await bot.sendMessage(msg.chat.id, "⛔ Sentiment analysis *disabled*.", { parse_mode: "Markdown" });
});

onCmd(/\/watch (.+)/, async (msg, match) => {
  const ticker = match[1].toUpperCase();
  socialEngine.config.watchlist.set(ticker, { alertThreshold: 0.5, created: Date.now() });
  await bot.sendMessage(msg.chat.id, `👀 Now watching *${ticker}* for breakouts.`, {
    parse_mode: "Markdown",
  });
});

// ── /paper on/off — now changes the real flag ──
onCmd(/\/paper (.+)/, async (msg, match) => {
  const action = match[1].toLowerCase();
  if (action === "on") {
    paperMode = true;
    profitLocker.paperTrading = true;
    signalEngine.paperTrading = true;
    await bot.sendMessage(msg.chat.id, "📝 *Paper Trading Mode ON*", { parse_mode: "Markdown" });
  } else {
    paperMode = false;
    profitLocker.paperTrading = false;
    signalEngine.paperTrading = false;
    await bot.sendMessage(msg.chat.id, "🔴 *LIVE Trading Mode ON*\n⚠️ Real SOL at risk!", {
      parse_mode: "Markdown",
    });
  }
});

// ═══════════════════════════════════════════════════════════
//  BACKGROUND JOBS
// ═══════════════════════════════════════════════════════════

function formatUptime() {
  const hours = Math.floor(process.uptime() / 3600);
  const mins = Math.floor((process.uptime() % 3600) / 60);
  return `${hours}h ${mins}m`;
}

setInterval(fetchSolPrice, 5 * 60 * 1000);

setInterval(async () => {
  if (!isRunning) return;
  try { await signalEngine.scan(); } catch (e) { console.error("[Scan]", e.message); }
}, 2 * 60 * 1000);

setInterval(async () => {
  if (!isRunning) return;
  try { await fomoTracker.checkLeaderboard(); } catch (e) { console.error("[FOMO]", e.message); }
}, 3 * 60 * 1000);

setInterval(async () => {
  if (!isRunning || !socialEngine.enabled) return;
  try { await socialEngine.checkWatchlist(); } catch (e) { console.error("[Social]", e.message); }
}, 2 * 60 * 1000);

// ═══════════════════════════════════════════════════════════
//  EXPRESS SERVER
// ═══════════════════════════════════════════════════════════

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "running", bot: "RugBane", uptime: formatUptime(), paperTrading: paperMode });
});

// Telegram webhook endpoint (used only in webhook mode)
app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.post("/api/signal", async (req, res) => {
  const { mint, confidence } = req.body;
  if (mint && confidence > 70) await sendAlert(`📡 External signal: ${mint} (score: ${confidence})`);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════

async function boot() {
  console.log("═══════════════════════════════════════════");
  console.log("  🐻 RUGBANE — Solana Sniper Bot");
  console.log("═══════════════════════════════════════════");

  await fetchSolPrice();

  // ── Pick EXACTLY ONE Telegram mode ──
  const webhookUrl = (process.env.WEBHOOK_URL || "").trim();
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
  } catch {}

  if (webhookUrl) {
    const url = `${webhookUrl.replace(/\/$/, "")}/webhook/${TOKEN}`;
    await bot.setWebHook(url);
    console.log(`[Telegram] Webhook mode: ${url}`);
  } else {
    await bot.startPolling(); // the ONLY polling call in the whole project
    console.log("[Telegram] Polling mode (single instance)");
  }

  app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));

  await sendAlert(
    `🐻 *RugBane is LIVE!*\n\n` +
      `Mode: ${paperMode ? "📝 Paper Trading" : "🔴 Live Trading"}\n` +
      `SOL Price: $${solPriceUsd}\n` +
      `Wallet: ${wallet ? wallet.publicKey.toBase58() : "Not loaded"}`
  );

  console.log("[Boot] All systems go! 🚀");
}

boot().catch((e) => {
  console.error("[Fatal]", e);
  process.exit(1);
});
