// ═══════════════════════════════════════════════════════════
//  RUGCHECK MODULE
//  Token safety checks via RugCheck.xyz API
// ═══════════════════════════════════════════════════════════

const axios = require("axios");

class RugCheck {
  constructor() {
    this.baseUrl = "https://api.rugcheck.xyz/v1/tokens";
    this.cache = new Map();
    this.cacheTtlMs = 10 * 60 * 1000; // 10 min cache
    console.log("[RugCheck] Module loaded");
  }

  async inspect(mint) {
    // Check cache first
    const cached = this.cache.get(mint);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.data;
    }

    try {
      const { data } = await axios.get(
        `${this.baseUrl}/${mint}/report`,
        { timeout: 10000 }
      );

      const result = {
        mint,
        symbol: data.token?.symbol || "?",
        name: data.token?.name || "?",
        riskLevel: data.riskLevel || "UNKNOWN",
        score: data.score || 0,
        mintAuthority: data.tokenMeta?.mintAuthority || null,
        freezeAuthority: data.tokenMeta?.freezeAuthority || null,
        risks: (data.risks || []).map(r => ({
          name: r.name,
          level: r.level,
          description: r.description,
        })),
        topHolders: (data.topHolders || []).slice(0, 10),
        liquidityUsd: data.totalMarketLiquidity || 0,
        markets: data.markets || [],
        pass: false,
        flags: [],
      };

      // Check dangers
      const dangerRisks = result.risks.filter(r => r.level === "danger");
      const hasFreeze = !!result.freezeAuthority;
      const hasMint = !!result.mintAuthority;

      // Build flags
      if (hasFreeze) result.flags.push("❄️ Freeze authority — can lock your tokens!");
      if (hasMint) result.flags.push("🖨️ Mint authority — unlimited supply risk!");
      if (dangerRisks.length > 0) {
        dangerRisks.forEach(r => result.flags.push(`⚠️ ${r.name}: ${r.description}`));
      }
      if (result.liquidityUsd < 5000) result.flags.push("💧 Low liquidity");

      // Top holder concentration
      const topHolderPct = result.topHolders.slice(0, 5).reduce((sum, h) => sum + (h.pct || 0), 0);
      if (topHolderPct > 50) result.flags.push(`🐋 Top 5 hold ${topHolderPct.toFixed(1)}%`);

      // Pass/fail
      result.pass =
        dangerRisks.length === 0 &&
        !hasFreeze &&
        !hasMint &&
        result.riskLevel !== "CRITICAL" &&
        result.riskLevel !== "HIGH";

      // Cache it
      this.cache.set(mint, { data: result, at: Date.now() });
      return result;

    } catch (e) {
      console.error(`[RugCheck] Failed for ${mint}:`, e.message);
      return {
        mint,
        pass: false,
        score: 0,
        riskLevel: "UNKNOWN",
        risks: [],
        flags: ["❌ RugCheck API unavailable"],
      };
    }
  }

  formatReport(report) {
    let text = `🛡️ RUGCHECK REPORT\n`;
    text += `━━━━━━━━━━━━━━━━━\n`;
    text += `Token: ${report.symbol} (${report.name})\n`;
    text += `Mint: ${report.mint}\n\n`;

    // Risk level with emoji
    const riskEmoji = {
      GOOD: "🟢", LOW: "🟢", MEDIUM: "🟡", HIGH: "🔴", CRITICAL: "🔴", UNKNOWN: "⚪"
    };
    text += `${riskEmoji[report.riskLevel] || "⚪"} Risk: ${report.riskLevel}\n`;
    text += `📊 Score: ${report.score}/100\n`;
    text += `💧 Liquidity: $${(report.liquidityUsd || 0).toLocaleString()}\n`;
    text += `✅ Pass: ${report.pass ? "YES — Safe to trade" : "NO — Be careful!"}\n`;

    // Flags
    if (report.flags.length > 0) {
      text += `\n⚠️ FLAGS:\n`;
      report.flags.forEach(f => text += `  ${f}\n`);
    }

    // Risks
    if (report.risks.length > 0) {
      text += `\n📋 RISKS:\n`;
      report.risks.forEach(r => {
        const emoji = r.level === "danger" ? "🔴" : r.level === "warn" ? "🟡" : "ℹ️";
        text += `  ${emoji} ${r.name}: ${r.description}\n`;
      });
    }

    // Top holders
    if (report.topHolders.length > 0) {
      text += `\n🐋 TOP HOLDERS:\n`;
      report.topHolders.slice(0, 5).forEach((h, i) => {
        text += `  ${i + 1}. ${(h.pct || 0).toFixed(2)}%\n`;
      });
    }

    return text;
  }
}

module.exports = RugCheck;
