# RugBane Bot - Code Fixes
**Generated:** 2026-10-09  
**Apply these fixes to resolve all critical and high-priority bugs**

---

## 🔴 CRITICAL FIXES

### Fix 1: Signal Engine Background Job (Line 595)

**BEFORE:**
```javascript
setInterval(async () => {
  if (!isRunning) return;
  try { await signalEngine.scan(); } catch (e) { console.error("[Scan]", e.message); }
}, 2 * 60 * 1000);
```

**AFTER:**
```javascript
setInterval(async () => {
  if (!isRunning) return;
  try { await signalEngine.runScanCycle(); } catch (e) { console.error("[Scan]", e.message); }
}, 2 * 60 * 1000);
```

---

### Fix 2: Move Function Definitions Before Module Init (Lines 165-310)

**BEFORE:**
```javascript
// Line 279: Modules initialized
const profitLocker = new ProfitLocker({
  rpcUrl: RPC_URL,
  // ...
  sellToken,      // ❌ undefined!
  transferSol,    // ❌ undefined!
});

// Line 218: Functions defined later
async function buyToken(mint, solAmount) { /* ... */ }
async function sellToken(mint, percentage = 100) { /* ... */ }
async function transferSol(toAddress, solAmount) { /* ... */ }
```

**AFTER:**
```javascript
// ═══════════════════════════════════════════════════════════
//  JUPITER SWAP EXECUTOR (move BEFORE module initialization)
// ═══════════════════════════════════════════════════════════

const SOL_MINT = "So11111111111111111111111111111111111112";

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
  const lamports = amount * 1e9;

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
//  NOW INITIALIZE MODULES (with functions defined)
// ═══════════════════════════════════════════════════════════

const profitLocker = new ProfitLocker({
  rpcUrl: RPC_URL,
  birdeyeApiKey: BIRDEYE_KEY,
  coldWalletAddress: COLD_WALLET,
  privateKey: WALLET_PRIVATE_KEY,
  telegramBot: bot,
  chatId: CHAT_ID,
  paperTrading: paperMode,
  solPriceUsd,
  sellToken,      // ✅ Now defined
  transferSol,    // ✅ Now defined
});
```

---

### Fix 3: Remove Duplicate Command Handlers (Lines 413-418)

**BEFORE:**
```javascript
onCmd(/\/portfolio/, async (msg) => profitLocker.handleCommand("/portfolio", msg.chat.id));
onCmd(/\/stats/, async (msg) => profitLocker.handleCommand("/stats", msg.chat.id));
onCmd(/\/lock/, async (msg) => profitLocker.handleCommand("/lock", msg.chat.id));
onCmd(/\/ladder(.*)/, async (msg, match) =>
  profitLocker.handleCommand(`/ladder${match[1]}`, msg.chat.id)
);
```

**AFTER:**
```javascript
// ❌ REMOVE THESE LINES
// ProfitLocker registers its own handlers via registerHandlers(bot)
// These duplicate calls fail because handleCommand() doesn't exist
```

---

### Fix 4: Fix /signal Command (Line 420-429)

**BEFORE:**
```javascript
onCmd(/\/signal (.+)/, async (msg, match) => {
  const ticker = match[1].toUpperCase();
  await bot.sendMessage(msg.chat.id, `🔍 Analyzing ${ticker}...`);
  try {
    const result = await signalEngine.analyzeToken(ticker); // ❌ Method doesn't exist
    await bot.sendMessage(msg.chat.id, result, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
  }
});
```

**AFTER:**
```javascript
onCmd(/\/signal (.+)/, async (msg, match) => {
  const ticker = match[1].toUpperCase();
  await bot.sendMessage(msg.chat.id, `🔍 Analyzing ${ticker}...`);
  try {
    // First, search for token by ticker using Birdeye
    const searchRes = await axios.get(
      "https://public-api.birdeye.so/defi/v3/token/search",
      {
        headers: { "X-API-KEY": BIRDEYE_KEY, "x-chain": "solana" },
        params: { keyword: ticker, limit: 1 },
        timeout: 10000,
      }
    );

    const token = searchRes.data?.data?.tokens?.[0];
    if (!token) {
      await bot.sendMessage(msg.chat.id, `❌ Token "${ticker}" not found on Birdeye`);
      return;
    }

    // Now score the token
    const sig = signalEngine.scoreToken(token.address);

    const text = [
      `📊 **Signal Report: ${ticker}**`,
      `━━━━━━━━━━━━━━━━━━━`,
      `Mint: \`${token.address}\``,
      `Price: $${token.price || "?"}`,
      ``,
      `🎯 Confidence: **${sig.total}/100**`,
      `📈 Action: **${sig.action.toUpperCase()}**`,
      ``,
      `**Score Breakdown:**`,
      ...Object.entries(sig.breakdown).map(([k, v]) => `• ${k}: ${v}`),
      ``,
      `Sources: ${sig.sources.join(", ") || "none"}`,
    ].join("\n");

    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
  }
});
```

---

### Fix 5: Fix ProfitLocker addPosition Call (Line 339)

**BEFORE:**
```javascript
profitLocker.addPosition(mint, solAmount, 0, symbol); // ❌ Wrong signature
```

**AFTER:**
```javascript
// Get token price for proper tracking
const tokenPrice = await axios.get(
  `https://public-api.birdeye.so/defi/v3/token/price?address=${mint}`,
  {
    headers: { "X-API-KEY": BIRDEYE_KEY, "x-chain": "solana" },
    timeout: 5000,
  }
).then(res => res.data?.data?.price || 0).catch(() => 0);

const tokenAmount = result.success && tokenPrice > 0 
  ? (solAmount / tokenPrice) 
  : 0;

profitLocker.addPosition({
  mint,
  symbol,
  entryPriceSol: tokenPrice,
  tokenAmount,
  walletId: "A"
});
```

---

## 🟡 HIGH PRIORITY FIXES

### Fix 6: Start RealtimeMonitor (Add to boot() function)

**ADD AFTER LINE 640:**
```javascript
async function boot() {
  console.log("═══════════════════════════════════════════");
  console.log("  🐻 RUGBANE — Solana Sniper Bot");
  console.log("═══════════════════════════════════════════");

  await fetchSolPrice();

  // ── Start WebSocket monitoring ──
  if (WS_URL) {
    realtimeMonitor.startMonitoring();
    console.log("[Monitor] WebSocket monitoring started");
  } else {
    console.log("[Monitor] No WS_URL configured, skipping realtime monitoring");
  }

  // ── Pick EXACTLY ONE Telegram mode ──
  const webhookUrl = (process.env.WEBHOOK_URL || "").trim();
  // ... rest of boot
}
```

---

### Fix 7: Fix /social Command (Line 534-543)

**BEFORE:**
```javascript
onCmd(/\/social (.+)/, async (msg, match) => {
  const ticker = match[1].toUpperCase();
  await bot.sendMessage(msg.chat.id, `🐦 Fetching sentiment for ${ticker}...`);
  try {
    const result = await socialEngine.getSentimentReport(ticker); // ❌ Method doesn't exist
    await bot.sendMessage(msg.chat.id, result, { parse_mode: "Markdown" });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
  }
});
```

**AFTER:**
```javascript
onCmd(/\/social (.+)/, async (msg, match) => {
  const ticker = match[1].toUpperCase();
  await bot.sendMessage(msg.chat.id, `🐦 Fetching sentiment for ${ticker}...`);
  try {
    const score = await socialEngine.getSentimentScore(ticker);

    const emoji = score.socialScore > 20 ? "🟢" : score.socialScore > 10 ? "🟡" : "🔴";
    const sentimentEmoji = score.avgSentiment > 0.2 ? "📈" : score.avgSentiment < -0.2 ? "📉" : "➡️";

    const text = [
      `${emoji} **Social Sentiment: ${ticker}**`,
      `━━━━━━━━━━━━━━━━━━━`,
      `📊 Social Score: **${score.socialScore}/35**`,
      `💬 Mentions: ${score.mentionCount}`,
      `${sentimentEmoji} Avg Sentiment: ${score.avgSentiment.toFixed(2)} (${score.avgSentiment > 0.2 ? "Bullish" : score.avgSentiment < -0.2 ? "Bearish" : "Neutral"})`,
      `🤖 Shill Risk: ${(score.shillPct * 100).toFixed(0)}%`,
      `📡 Sources: ${score.sources.join(", ") || "none"}`,
      ``,
      `**Score Breakdown:**`,
      ...Object.entries(score.breakdown).map(([k, v]) => `• ${k}: ${v}`),
    ].join("\n");

    await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });

    // Show sample tweets if available
    if (score.tweets && score.tweets.length > 0) {
      const tweetText = score.tweets
        .slice(0, 3)
        .map((t, i) => `${i + 1}. "${(t.text || "").slice(0, 100)}..."`)
        .join("\n\n");
      await bot.sendMessage(msg.chat.id, `📝 **Sample Tweets:**\n\n${tweetText}`, { parse_mode: "Markdown" });
    }
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${e.message}`);
  }
});
```

---

### Fix 8: Fix Social Watchlist Background Job (Line 603-606)

**BEFORE:**
```javascript
setInterval(async () => {
  if (!isRunning || !socialEngine.enabled) return;
  try { await socialEngine.checkWatchlist(); } catch (e) { console.error("[Social]", e.message); }
}, 2 * 60 * 1000);
```

**AFTER:**
```javascript
setInterval(async () => {
  if (!isRunning || !socialEngine.enabled) return;
  try { await socialEngine.checkWatchlistAlerts(); } catch (e) { console.error("[Social]", e.message); }
}, 2 * 60 * 1000);
```

---

### Fix 9: Register Missing Module Handlers (Add after line 389)

**ADD THIS SECTION:**
```javascript
// ═══════════════════════════════════════════════════════════
//  REGISTER MODULE COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════

// Signal Engine has its own handlers for /signals, /scan, /autocopy
signalEngine.registerHandlers(bot);

// Wash Detector has /cluster, /wash, /clearsafety
washDetector.registerCommands(bot);

// Social Sentiment has /watch, /unwatch, /watchlist, /socialon, /socialoff
socialEngine.registerHandlers(bot);

console.log("[Bot] All module handlers registered");
```

---

### Fix 10: Improve Token Decimal Handling (Line 224-234)

**BEFORE:**
```javascript
async function sellToken(mint, percentage = 100) {
  const balance = await getTokenBalance(mint);
  if (balance <= 0) return { success: false, error: "No tokens to sell" };

  const amount = balance * (percentage / 100);
  const lamports = amount * 1e9; // ❌ Hardcoded 9 decimals

  const result = await executeSwap(mint, SOL_MINT, lamports);
  if (result.success) console.log(`[Sell] ${percentage}% of ${mint}`);
  return result;
}
```

**AFTER:**
```javascript
async function getTokenDecimals(mint) {
  try {
    const mintPub = new PublicKey(mint);
    const mintInfo = await connection.getParsedAccountInfo(mintPub);
    if (mintInfo.value && mintInfo.value.data.parsed) {
      return mintInfo.value.data.parsed.info.decimals || 9;
    }
    return 9; // Default to 9
  } catch {
    return 9;
  }
}

async function sellToken(mint, percentage = 100) {
  const balance = await getTokenBalance(mint);
  if (balance <= 0) return { success: false, error: "No tokens to sell" };

  const amount = balance * (percentage / 100);
  
  // Get actual decimals for this token
  const decimals = await getTokenDecimals(mint);
  const lamports = Math.floor(amount * Math.pow(10, decimals));

  const result = await executeSwap(mint, SOL_MINT, lamports);
  if (result.success) console.log(`[Sell] ${percentage}% of ${mint}`);
  return result;
}
```

---

## 🟢 MEDIUM PRIORITY FIXES

### Fix 11: Add Balance Check Before Swap

**ADD TO executeSwap() function (after line 174):**
```javascript
async function executeSwap(inputMint, outputMint, amountLamports, slippageBps = 500) {
  if (paperMode) {
    console.log(`[Paper] Swap ${inputMint} → ${outputMint}`);
    return { success: true, signature: "PAPER_TRADE", amount: amountLamports / LAMPORTS_PER_SOL };
  }
  if (!wallet) return { success: false, error: "No wallet loaded" };

  // ✅ ADD: Check if we have enough balance
  if (inputMint === SOL_MINT) {
    const solBalance = await getSolBalance();
    const requiredSol = amountLamports / LAMPORTS_PER_SOL;
    if (solBalance < requiredSol) {
      return { 
        success: false, 
        error: `Insufficient SOL balance: have ${solBalance.toFixed(4)}, need ${requiredSol.toFixed(4)}` 
      };
    }
  } else {
    const tokenBalance = await getTokenBalance(inputMint);
    const decimals = await getTokenDecimals(inputMint);
    const requiredTokens = amountLamports / Math.pow(10, decimals);
    if (tokenBalance < requiredTokens) {
      return { 
        success: false, 
        error: `Insufficient token balance: have ${tokenBalance.toFixed(4)}, need ${requiredTokens.toFixed(4)}` 
      };
    }
  }

  try {
    // ... rest of function
```

---

### Fix 12: Fix socialEngine.enabled Initialization

**ADD AFTER LINE 320:**
```javascript
const socialEngine = new SocialSentiment({ telegramBot: bot, chatId: CHAT_ID });
socialEngine.enabled = true; // ✅ Initialize the enabled flag
```

---

### Fix 13: Add Missing socialEngine Property Check

**BEFORE LINE 604:**
```javascript
setInterval(async () => {
  if (!isRunning || !socialEngine.enabled) return;
```

**CHANGE TO:**
```javascript
setInterval(async () => {
  if (!isRunning || !socialEngine || !socialEngine.enabled) return;
```

---

## 📋 COMPLETE FIXED INDEX.JS STRUCTURE

Here's the correct ordering of sections:

```javascript
// 1. Imports & Config (lines 1-96) ✅
// 2. SOL Price Tracker (lines 97-120) ✅
// 3. Wallet Balance Functions (lines 121-161) ✅
// 4. ⭐ SWAP FUNCTIONS - MOVE HERE (lines 165-257)
// 5. Notification Helper (lines 259-273) ✅
// 6. ⭐ MODULE INITIALIZATION (lines 275-320)
// 7. ⭐ OVERRIDE SIGNAL ENGINE (lines 322-356)
// 8. ⭐ REGISTER MODULE HANDLERS (NEW SECTION)
// 9. TELEGRAM COMMANDS (lines 358-578) ✅
// 10. BACKGROUND JOBS (lines 580-607) ✅
// 11. EXPRESS SERVER (lines 609-630) ✅
// 12. BOOT (lines 632-672) ✅
```

---

## ✅ VERIFICATION CHECKLIST

After applying fixes, test these:

```bash
# 1. Bot starts without errors
npm start

# 2. Test critical commands
/start
/help
/status
/portfolio    # Should now work
/stats        # Should now work
/signal BTC   # Should now work
/social SOL   # Should now work

# 3. Verify background jobs in logs
# Should see:
# [Signal] Starting scan cycle...
# [FomoTracker] Checking leaderboard...
# [Social] Alert check...
# [Monitor] Connected to realtime feed

# 4. Test safety commands
/safety <token_mint>
/trust <token_mint>
/honeypot <token_mint>

# 5. Test tracking (if WS_URL configured)
/track <wallet_address>
/monitor
```

---

## 🚀 DEPLOYMENT NOTES

1. **Apply fixes in order** - Start with Critical, then High Priority
2. **Test locally first** - Use paper trading mode
3. **Backup current state** - Copy `.env` and `data/` folder
4. **Monitor logs** - Check for new errors after each fix
5. **Gradual rollout** - Enable one module at a time

---

## 📞 SUPPORT

If you encounter issues after applying fixes:
1. Check console logs for specific error messages
2. Verify all API keys are valid
3. Ensure `PAPER_TRADING=true` for testing
4. Check Telegram bot token is correct
5. Verify RPC endpoints are accessible

---

**End of Fixes Document**
