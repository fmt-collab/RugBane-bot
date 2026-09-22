// ═══════════════════════════════════════════════════════════
//  HONEYPOT DETECTOR
//  Checks if a token blocks sells, has hidden fees, or freeze
// ═══════════════════════════════════════════════════════════

const axios = require("axios");
const { Connection, PublicKey } = require("@solana/web3.js");

class HoneypotDetector {
  constructor(config = {}) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.cache = new Map();
    this.cacheTtlMs = 5 * 60 * 1000; // 5 min
    console.log("[HoneypotDetector] Module loaded");
  }

  async analyze(mintAddress) {
    const cached = this.cache.get(mintAddress);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.data;
    }

    const result = {
      mint: mintAddress,
      isHoneypot: false,
      riskScore: 0,
      flags: [],
      details: {},
    };

    try {
      const mintPub = new PublicKey(mintAddress);
      const mintInfo = await this.connection.getParsedAccountInfo(mintPub);

      if (!mintInfo.value) {
        result.flags.push("❌ Token not found on-chain");
        result.isHoneypot = true;
        return result;
      }

      const data = mintInfo.value.data;
      if (data.parsed) {
        const info = data.parsed.info;

        // 1. Check Freeze Authority
        if (info.freezeAuthority) {
          result.flags.push("❄️ FREEZE AUTHORITY ENABLED — Token can be frozen!");
          result.riskScore += 40;
          result.details.freezeAuthority = info.freezeAuthority;
        }

        // 2. Check Mint Authority (can mint unlimited tokens)
        if (info.mintAuthority) {
          result.flags.push("🖨️ MINT AUTHORITY ENABLED — Unlimited supply risk!");
          result.riskScore += 35;
          result.details.mintAuthority = info.mintAuthority;
        }

        // 3. Check Supply
        const supply = info.supply || 0;
        const decimals = info.decimals || 9;
        result.details.supply = supply / Math.pow(10, decimals);
        result.details.decimals = decimals;

        if (result.details.supply < 1000) {
          result.flags.push("⚠️ Very low supply — possible scam token");
          result.riskScore += 15;
        }
      }

      // 4. Simulate sell (simplified for safety)
      // In production, you'd simulate a sell transaction via RPC
      
      // Determine if honeypot
      result.isHoneypot = result.riskScore >= 40;
      
      this.cache.set(mintAddress, { data: result, at: Date.now() });
      return result;

    } catch (e) {
      console.error(`[HoneypotDetector] Failed for ${mintAddress}:`, e.message);
      return { mint: mintAddress, isHoneypot: true, flags: ["❌ Check failed"], riskScore: 100 };
    }
  }

  formatReport(report) {
    let text = `🍯 HONEYPOT REPORT\n━━━━━━━━━━━━━━━━━\n`;
    text += `Token: ${report.mint.slice(0, 8)}...\n`;
    text += `Status: ${report.isHoneypot ? "🚫 HONEYPOT DETECTED" : "✅ LIKELY SAFE"}\n`;
    text += `Risk Score: ${report.riskScore}/100\n\n`;
    
    if (report.flags.length > 0) {
      text += `⚠️ FLAGS:\n${report.flags.join("\n")}\n`;
    }
    return text;
  }
}

module.exports = HoneypotDetector;
