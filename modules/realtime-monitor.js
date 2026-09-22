// ═══════════════════════════════════════════════════════════
//  REALTIME MONITOR
//  WebSocket alerts for wallet activity and new launches
// ═══════════════════════════════════════════════════════════

const WebSocket = require("ws");

class RealtimeMonitor {
  constructor(config = {}) {
    this.wsUrl = config.wsUrl || "";
    this.bot = config.telegramBot;
    this.chatId = config.chatId;
    this.trackedWallets = new Map();
    this.isMonitoring = false;
    this.ws = null;
    console.log("[RealtimeMonitor] Module loaded");
  }

  trackWallet(address, label = "Tracked") {
    this.trackedWallets.set(address, { label, alerts: 0 });
    console.log(`[Monitor] Tracking wallet: ${label} (${address.slice(0, 8)}...)`);
  }

  untrackWallet(address) {
    this.trackedWallets.delete(address);
    console.log(`[Monitor] Stopped tracking: ${address.slice(0, 8)}...`);
  }

  startMonitoring() {
    if (this.isMonitoring || !this.wsUrl) return;
    
    console.log("[Monitor] Starting WebSocket connection...");
    this.ws = new WebSocket(this.wsUrl);
    
    this.ws.on("open", () => {
      this.isMonitoring = true;
      console.log("[Monitor] Connected to realtime feed");
      this.subscribeToWallets();
    });

    this.ws.on("message", (data) => {
      this.handleMessage(JSON.parse(data.toString()));
    });

    this.ws.on("close", () => {
      this.isMonitoring = false;
      console.log("[Monitor] Disconnected — reconnecting in 5s...");
      setTimeout(() => this.startMonitoring(), 5000);
    });
  }

  subscribeToWallets() {
    // Helius or custom WebSocket subscription
    const addresses = Array.from(this.trackedWallets.keys());
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "subscribe",
        wallets: addresses,
      }));
    }
  }

  handleMessage(msg) {
    if (msg.type === "transaction" && msg.data) {
      const wallet = msg.data.wallet;
      if (this.trackedWallets.has(wallet)) {
        const info = this.trackedWallets.get(wallet);
        info.alerts++;
        this.sendAlert(wallet, info, msg.data);
      }
    }
  }

  async sendAlert(wallet, info, txData) {
    const text = `🚨 WALLET ALERT\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `Wallet: ${info.label}\n` +
      `Action: ${txData.action || "Trade"}\n` +
      `Token: ${txData.token || "?"}\n` +
      `Amount: ${txData.amount || "?"}\n` +
      `Tx: https://solscan.io/tx/${txData.signature || ""}`;

    if (this.bot && this.chatId) {
      await this.bot.sendMessage(this.chatId, text);
    }
  }

  getStatus() {
    const wallets = Array.from(this.trackedWallets.entries()).map(
      ([addr, info]) => `${info.label}: ${addr.slice(0, 6)}... (${info.alerts} alerts)`
    );
    return {
      connected: this.isMonitoring,
      tracking: wallets.length,
      wallets,
    };
  }
}

module.exports = RealtimeMonitor;
