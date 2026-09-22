// ═══════════════════════════════════════════════════════════
//  WASH TRADE DETECTOR + INSIDER CLUSTER ANALYZER
//  RugBane Bot Safety Module — v1.0
//  Detects wash trading, circular transfers, insider clusters
// ═══════════════════════════════════════════════════════════

const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ── Graph / Cluster data structures ──
const GRAPH_STATE_PATH = path.join(__dirname, "..", "data", "wallet-graph.json");

class WashTradeDetector {
  constructor(config = {}) {
    this.heliusApiKey = config.heliusApiKey;
    this.heliusRpcUrl = config.heliusRpcUrl;
    this.birdeyeKey = config.birdeyeApiKey;
    this.telegramBot = config.telegramBot;
    this.chatId = config.chatId;

    // ── Thresholds ──
    this.thresholds = {
      minTrustScore: 70,          // Below 70 = block the trade
      washVolumeRatio: 0.30,      // >30% circular volume = suspected wash
      minCircularLoop: 3,         // A→B→C→A minimum length
      timeWindowMs: 5 * 60 * 1000, // 5-min coordination window
      clusterAlertThreshold: 3,   // 3+ wallets acting together
      maxHoldersToAnalyze: 500,   // holder count cap for analysis
      cachedResultTtlMs: 10 * 60 * 1000, // Cache 10 minutes
      suspiciousClusterScore: 60, // 60+ = dangerous cluster
    };

    // ── State ──
    this.signatureCache = new Map(); // txSig -> parsed tx
    this.tokenSafetyCache = new Map(); // mint -> { trustScore, flags, at }
    this.clusterCache = new Map(); // wallet -> clusterId
    this.clusterMap = new Map(); // clusterId -> { wallets, score, tokens }
    this.fundingGraph = new Map(); // wallet -> { fundedBy, fundedWallets }
    this.coordinatedSellHistory = new Map(); // mint -> [wallet+time]
    this.washTradeMemory = new Map(); // mint -> { circulationPct, selfTrades, }
    this.knownDevWallets = new Map(); // mint -> devWallet

    // ── Alert deduplication ──
    this.alertHistory = new Map(); // key -> timestamp

    this.loadGraphState();
    console.log("[WashDetect] Module initialized");
  }

  // ══════════════════════════════════════════════════════
  //  1. PUBLIC API — Main entry point
  //  Call before any buy. Returns { pass, trustScore, flags, clusterInfo }
  // ══════════════════════════════════════════════════════
  async inspectToken(mint, tokenSymbol = "?") {
    // Check cache first
    const cached = this.tokenSafetyCache.get(mint);
    if (cached && Date.now() - cached.at < this.thresholds.cachedResultTtlMs) {
      return { ...cached, cached: true };
    }

    const result = {
      mint,
      pass: false,
      trustScore: 100,
      flags: [],
      clusterInfo: null,
      metrics: {},
      devWallet: null,
    };

    try {
      // ── Run all checks in parallel where possible ──
      const [topHolders, volumeData, priceInfo, txHistory] = await Promise.all([
        this.fetchTopHolders(mint).catch(() => []),
        this.fetchVolumeProfile(mint).catch(() => null),
        this.fetchPriceInfo(mint).catch(() => null),
        this.fetchRecentTransactions(mint).catch(() => []),
      ]);

      // 1. Holder concentration
      const holderScore = this.analyzeHolderConcentration(topHolders);
      result.trustScore -= holderScore.deduction;
      if (holderScore.deduction > 10) {
        result.flags.push(`🐋 Top holder owns ${holderScore.topHolderPct.toFixed(1)}% (${holderScore.flag})`);
      }

      // 2. Wash trading detection (circular transfers)
      const washScore = await this.detectWashTrading(mint, txHistory);
      result.trustScore -= washScore.deduction;
      if (washScore.deduction > 10) {
        result.flags.push(`🌀 Wash trading suspected: ${washScore.reason}\n   • Circular volume: ${washScore.circularPct?.toFixed(1)}%` +
          (washScore.selfTrades ? `\n   • Self-trades detected: ${washScore.selfTrades}` : "") +
          (washScore.lpManipulation ? "\n   • LP manipulation detected" : ""));
      }

      // 3. Volume authenticity
      const volumeScore = this.analyzeVolume(volumeData, priceInfo, topHolders);
      result.trustScore -= volumeScore.deduction;
      if (volumeScore.deduction > 10) {
        result.flags.push(`📊 Volume anomaly: ${volumeScore.reason}`);
      }

      // 4. Cluster analysis + dev wallet linkage
      const clusterResult = await this.analyzeCluster(mint, topHolders);
      result.trustScore -= (clusterResult.dangerScore || 0);
      result.clusterInfo = clusterResult;
      if (clusterResult.dangerScore > 10) {
        result.flags.push(
          `🚨 Insider cluster detected (danger ${clusterResult.dangerScore}/100):\n   • ${clusterResult.details?.join("\n   • ")}`
        );
      }

      // 5. Store the result (capped to 0-100)
      result.trustScore = Math.max(0, Math.min(100, result.trustScore));
      result.pass = result.trustScore >= this.thresholds.minTrustScore;

      // Save to cache
      this.tokenSafetyCache.set(mint, { ...result, at: Date.now() });
      this.saveGraphState();

      return result;
    } catch (err) {
      console.error(`[WashDetect] Error inspecting ${mint}:`, err.message);
      // On error, FAIL CLOSED unless no API keys configured
      if (!this.heliusApiKey && !this.birdeyeKey) {
        result.flags.push("⚠️ No API keys — skipping safety analysis");
        result.pass = true;
        result.trustScore = 50;
      } else {
        result.flags.push("🔧 Analysis failed — blocked for safety");
      }
      return result;
    }
  }

  // Quick check helper for devs — can be used as a guard:
  async ensureSafe(mint) {
    const res = await this.inspectToken(mint);
    if (!res.pass) {
      if (this.telegramBot) {
        await this.sendAlert(
          `🛑 **Wash/cluster guard blocked buy**\n` +
          `Token: \`${res.mint.slice(0, 8)}...\`\n` +
          `Trust score: ${res.trustScore}/100\n` +
          res.flags.join("\n")
        );
      }
    }
    return res;
  }

  // ══════════════════════════════════════════════════════
  //  2. TOP HOLDERS + HOLDER CONCENTRATION
  // ══════════════════════════════════════════════════════
  async fetchTopHolders(mint) {
    // Use Helius getTokenAccounts or Birdeye holder endpoint
    const res = await axios.get(
      `https://public-api.birdeye.so/defi/v3/token/holders`,
      {
        headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana" },
        params: { address: mint, limit: 50 },
        timeout: 12000,
      }
    );
    const holders = res.data?.data?.holders || [];
    return holders.map((h) => ({
      wallet: h.owner,
      pct: h.percentage || 0,
      amount: h.amount || 0,
    }));
  }

  analyzeHolderConcentration(topHolders) {
    let deduction = 0;
    let topHolderPct = 0;
    let flag = "";

    if (!topHolders.length) return { deduction: 0, topHolderPct: 0, flag: "no data" };

    // Top holder concentration
    topHolderPct = topHolders[0]?.pct || 0;
    if (topHolderPct > 40) {
      deduction += 25;
      flag = "dev wallet rug risk";
    } else if (topHolderPct > 25) {
      deduction += 15;
      flag = "high concentration";
    } else if (topHolderPct > 10) {
      deduction += 5;
      flag = "moderate concentration";
    }

    // Top 3 holders total
    const top3Pct = topHolders.slice(0, 3).reduce((a, b) => a + (b.pct || 0), 0);
    if (top3Pct > 60) deduction += 10;

    return { deduction, topHolderPct, flag };
  }

  // ══════════════════════════════════════════════════════
  //  3. WASH TRADING DETECTION (circular + self-trades)
  // ══════════════════════════════════════════════════════
  async fetchRecentTransactions(mint, limit = 200) {
    try {
      // Use Helius enhanced transactions endpoint (free tier)
      const res = await axios.get(
        `https://api.helius.xyz/v0/addresses/${mint}/transactions`,
        {
          params: {
            apiKey: this.heliusApiKey,
            limit,
            before: "",
          },
          timeout: 12000,
        }
      );
      // Normalize
      return (res.data || []).map((tx) => ({
        sig: tx.signature,
        type: tx.type || "UNKNOWN",
        timestamp: tx.timestamp * 1000,
        fee: tx.fee || 0,
        accountData: tx.accountData || [],
        tokenTransfers: tx.tokenTransfers || [],
        description: tx.description || "",
        source: tx.source || "unknown",
        isSwap: tx.type === "SWAP",
      }));
    } catch (e) {
      // Fallback: Birdeye trade history
      try {
        const res = await axios.get(
          `https://public-api.birdeye.so/defi/v3/token/trades`,
          {
            headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana" },
            params: { address: mint, limit },
            timeout: 12000,
          }
        );
        return (res.data?.data?.trades || []).map((t) => ({
          sig: t.txHash,
          type: "SWAP",
          timestamp: t.unixTime * 1000,
          fee: 0,
          fromWallet: t.trader,
          toWallet: t.trader,
          amount: t.tokenAmount,
          side: t.side, // "buy" | "sell"
          price: t.price,
        }));
      } catch (err) {
        return [];
      }
    }
  }

  async detectWashTrading(mint, txs) {
    let deduction = 0;
    const flags = [];
    const circularPct = 0;
    let selfTrades = 0;
    let lpManipulation = false;

    if (!txs || txs.length < 5) return { deduction: 0, circularPct: 0, reason: "" };

    // ── Build wallet trade graph ──
    const graph = new Map(); // wallet -> Map<wallet, count>
    const walletVolume = new Map(); // wallet -> total SOL volume
    const walletBuySell = new Map(); // wallet -> { buys, sells }
    const timestamps = [];

    for (const tx of txs) {
      const transfers = tx.tokenTransfers || [];
      for (const tr of transfers) {
        if (!tr || tr.mint !== mint) continue;
        const from = tr.fromUserAccount || tr.from;
        const to = tr.toUserAccount || tr.to;
        if (!from || !to) continue;

        if (!graph.has(from)) graph.set(from, new Map());
        const neighbors = graph.get(from);
        neighbors.set(to, (neighbors.get(to) || 0) + 1);

        // Track volumes
        const trader = tx.fromWallet || from;
        const vol = tx.fee > 0 || tr.tokenAmount ? (tx.fee || 0) : 0;
        walletVolume.set(trader, (walletVolume.get(trader) || 0) + vol);

        if (!walletBuySell.has(trader)) walletBuySell.set(trader, { buys: 0, sells: 0 });
        // Buy = receiving tokens, Sell = sending tokens
        const side = tr.to === trader || tr.toUserAccount === trader ? "buys" : "sells";
        walletBuySell.get(trader)[side] += tr.tokenAmount || 1;
        /*
        if (tx.timestamp) timestamps.push(tx.timestamp);
        */
      }
      if (tx.timestamp) timestamps.push(tx.timestamp);
    }

    // ── Detect self-trading (wallet appears on both sides) ──
    let selfTradeCount = 0;
    for (const [wallet, neighbors] of graph) {
      if (neighbors.has(wallet)) {
        selfTradeCount += neighbors.get(wallet);
        selfTrades = selfTradeCount;
      }
    }
    if (selfTradeCount > 3) {
      deduction += 25;
      flags.push(`Self-trading detected (${selfTradeCount} txs)`);
    }

    // ── Detect circular patterns (A→B→C→A) ──
    // Simplified greedy cycle detection (look for 3-cycles in directed graph)
    let cyclesFound = 0;
    const nodes = [...graph.keys()];
    for (let i = 0; i < Math.min(nodes.length, 80); i++) {
      const A = nodes[i];
      const aNeighbors = graph.get(A) || new Map();
      for (const [B, count] of aNeighbors) {
        if (count < 2) continue; // Repeated transfers more interesting
        const bNeighbors = graph.get(B) || new Map();
        for (const [C] of bNeighbors) {
          if (C === A) continue;
          const cNeighbors = graph.get(C) || new Map();
          const backCount = cNeighbors.get(A);
          if (backCount && backCount >= 1) {
            cyclesFound++;
            if (cyclesFound === 1) {
              flags.push(`Circular transfer: ${A.slice(0, 6)}→${B.slice(0, 6)}→${C.slice(0, 6)}→${A.slice(0, 6)}`);
            }
          }
        }
      }
    }

    if (cyclesFound >= 2) {
      deduction += 30;
      flags.push(`Circular transfer loops detected (${cyclesFound} cycles)`);
    }

    // ── Volume / holder growth mismatch ──
    const uniqueTraders = graph.size;
    const avgVolume = txs.length ? txs.reduce((a, t) => a + (t.fee || 0), 0) / txs.length : 0;

    if (uniqueTraders < 10 && txs.length > 100) {
      deduction += 20;
      flags.push(`Extreme volume diversity mismatch: ${txs.length} txs, only ${uniqueTraders} traders`);
    }

    // ── Estimate circular volume ratio ──
    let circularVolume = cyclesFound > 0 ? txs.length * 0.12 : 0;
    const circularRatio = circularVolume / Math.max(txs.length, 1);

    if (circularRatio > this.thresholds.washVolumeRatio) {
      deduction += 15;
      flags.push(`Wash volume ratio ${(circularRatio * 100).toFixed(1)}% — likely inflated`);
    }

    const totalDeduction = Math.min(deduction, 70);
    return {
      deduction: totalDeduction,
      circularPct: circularRatio * 100,
      selfTrades,
      reason: flags[0] || "",
      circularCycles: cyclesFound,
    };
  }

  // ══════════════════════════════════════════════════════
  //  4. VOLUME ANALYSIS
  // ══════════════════════════════════════════════════════
  async fetchVolumeProfile(mint) {
    try {
      const res = await axios.get(
        `https://public-api.birdeye.so/defi/v3/token/overview`,
        {
          headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana" },
          params: { address: mint },
          timeout: 10000,
        }
      );
      return res.data?.data || null;
    } catch {
      return null;
    }
  }

  async fetchPriceInfo(mint) {
    try {
      const res = await axios.get(
        `https://public-api.birdeye.so/defi/v3/token/price`,
        {
          headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana" },
          params: { address: mint },
          timeout: 10000,
        }
      );
      return res.data?.data || null;
    } catch {
      return null;
    }
  }

  analyzeVolume(volumeData, priceInfo, topHolders) {
    let deduction = 0;
    const reasons = [];
    if (!volumeData) return { deduction: 0, reason: "" };

    const volume24h = volumeData.volume24h || 0;
    const liquidity = volumeData.liquidity || 0;
    const mcap = volumeData.marketcap || 0;
    const holderCount = volumeData.holder ?? topHolders?.length ?? 0;

    // Liquidity / Volume ratio — very high volume with thin liquidity = suspect
    if (liquidity > 0 && volume24h / liquidity > 50) {
      deduction += 25;
      reasons.push(`Volume is ${(volume24h / liquidity).toFixed(1)}x liquidity — likely synthetic volume`);
    }

    // Mcap / holders — low holder count for huge market cap = token concentrated
    if (holderCount > 0 && mcap > 0) {
      const perHolderValue = mcap / holderCount;
      if (perHolderValue > 50000) {
        deduction += 15;
        reasons.push(`Only ${holderCount} holders hold $${perHolderValue.toFixed(0)} avg each — risky concentration`);
      }
    }

    // Price info velocity check (if available)
    if (priceInfo && priceInfo.priceChange24h) {
      const change = Math.abs(priceInfo.priceChange24h);
      if (change > 150 && liquidity < 30000) {
        deduction += 15;
        reasons.push(`+${change.toFixed(0)}% move with weak $${(liquidity / 1000).toFixed(1)}k liquidity`);
      }
    }

    return { deduction, reason: reasons[0] || "" };
  }

  // ══════════════════════════════════════════════════════
  //  5. INSIDER CLUSTER + GRAPH ANALYSIS
  // ══════════════════════════════════════════════════════
  async fetchWalletSignatures(wallet) {
    try {
      const res = await axios.get(
        `https://api.helius.xyz/v0/addresses/${wallet}/transactions`,
        {
          params: { apiKey: this.heliusApiKey, limit: 10 },
          timeout: 10000,
        }
      );
      return res.data || [];
    } catch {
      return [];
    }
  }

  async analyzeCluster(mint, topHolders) {
    const cluster = {
      dangerScore: 0,
      clusterId: null,
      size: 0,
      details: [],
      wallets: [],
      isCoordinatedSellRisk: false,
    };

    if (!topHolders || topHolders.length < 5) return cluster;

    const affectedWallets = topHolders.slice(0, 15).map((h) => h.wallet);
    const clusters = new Map(); // clusterId -> wallets array
    const clusterFunders = new Map(); // clusterId -> set of top funders

    // ── Find funding parents for each wallet (simplified) ──
    for (const wallet of affectedWallets.slice(0, 10)) {
      try {
        const txs = await this.fetchWalletSignatures(wallet);
        const fundedBy = new Set();

        for (const tx of txs) {
          const transfers = tx.tokenTransfers || [];
          for (const tr of transfers) {
            if (!tr) continue;
            const from = tr.fromUserAccount || tr.from;
            const to = tr.toUserAccount || tr.to;
            if (from && to) {
              if (to === wallet) {
                fundedBy.add(from);
              }
            }
          }
        }

        // Assign to a cluster based on funding parent
        let assigned = false;
        const parent = fundedBy.values().next().value;

        // Check if this wallet's top funder is a known dev/creator
        if (this.knownDevWallets.has(mint) && parent === this.knownDevWallets.get(mint)) {
          const id = `dev-${mint.slice(0, 6)}`;
          if (!clusters.has(id)) clusters.set(id, []);
          clusters.get(id).push(wallet);
          if (!clusterFunders.has(id)) clusterFunders.set(id, new Set());
          clusterFunders.get(id).add(parent);
          assigned = true;
        } else if (parent) {
          // Match against existing clusters sharing same parent
          for (const [id, walletsInCluster] of clusters) {
            if (clusterFunders.get(id)?.has(parent)) {
              clusters.get(id).push(wallet);
              clusterFunders.get(id).add(parent);
              assigned = true;
              break;
            }
          }
          if (!assigned && fundedBy.size > 0) {
            const id = `fund-${parent.slice(0, 6)}`;
            if (!clusters.has(id)) clusters.set(id, []);
            clusters.get(id).push(wallet);
            if (!clusterFunders.has(id)) clusterFunders.set(id, new Set());
            clusterFunders.get(id).add(parent);
          }
        }
      } catch {
        // skip
      }
    }

    // ── Score clusters ──
    let highestDanger = 0;
    let mostDangerousClusterId = null;

    for (const [clusterId, wallets] of clusters) {
      if (wallets.length < 2) continue;

      // Build proximity score 0-100
      let danger = 0;
      const isDevCluster = clusterId.startsWith("dev-");

      if (isDevCluster) danger += 40; // Dev-funded wallets are high risk
      if (wallets.length >= 5) danger += 25;
      else if (wallets.length >= 3) danger += 15;

      // Top-holder concentration within same cluster
      const clusterTopHolderPct = topHolders
        .filter((h) => wallets.includes(h.wallet))
        .reduce((a, b) => a + (b.pct || 0), 0);
      if (clusterTopHolderPct > 30) danger += 20;

      danger = Math.min(danger, 99);

      if (danger > highestDanger) {
        highestDanger = danger;
        mostDangerousClusterId = clusterId;
      }
    }

    // ── Coordinated sell check (last 5 min window under this mint) ──
    if (topHolders.length) {
      const recentSells = [];
      const now = Date.now();
      for (const h of topHolders.slice(0, 10)) {
        // Track a global "seen selling" via this wallet's tx logs
        if (this.coordinatedSellHistory.has(mint)) {
          const sellEvents = this.coordinatedSellHistory.get(mint) || [];
          for (const ev of sellEvents) {
            if (ev.wallet === h.wallet &&
                now - ev.timestamp < this.thresholds.timeWindowMs) {
              recentSells.push(ev.wallet);
            }
          }
        }
      }

      if (recentSells.length >= this.thresholds.clusterAlertThreshold) {
        // Cluster is selling in sync — extremely dangerous
        cluster.dangerScore = Math.max(highestDanger, 90);
        cluster.isCoordinatedSellRisk = true;
        cluster.details.push(`Coordinated sell detected: ${recentSells.length} wallets dumping in the same ${Math.round(this.thresholds.timeWindowMs / 60000)} min window`);
        // Trigger alert
        this.sendAlert(
          `🚨 **Coordinated sell detected!**\nToken: \`${mint.slice(0, 8)}...\`\n` +
          `${recentSells.length} cluster wallets selling simultaneously.\n**EVACUATE / BLOCK BUYS.**`
        );
        return cluster;
      }
    }

    if (mostDangerousClusterId && highestDanger > this.thresholds.suspiciousClusterScore) {
      const walletsInDangerousCluster = clusters.get(mostDangerousClusterId);
      const totalPct = topHolders
        .filter((h) => walletsInDangerousCluster.includes(h.wallet))
        .reduce((a, b) => a + (b.pct || 0), 0);

      cluster.clusterId = mostDangerousClusterId;
      cluster.dangerScore = highestDanger;
      cluster.size = walletsInDangerousCluster.length;
      cluster.wallets = walletsInDangerousCluster;
      cluster.details.push(
        `Cluster ${mostDangerousClusterId}: ${walletsInDangerousCluster.length} linked wallets` +
        (totalPct ? ` holding ${totalPct.toFixed(1)}% supply` : "") +
        (mostDangerousClusterId.startsWith("dev-") ? " (dev-funded)" : " (shared funder)") +
        ` — danger ${highestDanger}/100`
      );
    }

    return cluster;
  }

  // ══════════════════════════════════════════════════════
  //  6. COORDINATED SELL RECORDING (called from profit-locker/bot)
  // ══════════════════════════════════════════════════════
  recordSellEvent(mint, wallet) {
    if (!this.coordinatedSellHistory.has(mint)) {
      this.coordinatedSellHistory.set(mint, []);
    }
    const events = this.coordinatedSellHistory.get(mint);
    events.push({ wallet, timestamp: Date.now() });
    // Only keep last 10 events to bound memory
    if (events.length > 10) events.shift();
  }

  // ══════════════════════════════════════════════════════
  //  7. REGISTER KNOWN DEV WALLET (from RugCheck)
  // ══════════════════════════════════════════════════════
  registerDevWallet(mint, devWallet) {
    this.knownDevWallets.set(mint, devWallet);
  }

  // ══════════════════════════════════════════════════════
  //  8. STATE PERSISTENCE
  // ══════════════════════════════════════════════════════
  loadGraphState() {
    try {
      const raw = JSON.parse(fs.readFileSync(GRAPH_STATE_PATH, "utf8"));
      this.clusterMap = new Map(Object.entries(raw.clusterMap || {}));
      this.fundingGraph = new Map(Object.entries(raw.fundingGraph || {}));
    } catch {
      // Fresh start
    }
  }

  saveGraphState() {
    try {
      fs.mkdirSync(path.dirname(GRAPH_STATE_PATH), { recursive: true });
      fs.writeFileSync(GRAPH_STATE_PATH, JSON.stringify({
        clusterMap: Object.fromEntries(this.clusterMap),
        fundingGraph: Object.fromEntries(this.fundingGraph),
        updatedAt: new Date().toISOString(),
      }));
    } catch (e) {
      console.error("[WashDetect] Failed to save graph state:", e.message);
    }
  }

  // ══════════════════════════════════════════════════════
  //  9. ALERTS + CACHE CONTROL
  // ══════════════════════════════════════════════════════
  async sendAlert(message) {
    try {
      if (!this.telegramBot) return;
      const key = message.slice(0, 100);
      const lastSent = this.alertHistory.get(key);
      // Only alert the same thing every 10 min max
      if (lastSent && Date.now() - lastSent < this.thresholds.cachedResultTtlMs) return;
      this.alertHistory.set(key, Date.now());
      await this.telegramBot.sendMessage(this.chatId, message, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("[WashDetect] Alert failed:", e.message);
    }
  }

  clearCache(mint = null) {
    if (mint) {
      this.tokenSafetyCache.delete(mint);
      this.washTradeMemory.delete(mint);
    } else {
      this.tokenSafetyCache.clear();
      this.washTradeMemory.clear();
    }
  }

  // ══════════════════════════════════════════════════════
  //  10. TELEGRAM COMMAND HANDLERS
  // ══════════════════════════════════════════════════════
  registerCommands(bot) {
    if (!bot) return;

    // /safety <token-mint> — Check a token's safety score
    bot.onText(/\/safety (@?\w+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const input = match[1];

      try {
        let mint = input;
        // If input looks like ticker, need to resolve via Birdeye search
        // For now accept mint directly
        const statusMsg = await bot.sendMessage(chatId, `🔍 Analyzing token \`${mint}\`...\nThis takes ~5-10 seconds.`);

        const result = await this.inspectToken(mint, input);
        const emoji = result.pass ? "🟢" : "🔴";
        const messages = [
          `${emoji} **Safety Report** — Trust ${result.trustScore}/100`,
          ``,
          result.flags?.length ? result.flags.join("\n") : "✅ No suspicious patterns found",
        ];
        if (result.clusterInfo?.details?.length) {
          messages.push("", "**Cluster info:**", result.clusterInfo.details.join("\n"));
        }
        messages.push("", `**Verdict:** ${result.pass ? "SAFE TO BUY" : "BLOCKED — DO NOT BUY"}`);

        await bot.editMessageText(messages.join("\n"), {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "Markdown",
        });
        // Trigger sync alert (for debugging)
        // None
      } catch (e) {
        bot.sendMessage(chatId, `❌ Error: ${e.message}`);
      }
    });

    // /cluster <mint> — Show wallet cluster analysis
    bot.onText(/\/cluster (@?\w+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const mint = match[1];
      const holders = await this.fetchTopHolders(mint).catch(() => []);
      const result = await this.analyzeCluster(mint, holders);
      const lines = [
        `🕸️ **Cluster Analysis**`,
        ``,
      ];
      if (result.dangerScore > 0) {
        lines.push(`⚠️ Danger score: ${result.dangerScore}/100`);
        lines.push(`👥 Cluster: ${result.clusterId}`);
        lines.push(`📌 Wallets in cluster: ${result.size}`);
        lines.push(...(result.details || []));
      } else {
        lines.push(`✅ No suspicious insider cluster detected`);
      }
      bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
    });

    // /wash <mint> — Show wash-trading stats
    bot.onText(/\/wash\s+(\w+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const mint = match[1];
      const txs = await this.fetchRecentTransactions(mint).catch(() => []);
      const washResult = await this.detectWashTrading(mint, txs);
      const lines = [
        `🌀 **Wash Trading Report**`,
        ``,
        `Trust deduction: -${washResult.deduction} pts`,
        washResult.circularPct ? `Circular volume ratio: ${washResult.circularPct.toFixed(1)}%` : "Circular volume: N/A",
        washResult.selfTrades ? `Self-trades: ${washResult.selfTrades}` : "Self-trades: none detected",
        washResult.reason ? `⚠️ ${washResult.reason}` : "✅ No major wash patterns",
      ];
      bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
    });

    // /clearsafety — Clear cached safety results
    bot.onText(/\/clearsafety/, (msg) => {
      this.clearCache();
      bot.sendMessage(msg.chat.id, "🧹 Safety cache cleared.");
    });
  }
}

module.exports = WashTradeDetector;
