// ═══════════════════════════════════════════════════════════
//  PROFIT LOCKER v3
//  Multi-Wallet Portfolio | Custom Ladder | Performance Stats
//  Trailing Stop | Ladder Sells | Cold Wallet Auto-Transfer
// ═══════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const bs58 = require("bs58");

const SOL_MINT = "So11111111111111111111111111111111111111112";

const DEFAULT_SETTINGS = {
  trailActivateX: 1.5,       // trailing starts after 1.5x
  trailPct: 0.25,            // stop 25% below peak
  minTrailPct: 0.08,         // never tighter than 8%
  stopLossX: 0.5,            // hard stop at -50%
  ladder: [
    { mult: 1.5, pct: 20 },  // sell 20% at 1.5x
    { mult: 2.0, pct: 20 },  // sell 20% at 2x
    { mult: 3.0, pct: 20 },  // sell 20% at 3x
    { mult: 5.0, pct: 20 },  // sell 20% at 5x
    // remaining 20% = moon bag
  ],
};

class ProfitLockerV3 {
  constructor(config = {}) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.birdeyeKey = config.birdeyeApiKey || "";
    this.coldWallet = config.coldWalletAddress || "";
    this.wallet = config.privateKey
      ? Keypair.fromSecretKey(bs58.decode(config.privateKey))
      : null;
    this.paperTrading = config.paperTrading !== false;
    this.bot = config.telegramBot || null;
    this.chatId = config.chatId || "";

    // Injected from index.js for real swaps/transfers
    this.sellToken = config.sellToken || null;
    this.transferSol = config.transferSol || null;

    // State file
    this.statePath =
      config.statePath ||
      path.join(__dirname, "..", "data", "profit-locker-v3-state.json");

    // Multi-wallet support
    this.wallets = config.wallets || [
      {
        id: "A",
        label: "Copy Trade",
        address: config.tradingWalletAddress || "",
        privateKey: config.privateKey || null,
      },
    ];

    this.solPriceUsd = config.solPriceUsd || 150;
    this.solPriceUsdTs = 0;

    this.state = this.loadState();
    this.checkTimer = null;
    this.saveTimer = null;
    this.priceCache = new Map();
    this.balanceCache = new Map();

    // Paper trading balances per wallet
    this.paperBalances = new Map();
    for (const w of this.wallets) {
      this.paperBalances.set(w.id, config.paperStartSol ?? 0.3);
    }

    this.primeSolPrice().catch(() => {});
    this.startMonitoring();

    if (this.bot) this.registerHandlers(this.bot);
    console.log("[ProfitLocker] v3 loaded");
  }

  // ═══════════════════════════════════════
  //  STATE PERSISTENCE
  // ═══════════════════════════════════════

  defaultState() {
    return {
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      wallets: this.wallets.map((w) => ({
        id: w.id,
        label: w.label,
        address: w.address,
      })),
      openPositions: {},
      closedPositions: {},
      trades: [],
      updatedAt: null,
    };
  }

  loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      const d = this.defaultState();
      const known = new Map();
      for (const w of [...d.wallets, ...(raw.wallets || [])])
        known.set(w.id, { ...known.get(w.id), ...w });
      return {
        ...d,
        ...raw,
        wallets: [...known.values()],
        settings: {
          ...d.settings,
          ...(raw.settings || {}),
          ladder: raw.settings?.ladder?.length
            ? raw.settings.ladder
            : d.settings.ladder,
        },
      };
    } catch {
      return this.defaultState();
    }
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        const dir = path.dirname(this.statePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        this.state.updatedAt = new Date().toISOString();
        fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
      } catch (e) {
        console.error("[ProfitLocker] Save failed:", e.message);
      }
    }, 800);
  }

  // ═══════════════════════════════════════
  //  SOL PRICE
  // ═══════════════════════════════════════

  async primeSolPrice() {
    try {
      const res = await axios.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { timeout: 5000 }
      );
      this.solPriceUsd = res.data.solana.usd;
    } catch {
      try {
        const res = await axios.get(
          `https://public-api.birdeye.so/defi/v3/token/price?address=${SOL_MINT}`,
          { headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana" }, timeout: 5000 }
        );
        this.solPriceUsd = res.data?.data?.price || this.solPriceUsd;
      } catch {}
    }
  }

  // ═══════════════════════════════════════
  //  POSITION TRACKING
  // ═══════════════════════════════════════

  addPosition({ mint, symbol, entryPriceSol, tokenAmount, walletId = "A" }) {
    const pos = {
      mint,
      symbol,
      walletId,
      entryPriceSol,
      tokenAmount,
      entryTime: Date.now(),
      peakPriceSol: entryPriceSol,
      currentPriceSol: entryPriceSol,
      rungsHit: [],
      soldPct: 0,
      moonBagPct: 100,
      status: "open",
      trailTriggered: false,
    };
    this.state.openPositions[mint] = pos;
    this.scheduleSave();
    this.send(`📊 Position opened: $${symbol} | ${tokenAmount} tokens | ${entryPriceSol.toFixed(4)} SOL entry`);
    return pos;
  }

  // ═══════════════════════════════════════
  //  PRICE CHECKING
  // ═══════════════════════════════════════

  async getTokenPrice(mint) {
    if (this.priceCache.has(mint)) {
      const cached = this.priceCache.get(mint);
      if (Date.now() - cached.ts < 15000) return cached.price; // 15s cache
    }
    try {
      const res = await axios.get(
        `https://public-api.birdeye.so/defi/v3/token/price?address=${mint}`,
        {
          headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana" },
          timeout: 5000,
        }
      );
      const price = res.data?.data?.price || 0;
      this.priceCache.set(mint, { price, ts: Date.now() });
      return price;
    } catch {
      return this.priceCache.get(mint)?.price || 0;
    }
  }

  // ═══════════════════════════════════════
  //  MONITORING LOOP
  // ═══════════════════════════════════════

  startMonitoring() {
    if (this.checkTimer) clearInterval(this.checkTimer);
    this.checkTimer = setInterval(() => this.checkAllPositions(), 10000); // every 10s
    console.log("[ProfitLocker] Monitoring started (10s interval)");
  }

  async checkAllPositions() {
    const open = Object.entries(this.state.openPositions);
    for (const [mint, pos] of open) {
      try {
        await this.evaluatePosition(mint, pos);
      } catch (e) {
        console.error(`[ProfitLocker] Check ${pos.symbol} failed:`, e.message);
      }
    }
    this.scheduleSave();
  }

  async evaluatePosition(mint, pos) {
    const currentPrice = await this.getTokenPrice(mint);
    if (!currentPrice || !pos.entryPriceSol) return;

    pos.currentPriceSol = currentPrice;
    const mult = currentPrice / pos.entryPriceSol;

    // Update peak
    if (mult > (pos.peakPriceSol / pos.entryPriceSol)) {
      pos.peakPriceSol = currentPrice;
    }

    const peakMult = pos.peakPriceSol / pos.entryPriceSol;
    const currentMult = mult;

    // ── 1. HARD STOP LOSS ──
    if (currentMult <= this.state.settings.stopLossX && pos.soldPct < 100) {
      await this.executeSell(mint, pos, 100 - pos.soldPct, "🛑 STOP LOSS");
      return;
    }

    // ── 2. LADDER SELL CHECK ──
    const settings = this.state.settings;
    for (let i = 0; i < settings.ladder.length; i++) {
      const rung = settings.ladder[i];
      if (pos.rungsHit.includes(i)) continue;

      if (currentMult >= rung.mult) {
        pos.rungsHit.push(i);
        const sellAmount = (rung.pct / 100) * (100 - pos.soldPct);
        if (sellAmount > 0) {
          await this.executeSell(
            mint, pos, sellAmount,
            `🎯 LADDER ${rung.mult}x → sell ${rung.pct}%`
          );
          // Transfer profit to cold wallet
          if (this.coldWallet && sellAmount > 0) {
            const profitSol = (sellAmount / 100) * pos.tokenAmount * currentPrice;
            await this.transferToCold(profitSol * 0.9); // 90% to cold
          }
        }
      }
    }

    // ── 3. TRAILING STOP ──
    if (peakMult >= settings.trailActivateX && pos.soldPct < 100) {
      const tightenPerRung = 0.04;
      const tightenedTrail = Math.max(
        settings.minTrailPct,
        settings.trailPct - (pos.rungsHit.length * tightenPerRung)
      );
      const dropFromPeak = 1 - (currentMult / peakMult);

      if (dropFromPeak >= tightenedTrail) {
        const remaining = 100 - pos.soldPct;
        if (remaining > 0) {
          await this.executeSell(
            mint, pos, remaining,
            `📉 TRAIL STOP at ${peakMult.toFixed(1)}x peak → ${currentMult.toFixed(1)}x`
          );
          // Transfer all to cold
          if (this.coldWallet) {
            const profitSol = (remaining / 100) * pos.tokenAmount * currentPrice;
            await this.transferToCold(profitSol * 0.9);
          }
        }
      }
    }
  }

  // ═══════════════════════════════════════
  //  SELL EXECUTION
  // ═══════════════════════════════════════

  async executeSell(mint, pos, sellPct, reason) {
    const actualSellPct = Math.min(sellPct, 100 - pos.soldPct);
    if (actualSellPct <= 0) return;

    const mult = pos.currentPriceSol / pos.entryPriceSol;
    const pnlSol = ((pos.currentPriceSol - pos.entryPriceSol) * pos.tokenAmount * (actualSellPct / 100));
    const pnlUsd = pnlSol * this.solPriceUsd;

    this.send(
      `💰 SELL ${pos.symbol}\n` +
      `  ${reason}\n` +
      `  Sell: ${actualSellPct.toFixed(0)}% | ${mult.toFixed(2)}x\n` +
      `  P&L: ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL (~$${pnlUsd.toFixed(2)})`
    );

    pos.soldPct += actualSellPct;
    pos.moonBagPct = 100 - pos.soldPct;

    if (pos.soldPct >= 100) {
      pos.status = "closed";
      this.closePosition(mint, pos);
    }

    // Execute real sell via injected function
    if (this.sellToken && !this.paperTrading) {
      try {
        await this.sellToken(mint, actualSellPct);
        this.send(`✅ Sell executed on-chain`);
      } catch (e) {
        this.send(`❌ Sell failed: ${e.message}`);
      }
    } else if (this.paperTrading) {
      this.send(`📝 Paper trade sell recorded`);
    }
  }

  async transferToCold(amountSol) {
    if (!amountSol || amountSol <= 0) return;
    if (this.transferSol && !this.paperTrading) {
      try {
        await this.transferSol(this.coldWallet, amountSol);
        this.send(`🏦 Transferred ${amountSol.toFixed(4)} SOL to cold wallet`);
      } catch (e) {
        this.send(`❌ Cold transfer failed: ${e.message}`);
      }
    } else if (this.paperTrading) {
      this.send(`📝 Paper transfer ${amountSol.toFixed(4)} SOL to cold`);
    }
  }

  closePosition(mint, pos) {
    this.state.closedPositions[mint] = { ...pos, closedAt: Date.now() };
    delete this.state.openPositions[mint];

    // Record trade
    this.state.trades.push({
      mint,
      symbol: pos.symbol,
      walletId: pos.walletId,
      entryPriceSol: pos.entryPriceSol,
      exitPriceSol: pos.currentPriceSol,
      entryTime: pos.entryTime,
      exitTime: Date.now(),
      pnlSol: (pos.currentPriceSol - pos.entryPriceSol) * pos.tokenAmount,
      peakMult: pos.peakPriceSol / pos.entryPriceSol,
      exitMult: pos.currentPriceSol / pos.entryPriceSol,
    });

    this.send(`📊 Position closed: $${pos.symbol} | Final: ${(pos.currentPriceSol / pos.entryPriceSol).toFixed(2)}x`);
    this.scheduleSave();
  }

  // ═══════════════════════════════════════
  //  MULTI-WALLET PORTFOLIO
  // ═══════════════════════════════════════

  async getPortfolio() {
    const open = Object.values(this.state.openPositions);
    let totalInvested = 0;
    let totalCurrent = 0;
    let walletBreakdown = {};

    for (const w of this.wallets) {
      walletBreakdown[w.id] = {
        label: w.label,
        positions: 0,
        invested: 0,
        current: 0,
      };
    }

    for (const pos of open) {
      const invested = pos.entryPriceSol * pos.tokenAmount;
      const current = pos.currentPriceSol * pos.tokenAmount;
      totalInvested += invested;
      totalCurrent += current;

      if (walletBreakdown[pos.walletId]) {
        walletBreakdown[pos.walletId].positions++;
        walletBreakdown[pos.walletId].invested += invested;
        walletBreakdown[pos.walletId].current += current;
      }
    }

    const totalPnl = totalCurrent - totalInvested;
    const pnlPct = totalInvested > 0 ? ((totalPnl / totalInvested) * 100) : 0;

    return {
      totalPositions: open.length,
      totalInvestedSol: totalInvested,
      totalCurrentSol: totalCurrent,
      totalPnlSol: totalPnl,
      totalPnlUsd: totalPnl * this.solPriceUsd,
      pnlPct,
      walletBreakdown,
      coldWalletAddress: this.coldWallet,
    };
  }

  formatPortfolio(pf) {
    let msg = `📊 PORTFOLIO DASHBOARD\n`;
    msg += `═══════════════════════\n`;
    msg += `Total invested:  ${pf.totalInvestedSol.toFixed(4)} SOL\n`;
    msg += `Current value:   ${pf.totalCurrentSol.toFixed(4)} SOL\n`;
    msg += `P&L:             ${pf.totalPnlSol >= 0 ? "+" : ""}${pf.totalPnlSol.toFixed(4)} SOL (~$${pf.totalPnlUsd.toFixed(2)})\n`;
    msg += `P&L %:           ${pf.pnlPct >= 0 ? "+" : ""}${pf.pnlPct.toFixed(1)}%\n`;
    msg += `Open positions:  ${pf.totalPositions}\n\n`;

    for (const [id, wb] of Object.entries(pf.walletBreakdown)) {
      if (wb.positions === 0) continue;
      const pnl = wb.current - wb.invested;
      msg += `💳 Wallet ${id} (${wb.label})\n`;
      msg += `   Positions: ${wb.positions} | ${wb.invested.toFixed(4)} → ${wb.current.toFixed(4)} SOL\n`;
      msg += `   P&L: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL\n\n`;
    }

    if (pf.coldWalletAddress) {
      msg += `🏦 Cold: ${pf.coldWalletAddress.slice(0, 8)}...`;
    }

    return msg;
  }

  // ═══════════════════════════════════════
  //  PERFORMANCE STATISTICS
  // ═══════════════════════════════════════

  getStats() {
    const trades = this.state.trades || [];
    if (trades.length === 0) return "📈 No completed trades yet.";

    const wins = trades.filter((t) => t.pnlSol > 0);
    const losses = trades.filter((t) => t.pnlSol <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnlSol, 0);
    const avgHoldMs = trades.reduce((s, t) => s + (t.exitTime - t.entryTime), 0) / trades.length;
    const best = trades.reduce((best, t) => (t.pnlSol > best.pnlSol ? t : best), trades[0]);
    const worst = trades.reduce((worst, t) => (t.pnlSol < worst.pnlSol ? t : worst), trades[0]);
    const avgPeakMult = trades.reduce((s, t) => s + t.peakMult, 0) / trades.length;

    // Simple Sharpe-like ratio
    const returns = trades.map((t) => t.pnlSol);
    const avgReturn = totalPnl / trades.length;
    const stdDev = Math.sqrt(
      returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / trades.length
    );
    const sharpe = stdDev > 0 ? (avgReturn / stdDev) : 0;

    // Format hold time
    const avgH = Math.floor(avgHoldMs / 3600000);
    const avgM = Math.floor((avgHoldMs % 3600000) / 60000);

    let msg = `📈 PERFORMANCE STATS\n`;
    msg += `═══════════════════════\n`;
    msg += `Total trades:    ${trades.length}\n`;
    msg += `Wins / Losses:   ${wins.length} / ${losses.length}\n`;
    msg += `Win rate:        ${((wins.length / trades.length) * 100).toFixed(1)}%\n`;
    msg += `Net P&L:         ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL (~$${(totalPnl * this.solPriceUsd).toFixed(2)})\n`;
    msg += `Avg hold:        ${avgH}h ${avgM}m\n`;
    msg += `Best trade:      ${best.pnlSol >= 0 ? "+" : ""}${best.pnlSol.toFixed(4)} SOL ($${best.symbol})\n`;
    msg += `Worst trade:     ${worst.pnlSol.toFixed(4)} SOL ($${worst.symbol})\n`;
    msg += `Avg entry→peak:  ${avgPeakMult.toFixed(2)}x\n`;
    msg += `Sharpe-like:     ${sharpe.toFixed(2)}\n`;

    // Mini ASCII chart
    if (trades.length > 1) {
      msg += `\n📊 Last 10 trades:\n`;
      const last10 = trades.slice(-10);
      for (const t of last10) {
        const bar = t.pnlSol >= 0
          ? `+${"█".repeat(Math.min(10, Math.round(t.pnlSol / (best.pnlSol || 1) * 10)))}`
          : `-${"░".repeat(Math.min(10, Math.round(Math.abs(t.pnlSol) / (Math.abs(worst.pnlSol) || 1) * 10)))}`;
        msg += `  ${t.pnlSol >= 0 ? "🟢" : "🔴"} $${t.symbol.slice(0, 5).padEnd(5)} ${bar} ${(t.exitMult || 0).toFixed(1)}x\n`;
      }
    }

    return msg;
  }

  // ═══════════════════════════════════════
  //  LADDER CONFIG
  // ═══════════════════════════════════════

  getLadder() {
    return this.state.settings.ladder;
  }

  setLadder(newLadder) {
    this.state.settings.ladder = newLadder;
    this.scheduleSave();
  }

  formatLadder() {
    const ladder = this.getLadder();
    let msg = `🪜 LADDER CONFIG\n`;
    msg += `═══════════════════════\n`;
    let totalSold = 0;
    for (const rung of ladder) {
      totalSold += rung.pct;
      msg += `  ${rung.mult}x → sell ${rung.pct}%\n`;
    }
    const moonBag = 100 - totalSold;
    msg += `  ────────────\n`;
    msg += `  🌙 Moon bag: ${moonBag}%\n\n`;
    msg += `Trailing: activates at ${this.state.settings.trailActivateX}x\n`;
    msg += `Trail gap: ${(this.state.settings.trailPct * 100).toFixed(0)}% below peak\n`;
    msg += `Stop loss: ${(this.state.settings.stopLossX * 100).toFixed(0)}%\n\n`;
    msg += `Use /ladder set 1.5:25 2:25 3:25 5:25 to customize`;
    return msg;
  }

  parseLadderString(str) {
    // Parse "1.5:25 2:25 3:25 5:25"
    try {
      const parts = str.trim().split(/\s+/);
      const newLadder = [];
      let totalPct = 0;

      for (const part of parts) {
        const [mult, pct] = part.split(":").map(Number);
        if (!mult || !pct || mult <= 0 || pct <= 0 || pct > 100) return null;
        newLadder.push({ mult, pct });
        totalPct += pct;
      }

      if (totalPct > 100 || newLadder.length === 0) return null;

      // Sort ascending by multiplier
      newLadder.sort((a, b) => a.mult - b.mult);
      return newLadder;
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════
  //  TELEGRAM COMMAND HANDLERS
  // ═══════════════════════════════════════

  registerHandlers(bot) {
    // /portfolio
    bot.onText(/\/portfolio/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const pf = await this.getPortfolio();
      this.send(this.formatPortfolio(pf));
    });

    // /stats
    bot.onText(/\/stats/, (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      this.send(this.getStats());
    });

    // /ladder (show)
    bot.onText(/\/ladder$/, (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      this.send(this.formatLadder());
    });

    // /ladder set ...
    bot.onText(/\/ladder set (.+)/, (msg, match) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const newLadder = this.parseLadderString(match[1]);
      if (!newLadder) {
        this.send("❌ Invalid format. Use: /ladder set 1.5:25 2:25 3:25 5:25");
        return;
      }
      this.setLadder(newLadder);
      this.send(`✅ Ladder updated!\n\n${this.formatLadder()}`);
    });

    // /ladder reset
    bot.onText(/\/ladder reset/, (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      this.setLadder(DEFAULT_SETTINGS.ladder);
      this.send(`✅ Ladder reset to default.\n\n${this.formatLadder()}`);
    });

    // /lock (quick status)
    bot.onText(/\/lock/, async (msg) => {
      if (msg.chat.id.toString() !== this.chatId) return;
      const open = Object.values(this.state.openPositions);
      if (open.length === 0) {
        this.send("🔒 No open positions to lock.");
        return;
      }
      let msg_text = `🔒 PROFIT LOCK STATUS\n`;
      for (const pos of open) {
        const mult = pos.currentPriceSol / pos.entryPriceSol;
        const status =
          mult >= this.state.settings.stopLossX ? "🟢" : "🔴";
        msg_text += `${status} $${pos.symbol} ${mult.toFixed(2)}x | sold ${pos.soldPct.toFixed(0)}% | moon bag ${pos.moonBagPct}%\n`;
      }
      this.send(msg_text);
    });

    console.log("[ProfitLocker] Telegram handlers registered");
  }

  // ═══════════════════════════════════════
  //  MESSAGING
  // ═══════════════════════════════════════

  send(msg) {
    console.log(`[ProfitLocker] ${msg}`);
    if (this.bot && this.chatId) {
      this.bot.sendMessage(this.chatId, msg).catch(() => {});
    }
  }
}

module.exports = ProfitLockerV3;
