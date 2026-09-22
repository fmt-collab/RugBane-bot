// ═══════════════════════════════════════════════════════════
//  FOMO UNIFIED SIGNAL ENGINE
//  Birdeye + FOMO cross-reference → Confidence Score → Auto-Copy
// ═══════════════════════════════════════════════════════════

const axios = require("axios");
const fs = require("fs");
const path = require("path");

class FomoSignalEngine {
  constructor(config = {}) {
    // ── Connections ──
    this.rpcUrl = config.rpcUrl;
    this.birdeyeKey = config.birdeyeApiKey;
    this.heliusKey = config.heliusApiKey || "";
    this.telegramBot = config.telegramBot;
    this.chatId = config.chatId;

    // ── Config ──
    this.paperTrading = config.paperTrading !== false;
    this.maxTradeSizeSol = config.maxTradeSizeSol || 0.05;
    this.autoCopyEnabled = false;

    // ── Thresholds ──
    this.thresholds = {
      minConfidenceBuy: 65,
      minConfidenceWatch: 45,
      birdeyeMinVolumeUsd: 5000,
      birdeyeMinLiquidityUsd: 5000,
      fomoLeaderboardRank: 10,
      fomoMinTradeUsd: 500,
      maxConcurrentPositions: 5,
    };

    // ── State ──
    this.birdeyeTrending = [];
    this.fomoTraderBuys = [];
    this.unifiedSignals = new Map();  // mint -> { confidence, sources, time }
    this.positions = new Map();       // mint -> { entry, size, time }
    this.rugCache = new Map();

    // ── Injected from index.js ──
    this.executeBuy = config.executeBuy || this.defaultExecuteBuy.bind(this);
    this.executeSell = config.executeSell || this.defaultExecuteSell.bind(this);
  }

  // ══════════════════════════════════════════════════════
  //  1. BIRDEYE TRENDING
  // ══════════════════════════════════════════════════════

  async fetchBirdeyeTrending() {
    try {
      const res = await axios.get(
        "https://public-api.birdeye.so/defi/v3/token/trending",
        {
          headers: {
            "X-API-KEY": this.birdeyeKey,
            "x-chain": "solana",
          },
          params: {
            sort_by: "volume_24h_usd",
            sort_type: "desc",
            offset: 0,
            limit: 20,
          },
          timeout: 10000,
        }
      );

      const tokens = res.data?.data?.tokens || [];
      
      // Filter for quality
      this.birdeyeTrending = tokens.filter(
        (t) =>
          (t.volume_24h_usd || 0) >= this.thresholds.birdeyeMinVolumeUsd &&
          (t.liquidity || 0) >= this.thresholds.birdeyeMinLiquidityUsd
      );

      console.log(`[Signal] Birdeye: ${this.birdeyeTrending.length} quality tokens`);
      return this.birdeyeTrending;
    } catch (e) {
      console.error("[Signal] Birdeye failed:", e.message);
      return [];
    }
  }

  // ══════════════════════════════════════════════════════
  //  2. FOMO LEADERBOARD TRADER ACTIVITY
  // ══════════════════════════════════════════════════════

  async fetchFomoTraderActivity() {
    try {
      const leaderboardRes = await axios.get(
        "https://api.fomoapi.io/v2/leaderboard/24H",
        {
          params: { limit: this.thresholds.fomoLeaderboardRank },
          timeout: 10000,
        }
      );

      const traders = leaderboardRes.data?.data || leaderboardRes.data || [];
      const traderWallets = traders.map((t) => t.wallet || t.address).filter(Boolean);

      // Fetch recent buys from top traders
      const buyPromises = traderWallets.slice(0, 5).map(async (wallet) => {
        try {
          const txRes = await axios.get(
            `https://api.fomoapi.io/v2/trader/${wallet}/trades`,
            {
              params: { limit: 5, type: "buy" },
              timeout: 8000,
            }
          );
          return (txRes.data?.data || []).map((tx) => ({
            ...tx,
            traderRank: traders.findIndex((t) => (t.wallet || t.address) === wallet) + 1,
          }));
        } catch {
          return [];
        }
      });

      const results = await Promise.allSettled(buyPromises);
      this.fomoTraderBuys = results
        .filter((r) => r.status === "fulfilled")
        .flatMap((r) => r.value)
        .filter((tx) => tx.mint || tx.tokenAddress);

      console.log(`[Signal] FOMO: ${this.fomoTraderBuys.length} recent buys from top traders`);
      return this.fomoTraderBuys;
    } catch (e) {
      console.error("[Signal] FOMO activity failed:", e.message);
      return [];
    }
  }

  // ══════════════════════════════════════════════════════
  //  3. UNIFIED SCORING ENGINE
  // ══════════════════════════════════════════════════════

  scoreToken(mint) {
    const score = {
      mint,
      total: 0,
      breakdown: {},
      sources: [],
      action: "ignore",  // buy | watch | ignore
      timestamp: Date.now(),
    };

    // ── Birdeye signals ──
    const birdeye = this.birdeyeTrending.find(
      (t) => t.address === mint || t.mint === mint
    );

    if (birdeye) {
      score.sources.push("birdeye");
      
      // Volume score (0-15)
      const vol = birdeye.volume_24h_usd || 0;
      score.breakdown.birdeyeVolume = Math.min(15, Math.floor(vol / 7000));

      // Liquidity score (0-10)
      const liq = birdeye.liquidity || 0;
      score.breakdown.birdeyeLiquidity = Math.min(10, Math.floor(liq / 10000));

      // Momentum score (0-15) — price change
      const priceChange = birdeye.priceChange24h || birdeye.price_change_24h || 0;
      if (priceChange > 0) {
        score.breakdown.birdeyeMomentum = Math.min(15, Math.floor(priceChange / 2));
      }
    }

    // ── FOMO signals ──
    const fomoBuys = this.fomoTraderBuys.filter(
      (tx) => (tx.mint || tx.tokenAddress) === mint
    );

    if (fomoBuys.length > 0) {
      score.sources.push("fomo");

      // Unique traders (0-15)
      const uniqueTraders = new Set(fomoBuys.map((tx) => tx.traderRank || tx.wallet));
      score.breakdown.fomoTraders = Math.min(15, uniqueTraders.size * 5);

      // Buy size (0-15)
      const totalBuyUsd = fomoBuys.reduce((sum, tx) => sum + (tx.usdAmount || tx.amountUsd || 0), 0);
      score.breakdown.fomoBuySize = Math.min(15, Math.floor(totalBuyUsd / 700));
    }

    // ── Cross-signal bonus ──
    if (score.sources.length >= 2) {
      score.breakdown.crossSignal = 20;
      score.sources.push("cross");
    }

    // ── Calculate total ──
    score.total = Object.values(score.breakdown).reduce((sum, v) => sum + v, 0);

    // ── Action ──
    if (score.total >= this.thresholds.minConfidenceBuy) {
      score.action = "buy";
    } else if (score.total >= this.thresholds.minConfidenceWatch) {
      score.action = "watch";
    }

    // Cache it
    this.unifiedSignals.set(mint, score);
    return score;
  }

  // ══════════════════════════════════════════════════════
  //  4. AUTO-COPY LOGIC
  // ══════════════════════════════════════════════════════

  async runScanCycle() {
    console.log("[Signal] Starting scan cycle...");

    // Fetch data from both sources
    await Promise.allSettled([
      this.fetchBirdeyeTrending(),
      this.fetchFomoTraderActivity(),
    ]);

    // Score all unique mints
    const allMints = new Set();

    for (const t of this.birdeyeTrending) {
      allMints.add(t.address || t.mint);
    }
    for (const tx of this.fomoTraderBuys) {
      allMints.add(tx.mint || tx.tokenAddress);
    }

    const signals = [];
    for (const mint of allMints) {
      if (!mint) continue;
      const sig = this.scoreToken(mint);
      if (sig.total > 0) signals.push(sig);
    }

    // Sort by confidence
    signals.sort((a, b) => b.total - a.total);

    // Auto-buy top signals
    if (this.autoCopyEnabled) {
      for (const sig of signals) {
        if (sig.action === "buy" && !this.positions.has(sig.mint)) {
          if (this.positions.size >= this.thresholds.maxConcurrentPositions) {
            console.log("[Signal] Max positions reached, skipping");
            break;
          }
          console.log(`[Signal] AUTO-BUY triggered: ${sig.mint} (score: ${sig.total})`);
          await this.executeBuy(sig.mint, this.maxTradeSizeSol, sig);
        }
      }
    }

    // Send summary to Telegram
    await this.sendSignalSummary(signals.slice(0, 5));

    console.log(`[Signal] Scan complete. ${signals.length} tokens scored.`);
    return signals;
  }

  // ══════════════════════════════════════════════════════
  //  5. TELEGRAM COMMANDS
  // ══════════════════════════════════════════════════════

  registerHandlers(bot) {
    // /signal <ticker> — Manual analysis
    bot.onText(/\/signal (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const query = match[1].trim().toUpperCase();

      await bot.sendMessage(chatId, `🔍 Analyzing ${query}...`);

      // Search Birdeye for the token
      try {
        const res = await axios.get(
          "https://public-api.birdeye.so/defi/v3/token/search",
          {
            headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana" },
            params: { keyword: query, limit: 1 },
            timeout: 10000,
          }
        );

        const token = res.data?.data?.tokens?.[0];
        if (!token) {
          await bot.sendMessage(chatId, `❌ Token "${query}" not found`);
          return;
        }

        const sig = this.scoreToken(token.address);

        const text = [
          `📊 Signal Report: ${query}`,
          `━━━━━━━━━━━━━━━━━━━`,
          `Mint: \`${token.address}\``,
          `Price: $${token.price || "?"}`,
          ``,
          `🎯 Confidence: ${sig.total}/100`,
          `📈 Action: ${sig.action.toUpperCase()}`,
          ``,
          `**Score Breakdown:**`,
          ...Object.entries(sig.breakdown).map(([k, v]) => `• ${k}: ${v}`),
          ``,
          `Sources: ${sig.sources.join(", ") || "none"}`,
        ].join("\n");

        await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
      } catch (e) {
        await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
      }
    });

    // /autocopy on|off
    bot.onText(/\/autocopy (on|off)/, (msg, match) => {
      const chatId = msg.chat.id;
      this.autoCopyEnabled = match[1] === "on";

      bot.sendMessage(
        chatId,
        this.autoCopyEnabled
          ? "🟢 Auto-copy ENABLED — will buy tokens with 65+ score"
          : "🔴 Auto-copy DISABLED — manual trades only"
      );
    });

    // /signals — Show current top signals
    bot.onText(/\/signals/, async (msg) => {
      const chatId = msg.chat.id;
      const signals = Array.from(this.unifiedSignals.values())
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

      if (signals.length === 0) {
        await bot.sendMessage(chatId, "No signals yet. Run /scan to analyze.");
        return;
      }

      const text = [
        `📊 Top Signals (${signals.length})`,
        `━━━━━━━━━━━━━━━━━━━`,
        ...signals.map((s, i) =>
          `${i + 1}. Score: ${s.total} | ${s.action.toUpperCase()} | ${s.mint.slice(0, 8)}...`
        ),
      ].join("\n");

      await bot.sendMessage(chatId, text);
    });

    // /scan — Manual scan trigger
    bot.onText(/\/scan/, async (msg) => {
      const chatId = msg.chat.id;
      await bot.sendMessage(chatId, "🔄 Running signal scan...");
      const signals = await this.runScanCycle();
      await bot.sendMessage(chatId, `✅ Scan complete. ${signals.length} tokens scored.`);
    });
  }

  // ══════════════════════════════════════════════════════
  //  6. SEND SUMMARY
  // ══════════════════════════════════════════════════════

  async sendSignalSummary(signals) {
    if (!this.telegramBot || !this.chatId || signals.length === 0) return;

    const text = [
      `🚨 **New Signal Alert**`,
      `━━━━━━━━━━━━━━━━━━━`,
      ...signals.map((s, i) => {
        const emoji = s.action === "buy" ? "🟢" : s.action === "watch" ? "👀" : "⚪";
        return `${emoji} ${i + 1}. Score: **${s.total}** | ${s.mint.slice(0, 8)}... | ${s.action.toUpperCase()}`;
      }),
    ].join("\n");

    try {
      await this.telegramBot.sendMessage(this.chatId, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("[Signal] Telegram send failed:", e.message);
    }
  }

  // ══════════════════════════════════════════════════════
  //  7. DEFAULT EXECUTE (override from index.js)
  // ══════════════════════════════════════════════════════

  async defaultExecuteBuy(mint, amountSol, signal) {
    console.log(`[Signal] Would buy ${mint} for ${amountSol} SOL (confidence: ${signal.total})`);
    console.log(`[Signal] Set executeBuy() in index.js to enable real trading`);
  }

  async defaultExecuteSell(mint, amount, reason) {
    console.log(`[Signal] Would sell ${mint} — ${reason}`);
    console.log(`[Signal] Set executeSell() in index.js to enable real trading`);
  }
}

module.exports = FomoSignalEngine;
