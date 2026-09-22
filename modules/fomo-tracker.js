// ═══════════════════════════════════════════════════════════
//  FOMO TRACKER
//  Monitors fomo.family leaderboard, trending tokens, alerts
// ═══════════════════════════════════════════════════════════

const axios = require("axios");
const fs = require("fs");
const path = require("path");

class FomoTracker {
  constructor(config = {}) {
    this.bot = config.telegramBot;
    this.chatId = config.chatId;

    // ── FOMO API endpoints ──
    this.baseUrl = "https://api.fomoapi.io";
    this.fallbackUrl = "https://fomo.family/api";

    // ── Config ──
    this.config = {
      pollIntervalMs: 3 * 60 * 1000,     // 3 minutes
      leaderboardRefreshMs: 5 * 60 * 1000, // 5 minutes
      minTraderScore: 70,                  // minimum trader score to track
      alertThreshold: 1000,                // alert if trader buys > $1000
      trendingAlertMultiplier: 1.5,        // alert if token price jumps 1.5x
    };

    // ── State ──
    this.leaderboard = [];
    this.trendingTokens = [];
    this.trackedTokens = new Map();  // mint -> { firstSeen, priceHistory, alerts }
    this.traderActivity = new Map(); // wallet -> { trades, lastSeen }
    this.alertHistory = new Map();   // key -> timestamp
    this.lastLeaderboardFetch = 0;

    // ── Persistence ──
    this.statePath = config.statePath || path.join(__dirname, "..", "data", "fomo-state.json");
    this.loadState();

    console.log("[FomoTracker] Initialized");
  }

  // ══════════════════════════════════════════════════════
  //  STATE PERSISTENCE
  // ══════════════════════════════════════════════════════

  loadState() {
    try {
      if (fs.existsSync(this.statePath)) {
        const data = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
        this.trackedTokens = new Map(Object.entries(data.trackedTokens || {}));
        this.traderActivity = new Map(Object.entries(data.traderActivity || {}));
        console.log("[FomoTracker] State loaded");
      }
    } catch (e) {
      console.error("[FomoTracker] Load state failed:", e.message);
    }
  }

  saveState() {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      
      const data = {
        trackedTokens: Object.fromEntries(this.trackedTokens),
        traderActivity: Object.fromEntries(this.traderActivity),
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.statePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error("[FomoTracker] Save state failed:", e.message);
    }
  }

  // ══════════════════════════════════════════════════════
  //  API FETCHING (with fallback)
  // ══════════════════════════════════════════════════════

  async fetchLeaderboard(timeframe = "24H", limit = 20) {
    try {
      // Try primary API
      const res = await axios.get(`${this.baseUrl}/v2/leaderboard/${timeframe}`, {
        params: { limit },
        timeout: 10000,
      });
      return res.data?.data || res.data || [];
    } catch (e1) {
      try {
        // Try fallback
        const res = await axios.get(`${this.fallbackUrl}/leaderboard`, {
          params: { timeframe, limit },
          timeout: 10000,
        });
        return res.data?.data || res.data || [];
      } catch (e2) {
        console.error("[FomoTracker] Leaderboard fetch failed:", e2.message);
        return [];
      }
    }
  }

  async fetchTrendingTokens(limit = 15) {
    try {
      const res = await axios.get(`${this.baseUrl}/v2/tokens/trending`, {
        params: { limit },
        timeout: 10000,
      });
      return res.data?.data || res.data || [];
    } catch (e1) {
      try {
        const res = await axios.get(`${this.fallbackUrl}/trending`, {
          params: { limit },
          timeout: 10000,
        });
        return res.data?.data || res.data || [];
      } catch (e2) {
        console.error("[FomoTracker] Trending fetch failed:", e2.message);
        return [];
      }
    }
  }

  async fetchTraderActivity(walletAddress) {
    try {
      const res = await axios.get(`${this.baseUrl}/v2/trader/${walletAddress}/trades`, {
        params: { limit: 10 },
        timeout: 10000,
      });
      return res.data?.data || [];
    } catch (e) {
      console.error("[FomoTracker] Trader activity failed:", e.message);
      return [];
    }
  }

  async fetchTokenInfo(mint) {
    try {
      const res = await axios.get(`${this.baseUrl}/v2/token/${mint}`, {
        timeout: 10000,
      });
      return res.data?.data || null;
    } catch {
      return null;
    }
  }

  // ══════════════════════════════════════════════════════
  //  LEADERBOARD MONITORING
  // ══════════════════════════════════════════════════════

  async checkLeaderboard() {
    const now = Date.now();
    
    // Don't fetch too often
    if (now - this.lastLeaderboardFetch < this.config.leaderboardRefreshMs) {
      return;
    }

    console.log("[FomoTracker] Checking leaderboard...");
    this.lastLeaderboardFetch = now;

    const leaderboard = await this.fetchLeaderboard("24H", 20);
    if (leaderboard.length === 0) return;

    this.leaderboard = leaderboard;

    // Check for new top traders or position changes
    for (const trader of leaderboard.slice(0, 10)) {
      const wallet = trader.wallet || trader.address;
      if (!wallet) continue;

      const prev = this.traderActivity.get(wallet);
      const current = {
        rank: trader.rank || leaderboard.indexOf(trader) + 1,
        pnl: trader.pnl || trader.profit || 0,
        winRate: trader.winRate || trader.win_rate || 0,
        tradeCount: trader.tradeCount || trader.trades || 0,
        lastSeen: now,
        recentTrades: [],
      };

      // Fetch recent trades for top traders
      if (!prev || now - (prev.lastSeen || 0) > this.config.pollIntervalMs) {
        const trades = await this.fetchTraderActivity(wallet);
        current.recentTrades = trades.slice(0, 5);

        // Check for new buys
        if (prev?.recentTrades) {
          const newBuys = this.findNewBuys(prev.recentTrades, trades);
          for (const buy of newBuys) {
            await this.onTraderBuy(trader, buy);
          }
        }
      }

      this.traderActivity.set(wallet, { ...prev, ...current });
    }

    this.saveState();
  }

  findNewBuys(prevTrades, currentTrades) {
    const prevSigs = new Set((prevTrades || []).map((t) => t.signature || t.tx));
    return (currentTrades || []).filter(
      (t) => !prevSigs.has(t.signature || t.tx) && t.side === "buy"
    );
  }

  async onTraderBuy(trader, trade) {
    const wallet = trader.wallet || trader.address;
    const token = trade.token || trade.mint;
    const symbol = trade.symbol || trade.ticker || "?";
    const amount = trade.amount || trade.usdAmount || 0;

    console.log(`[FomoTracker] Top trader ${trader.rank || "?"} bought ${symbol}`);

    // Track this token
    const tracked = this.trackedTokens.get(token) || {
      firstSeen: Date.now(),
      priceHistory: [],
      alerts: [],
      boughtBy: [],
    };
    
    if (!tracked.boughtBy.includes(wallet)) {
      tracked.boughtBy.push(wallet);
    }
    this.trackedTokens.set(token, tracked);

    // Alert if significant buy from top trader
    if (trader.rank <= 10 && amount >= this.config.alertThreshold) {
      const alertKey = `${token}-${wallet}-${Date.now()}`;
      if (!this.alertHistory.has(alertKey)) {
        this.alertHistory.set(alertKey, Date.now());
        
        await this.sendAlert(
          `🔥 *FOMO Top Trader Buy!*\n\n` +
          `👤 Trader: #${trader.rank || "?"}\n` +
          `💰 Buy: $${amount.toLocaleString()}\n` +
          `🪙 Token: ${symbol}\n` +
          `📍 Mint: \`${token}\`\n\n` +
          `Win Rate: ${trader.winRate || "?"}%\n` +
          `Total PnL: $${(trader.pnl || 0).toLocaleString()}`
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════
  //  TRENDING TOKEN MONITORING
  // ══════════════════════════════════════════════════════

  async checkTrending() {
    console.log("[FomoTracker] Checking trending tokens...");

    const trending = await this.fetchTrendingTokens(15);
    if (trending.length === 0) return;

    this.trendingTokens = trending;

    for (const token of trending) {
      const mint = token.mint || token.address;
      if (!mint) continue;

      const tracked = this.trackedTokens.get(mint) || {
        firstSeen: Date.now(),
        priceHistory: [],
        alerts: [],
        boughtBy: [],
      };

      // Track price
      const price = token.price || token.priceUsd || 0;
      if (price > 0) {
        tracked.priceHistory.push({ price, time: Date.now() });
        
        // Keep last 100 price points
        if (tracked.priceHistory.length > 100) {
          tracked.priceHistory = tracked.priceHistory.slice(-100);
        }

        // Check for price spike
        if (tracked.priceHistory.length >= 2) {
          const prev = tracked.priceHistory[tracked.priceHistory.length - 2].price;
          const change = (price - prev) / prev;
          
          if (change >= this.config.trendingAlertMultiplier - 1) {
            const alertKey = `spike-${mint}`;
            if (!this.alertHistory.has(alertKey) || 
                Date.now() - this.alertHistory.get(alertKey) > 60000) {
              this.alertHistory.set(alertKey, Date.now());
              
              await this.sendAlert(
                `📈 *Price Spike Detected!*\n\n` +
                `🪙 ${token.symbol || "?"}\n` +
                `📊 Change: +${(change * 100).toFixed(1)}%\n` +
                `💰 Price: $${price}\n` +
                `📍 Mint: \`${mint}\``
              );
            }
          }
        }
      }

      this.trackedTokens.set(mint, tracked);
    }

    this.saveState();
  }

  // ══════════════════════════════════════════════════════
  //  COMMAND HANDLERS
  // ══════════════════════════════════════════════════════

  async handleCommand(command, chatId) {
    const cmd = command.toLowerCase();

    if (cmd === "/fomo trending") {
      return this.cmdTrending(chatId);
    }

    if (cmd === "/fomo leaderboard") {
      return this.cmdLeaderboard(chatId);
    }

    if (cmd.startsWith("/fomo token ")) {
      const token = command.split(" ")[2];
      return this.cmdTokenInfo(chatId, token);
    }

    if (cmd === "/fomo tracked") {
      return this.cmdTracked(chatId);
    }
  }

  async cmdTrending(chatId) {
    const trending = await this.fetchTrendingTokens(10);

    if (trending.length === 0) {
      return this.sendTo(chatId, "❌ No trending data available");
    }

    const lines = trending.map((t, i) => {
      const price = t.price || t.priceUsd || 0;
      const change = t.priceChange24h || t.change24h || 0;
      const volume = t.volume24h || t.volume || 0;
      return (
        `${i + 1}. *${t.symbol || "?"}* — $${price}\n` +
        `   Change: ${change >= 0 ? "+" : ""}${(change * 100).toFixed(1)}% | Vol: $${volume.toLocaleString()}\n` +
        `   Mint: \`${t.mint || t.address}\``
      );
    });

    await this.sendTo(
      chatId,
      `🔥 *FOMO Trending Tokens*\n\n${lines.join("\n\n")}`
    );
  }

  async cmdLeaderboard(chatId) {
    const lb = await this.fetchLeaderboard("24H", 10);

    if (lb.length === 0) {
      return this.sendTo(chatId, "❌ No leaderboard data available");
    }

    const lines = lb.map((t, i) => {
      const wallet = t.wallet || t.address || "?";
      const short = wallet.slice(0, 4) + "..." + wallet.slice(-4);
      return (
        `#${i + 1} — *${short}*\n` +
        `   PnL: $${(t.pnl || t.profit || 0).toLocaleString()} | Win: ${t.winRate || "?"}%`
      );
    });

    await this.sendTo(
      chatId,
      `🏆 *FOMO 24H Leaderboard*\n\n${lines.join("\n\n")}`
    );
  }

  async cmdTokenInfo(chatId, mintOrSymbol) {
    const token = await this.fetchTokenInfo(mintOrSymbol);

    if (!token) {
      return this.sendTo(chatId, "❌ Token not found");
    }

    const tracked = this.trackedTokens.get(mintOrSymbol);
    const boughtByCount = tracked?.boughtBy?.length || 0;

    await this.sendTo(
      chatId,
      `🪙 *Token Info*\n\n` +
      `Symbol: ${token.symbol || "?"}\n` +
      `Name: ${token.name || "?"}\n` +
      `Price: $${token.price || 0}\n` +
      `24h Change: ${token.priceChange24h || 0}%\n` +
      `Volume: $${(token.volume24h || 0).toLocaleString()}\n` +
      `Holders: ${token.holders || "?"}\n\n` +
      `🔥 Tracked by ${boughtByCount} FOMO traders\n` +
      `📍 Mint: \`${token.mint || mintOrSymbol}\``
    );
  }

  async cmdTracked(chatId) {
    if (this.trackedTokens.size === 0) {
      return this.sendTo(chatId, "📭 No tokens tracked yet");
    }

    const entries = [...this.trackedTokens.entries()].slice(0, 10);
    const lines = entries.map(([mint, data]) => {
      const traders = data.boughtBy?.length || 0;
      const age = Math.floor((Date.now() - data.firstSeen) / 60000);
      return `• \`${mint.slice(0, 8)}...\` — ${traders} traders, ${age}m old`;
    });

    await this.sendTo(
      chatId,
      `📋 *Tracked Tokens (${this.trackedTokens.size} total)*\n\n${lines.join("\n")}`
    );
  }

  // ══════════════════════════════════════════════════════
  //  ALERTS
  // ══════════════════════════════════════════════════════

  async sendAlert(msg) {
    if (!this.bot || !this.chatId) {
      console.log("[FomoTracker Alert]", msg);
      return;
    }
    try {
      await this.bot.sendMessage(this.chatId, msg, { parse_mode: "Markdown" });
    } catch (e) {
      try {
        await this.bot.sendMessage(this.chatId, msg);
      } catch {
        console.error("[FomoTracker] Alert failed:", e.message);
      }
    }
  }

  async sendTo(chatId, msg) {
    if (!this.bot) return;
    try {
      await this.bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    } catch (e) {
      try {
        await this.bot.sendMessage(chatId, msg);
      } catch (e2) {
        console.error("[FomoTracker] Send failed:", e2.message);
      }
    }
  }
}

module.exports = FomoTracker;
