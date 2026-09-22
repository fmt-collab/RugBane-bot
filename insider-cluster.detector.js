// ═══════════════════════════════════════════════════════════
//  INSIDER CLUSTER DETECTOR
//  Detects when multiple related wallets coordinate a sell
// ═══════════════════════════════════════════════════════════

const axios = require("axios");
const { Connection, PublicKey } = require("@solana/web3.js");

class InsiderClusterDetector {
  constructor(config) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.birdeyeKey = config.birdeyeApiKey;
    this.heliusKey = config.heliusApiKey;

    // token -> cluster data
    this.monitoredTokens = new Map();

    // Detection thresholds
    this.thresholds = {
      timeWindowMs: 60_000,        // 60s window for coordinated sells
      minSellersAlert: 2,          // 2 wallets selling = warning
      minSellersAutoSell: 3,       // 3 wallets = auto-sell 50%
      minSellersEmergency: 4,      // 4+ wallets = auto-sell 100%
      clusterDumpPercentAlert: 15, // 15% of cluster holdings sold
      clusterDumpPercentAuto: 25,  // 25% = auto-sell 50%
      clusterDumpPercentEmergency: 40, // 40% = emergency exit
      checkIntervalMs: 15_000,     // Poll every 15 seconds
    };

    this.alertCallback = null;
    this.sellCallback = null;
    this.intervals = new Map();
  }

  // ══════════════════════════════════════════════════════
  //  1. BUILD CLUSTER — Identify related wallets
  // ══════════════════════════════════════════════════════
  async buildCluster(mint, devWallet = null) {
    console.log(`[Cluster] Building insider cluster for ${mint.slice(0, 8)}...`);

    try {
      const cluster = new Map();
      let totalSupply = 0;

      // ── Step 1: Get top holders from Birdeye ──
      const holderRes = await axios.get(
        "https://public-api.birdeye.so/defi/v3/token/top_trader",
        {
          headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana" },
          params: { address: mint, limit: 20 },
        }
      );

      const holders = holderRes.data?.data?.items || [];

      for (const h of holders) {
        const addr = h.owner || h.address;
        const balance = h.volume || 0;

        cluster.set(addr, {
          balance,
          initialBalance: balance,
          lastSellTime: 0,
          totalSold: 0,
          sellCount: 0,
          isKnownDev: addr === devWallet,
          fundingSource: null, // filled by cluster linking
        });

        totalSupply += balance;
      }

      // ── Step 2: Add dev wallet if not already in cluster ──
      if (devWallet && !cluster.has(devWallet)) {
        const devBalance = await this.getTokenBalance(mint, devWallet);
        cluster.set(devWallet, {
          balance: devBalance,
          initialBalance: devBalance,
          lastSellTime: 0,
          totalSold: 0,
          sellCount: 0,
          isKnownDev: true,
          fundingSource: null,
        });
        totalSupply += devBalance;
      }

      // ── Step 3: Detect funding links (wallets funded from same source) ──
      const fundingLinks = await this.detectFundingLinks(
        Array.from(cluster.keys())
      );

      // Tag wallets with shared funding source
      for (const [wallet, source] of fundingLinks.entries()) {
        if (cluster.has(wallet)) {
          cluster.get(wallet).fundingSource = source;
        }
      }

      // ── Step 4: Identify sub-clusters ──
      const subClusters = this.findSubClusters(cluster);

      this.monitoredTokens.set(mint, {
        cluster,
        totalSupply,
        recentSells: [],           // sells within time window
        subClusters,               // groups of wallets funded by same source
        rugConfidence: 0,          // 0-100 score
        lastCheckTime: Date.now(),
        alertLevel: "none",        // none | warning | danger | critical
      });

      console.log(`[Cluster] Found ${cluster.size} wallets, ${subClusters.length} sub-clusters`);

      return {
        walletCount: cluster.size,
        subClusters: subClusters.length,
        totalSupply,
      };
    } catch (err) {
      console.error(`[Cluster] Build failed:`, err.message);
      return { walletCount: 0, subClusters: 0, totalSupply: 0 };
    }
  }

  // ══════════════════════════════════════════════════════
  //  2. DETECT FUNDING LINKS — Are wallets related?
  // ══════════════════════════════════════════════════════
  async detectFundingLinks(wallets) {
    const fundingMap = new Map(); // wallet -> source

    try {
      for (const wallet of wallets.slice(0, 10)) { // limit API calls
        const res = await axios.get(
          "https://api.helius.xyz/v0/addresses/" + wallet + "/transactions",
          {
            params: { "api-key": this.heliusKey, limit: 10 },
          }
        );

        const txs = res.data || [];

        // Find SOL transfers INTO this wallet (funding source)
        for (const tx of txs) {
          if (tx.instructions) {
            for (const ix of tx.instructions) {
              if (ix.type === "TRANSFER" && ix.destination === wallet) {
                fundingMap.set(wallet, ix.source);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("[Cluster] Funding link detection error:", err.message);
    }

    return fundingMap;
  }

  // ══════════════════════════════════════════════════════
  //  3. FIND SUB-CLUSTERS — Group wallets by shared source
  // ══════════════════════════════════════════════════════
  findSubClusters(cluster) {
    const groups = new Map(); // source -> [wallets]

    for (const [wallet, data] of cluster.entries()) {
      const source = data.fundingSource || wallet;
      if (!groups.has(source)) {
        groups.set(source, []);
      }
      groups.get(source).push(wallet);
    }

    // Only keep groups with 2+ wallets (actual clusters)
    return Array.from(groups.entries())
      .filter(([, wallets]) => wallets.length >= 2)
      .map(([source, wallets]) => ({
        source,
        wallets,
        size: wallets.length,
      }));
  }

  // ══════════════════════════════════════════════════════
  //  4. MONITOR — Check for coordinated sells
  // ══════════════════════════════════════════════════════
  async checkClusterActivity(mint) {
    const data = this.monitoredTokens.get(mint);
    if (!data) return;

    const now = Date.now();
    let walletsSold = 0;
    let totalSoldAmount = 0;

    for (const [wallet, walletData] of data.cluster.entries()) {
      const currentBalance = await this.getTokenBalance(mint, wallet);

      if (currentBalance < walletData.balance) {
        const sold = walletData.balance - currentBalance;
        walletData.totalSold += sold;
        walletData.balance = currentBalance;
        walletData.lastSellTime = now;
        walletData.sellCount++;

        data.recentSells.push({
          wallet,
          amount: sold,
          timestamp: now,
          isKnownDev: walletData.isKnownDev,
          fundingSource: walletData.fundingSource,
        });

        walletsSold++;
        totalSoldAmount += sold;
      }
    }

    // ── Clean old sells outside time window ──
    data.recentSells = data.recentSells.filter(
      (s) => now - s.timestamp <= this.thresholds.timeWindowMs
    );

    // ── Calculate coordination metrics ──
    const uniqueSellers = new Set(data.recentSells.map((s) => s.wallet)).size;
    const devSellers = data.recentSells.filter((s) => s.isKnownDev).length;
    const clusterDumpPercent =
      (totalSoldAmount / data.totalSupply) * 100;

    // ── Rug Confidence Score (0-100) ──
    let confidence = 0;
    confidence += uniqueSellers * 15;                          // +15 per wallet selling
    confidence += devSellers * 25;                             // +25 if dev is selling
    confidence += Math.min(clusterDumpPercent, 50);           // up to +50 for dump %
    confidence += this.countSubClusterSells(data) * 10;       // +10 per sub-cluster selling
    confidence = Math.min(confidence, 100);
    data.rugConfidence = confidence;

    // ── Determine alert level ──
    let alertLevel = "none";
    let sellPercent = 0;

    if (
      uniqueSellers >= this.thresholds.minSellersEmergency ||
      clusterDumpPercent >= this.thresholds.clusterDumpPercentEmergency ||
      (devSellers >= 2 && uniqueSellers >= 3)
    ) {
      alertLevel = "critical";
      sellPercent = 100;
    } else if (
      uniqueSellers >= this.thresholds.minSellersAutoSell ||
      clusterDumpPercent >= this.thresholds.clusterDumpPercentAuto
    ) {
      alertLevel = "danger";
      sellPercent = 50;
    } else if (
      uniqueSellers >= this.thresholds.minSellersAlert ||
      clusterDumpPercent >= this.thresholds.clusterDumpPercentAlert
    ) {
      alertLevel = "warning";
      sellPercent = 0; // alert only
    }

    data.alertLevel = alertLevel;

    // ── Trigger alerts and sells ──
    if (alertLevel !== "none") {
      await this.triggerAlert(mint, data, uniqueSellers, devSellers, clusterDumpPercent, sellPercent);
    }

    data.lastCheckTime = now;
    return { uniqueSellers, devSellers, clusterDumpPercent, confidence, alertLevel };
  }

  // ══════════════════════════════════════════════════════
  //  5. TRIGGER ALERT + AUTO-SELL
  // ══════════════════════════════════════════════════════
  async triggerAlert(mint, data, sellers, devSellers, dumpPercent, sellPercent) {
    const icons = { warning: "⚠️", danger: "🟠", critical: "🚨" };
    const icon = icons[data.alertLevel] || "⚠️";

    // Build sub-cluster info
    let subClusterInfo = "";
    const activeSubClusters = this.getActiveSubClusters(data);
    for (const sc of activeSubClusters) {
      subClusterInfo += `  • Sub-cluster (${sc.size} wallets, source: ${sc.source.slice(0, 8)}...)\n`;
    }

    const msg =
      `${icon} **COORDINATED DUMP DETECTED** ${icon}\n\n` +
      `Token: \`${mint.slice(0, 12)}...\`\n` +
      `Selling wallets: **${sellers}/${data.cluster.size}**\n` +
      `Dev wallets selling: **${devSellers}**\n` +
      `Cluster dumped: **${dumpPercent.toFixed(1)}%**\n` +
      `Rug confidence: **${data.rugConfidence}/100**\n` +
      (subClusterInfo ? `Sub-clusters active:\n${subClusterInfo}` : "") +
      `\n⏰ ${new Date().toLocaleTimeString()}\n` +
      (sellPercent > 0
        ? `\n**AUTO-SELLING ${sellPercent}% NOW**`
        : `\n⚠️ Watch closely — more selling may follow`);

    if (this.alertCallback) {
      this.alertCallback(msg);
    }

    if (sellPercent > 0 && this.sellCallback) {
      await this.sellCallback(mint, sellPercent, "coordinated_cluster_dump");
    }
  }

  getActiveSubClusters(data) {
    const now = Date.now();
    return data.subClusters.filter((sc) => {
      const recentSellers = data.recentSells.filter(
        (s) =>
          sc.wallets.includes(s.wallet) &&
          now - s.timestamp <= this.thresholds.timeWindowMs
      );
      return recentSellers.length >= 2;
    });
  }

  countSubClusterSells(data) {
    return this.getActiveSubClusters(data).length;
  }

  // ══════════════════════════════════════════════════════
  //  6. START/STOP MONITORING
  // ══════════════════════════════════════════════════════
  startMonitoring(mint) {
    if (this.intervals.has(mint)) return;

    const interval = setInterval(
      () => this.checkClusterActivity(mint),
      this.thresholds.checkIntervalMs
    );
    this.intervals.set(mint, interval);
    console.log(`[Cluster] Monitoring started for ${mint.slice(0, 8)}...`);
  }

  stopMonitoring(mint) {
    if (this.intervals.has(mint)) {
      clearInterval(this.intervals.get(mint));
      this.intervals.delete(mint);
      this.monitoredTokens.delete(mint);
      console.log(`[Cluster] Monitoring stopped for ${mint.slice(0, 8)}...`);
    }
  }

  // ── Token balance helper ──
  async getTokenBalance(mint, wallet) {
    try {
      const res = await this.connection.getTokenAccountBalance(
        new PublicKey(wallet)
      );
      return res.value.uiAmount || 0;
    } catch {
      return 0;
    }
  }

  // ── Status report ──
  getStatus(mint) {
    const data = this.monitoredTokens.get(mint);
    if (!data) return null;

    return {
      walletsTracked: data.cluster.size,
      subClusters: data.subClusters.length,
      rugConfidence: data.rugConfidence,
      alertLevel: data.alertLevel,
      recentSells: data.recentSells.length,
      totalDumped: data.recentSells.reduce((sum, s) => sum + s.amount, 0),
    };
  }

  setCallbacks(alertFn, sellFn) {
    this.alertCallback = alertFn;
    this.sellCallback = sellFn;
  }
}

module.exports = InsiderClusterDetector;
