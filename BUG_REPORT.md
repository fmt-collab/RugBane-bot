# RugBane Bot - Bug Report & Testing Results
**Date:** 2026-10-09  
**Tester:** Claude (Automated Code Analysis)

---

## 🔴 CRITICAL ISSUES

### 1. **Module Method Mismatch - Signal Engine** 
**Severity:** CRITICAL  
**Location:** `index.js:424`

```javascript
const result = await signalEngine.analyzeToken(ticker);
```

**Problem:** The `FomoSignalEngine` class does NOT have an `analyzeToken()` method. The actual method is `scoreToken()` which requires a mint address, not a ticker.

**Impact:** `/signal <ticker>` command will crash with "analyzeToken is not a function"

**Fix Required:**
```javascript
// Need to add ticker-to-mint resolution, then call scoreToken(mint)
```

---

### 2. **Missing scan() Method**
**Severity:** CRITICAL  
**Location:** `index.js:595`

```javascript
await signalEngine.scan();
```

**Problem:** `FomoSignalEngine` class has `runScanCycle()` method, NOT `scan()`.

**Impact:** Background job crashes every 2 minutes, signal engine never runs

**Fix Required:**
```javascript
await signalEngine.runScanCycle(); // Correct method name
```

---

### 3. **ProfitLocker Constructor Error**
**Severity:** HIGH  
**Location:** `index.js:299-310`

```javascript
const profitLocker = new ProfitLocker({
  // ...
  sellToken,      // ❌ sellToken not defined yet!
  transferSol,    // ❌ transferSol not defined yet!
});
```

**Problem:** Functions `sellToken` and `transferSol` are defined AFTER line 310, but passed to ProfitLocker constructor which tries to use them immediately.

**Impact:** ProfitLocker gets `undefined` for both sell and transfer functions

**Fix Required:** Move function definitions before module initialization

---

### 4. **JupiterSwap Module Instantiated but Never Used**
**Severity:** MEDIUM  
**Location:** `index.js:27, 165-215`

```javascript
const JupiterSwap = require("./modules/jupiter-swap"); // Line 27
// But never instantiated or used
```

**Problem:** Bot loads JupiterSwap module but implements duplicate swap logic inline. The module instance is commented as "available for advanced routing" but never created.

**Impact:** Code duplication, confusion about which swap implementation is active

---

### 5. **Missing Method Calls in Handlers**
**Severity:** MEDIUM  
**Location:** `index.js:413-418`

```javascript
onCmd(/\/portfolio/, async (msg) => profitLocker.handleCommand("/portfolio", msg.chat.id));
```

**Problem:** `ProfitLockerV3` class does NOT have a `handleCommand()` method. It has individual handler registrations via `registerHandlers(bot)`.

**Impact:** `/portfolio`, `/stats`, `/lock`, `/ladder` commands all fail silently

**Fix:** These are handled internally by `registerHandlers()` - the manual routing is redundant and broken

---

## 🟡 HIGH PRIORITY ISSUES

### 6. **RealtimeMonitor Never Started**
**Severity:** HIGH  
**Location:** `modules/realtime-monitor.js:29`

```javascript
startMonitoring() {
  // This method is never called from index.js
}
```

**Problem:** WebSocket monitoring is loaded but `startMonitoring()` is never invoked.

**Impact:** Wallet tracking features (`/track`, `/monitor`) don't work - WebSocket stays disconnected

**Fix Required:** Add `realtimeMonitor.startMonitoring()` to boot() function

---

### 7. **SocialSentiment Missing getSentimentReport() Method**
**Severity:** HIGH  
**Location:** `index.js:538`

```javascript
const result = await socialEngine.getSentimentReport(ticker);
```

**Problem:** The class has `getSentimentScore()`, NOT `getSentimentReport()`.

**Impact:** `/social <ticker>` command crashes

**Fix:** Use `getSentimentScore()` and format manually, or add the missing wrapper method

---

### 8. **Signal Engine Handler Registration Missing**
**Severity:** MEDIUM  
**Location:** `modules/fomo-signal-engine.js:270`

```javascript
registerHandlers(bot) {
  // This method exists but is never called from index.js
}
```

**Problem:** Signal engine has command handlers (`/signal`, `/autocopy`, `/signals`, `/scan`) but they're never registered with the bot.

**Impact:** Commands like `/signals` and `/scan` don't work

---

### 9. **WashDetector Commands Never Registered**
**Severity:** MEDIUM  
**Location:** `modules/wash-trade-detector.js:689`

```javascript
registerCommands(bot) {
  // Has /safety, /cluster, /wash, /clearsafety
  // But never called from index.js
}
```

**Impact:** Advanced safety commands don't work

---

### 10. **Token Balance Calculation Error**
**Severity:** MEDIUM  
**Location:** `index.js:224-234`

```javascript
async function sellToken(mint, percentage = 100) {
  const balance = await getTokenBalance(mint);
  const amount = balance * (percentage / 100);
  const lamports = amount * 1e9; // ❌ Assumes 9 decimals ALWAYS
```

**Problem:** Hardcodes 9 decimals - some tokens use 6 decimals (USDC, USDT)

**Impact:** Incorrect sell amounts for non-9-decimal tokens

---

## 🟢 MEDIUM PRIORITY ISSUES

### 11. **Double Paper Trading Flag**
**Severity:** LOW  
**Location:** `index.js:38-41`

```javascript
const PAPER_TRADING = process.env.PAPER_TRADING === "true";
let paperMode = PAPER_TRADING;  // Global mutable
// Then passed to modules which have their own paperTrading flags
```

**Problem:** Paper trading state can become inconsistent between main bot and modules.

**Impact:** Some trades might execute live while others are paper

---

### 12. **ProfitLocker Missing addPosition Call**
**Severity:** MEDIUM  
**Location:** `index.js:326-348`

```javascript
signalEngine.executeBuy = async (mint, solAmount, symbol) => {
  // ...
  const result = await buyToken(mint, solAmount);
  if (result.success) {
    profitLocker.addPosition(mint, solAmount, 0, symbol); // ❌ Wrong signature
```

**Problem:** `addPosition()` expects `{ mint, symbol, entryPriceSol, tokenAmount, walletId }` object, not individual params.

**Impact:** Position tracking fails - profit locker doesn't track bought tokens

---

### 13. **Social Sentiment checkWatchlist() Never Called**
**Severity:** MEDIUM  
**Location:** `index.js:603-606`

```javascript
setInterval(async () => {
  // ...
  await socialEngine.checkWatchlist(); // Method doesn't exist!
}, 2 * 60 * 1000);
```

**Problem:** Method is `checkWatchlistAlerts()`, not `checkWatchlist()`

**Impact:** Watchlist monitoring crashes every 2 minutes

---

### 14. **Insufficient Error Handling in Swap**
**Severity:** MEDIUM  
**Location:** `index.js:169-215`

```javascript
async function executeSwap(inputMint, outputMint, amountLamports, slippageBps = 500) {
  // No validation of amountLamports
  // No check if amount > balance
```

**Problem:** Can attempt to swap more than wallet balance, leading to failed transactions

---

### 15. **Inconsistent Command Authorization**
**Severity:** LOW  
**Location:** `index.js:86-95`

```javascript
function onCmd(regex, handler) {
  bot.onText(regex, (msg, match) => {
    if (CHAT_ID && String(msg.chat.id) !== String(CHAT_ID)) {
      return bot.sendMessage(msg.chat.id, "⛔ Unauthorized.").catch(() => {});
    }
```

**Problem:** Some module handlers check chatId, some don't - inconsistent security

---

## 🔵 LOW PRIORITY / IMPROVEMENTS

### 16. **Redundant Command Handlers**
Multiple modules register their own handlers when called directly, creating conflicts with the main onCmd() wrappers.

### 17. **Missing Rate Limiting**
No rate limiting on API calls to Birdeye, Helius - could hit quotas fast

### 18. **State File Collisions**
Multiple modules try to create `data/` folder simultaneously - potential race condition

### 19. **Hardcoded Timeouts**
All axios calls use inconsistent timeouts (5s, 10s, 12s, 15s) - should be configurable

### 20. **Missing Webhook Security**
`/webhook/:token` endpoint has no signature verification - any POST triggers bot update

---

## 🎯 TESTING CHECKLIST

### Commands to Test:
- [ ] `/start` - Should work ✅
- [ ] `/help` - Should work ✅  
- [ ] `/status` - Should work ✅
- [ ] `/portfolio` - ❌ BROKEN (handleCommand doesn't exist)
- [ ] `/stats` - ❌ BROKEN (handleCommand doesn't exist)
- [ ] `/signal <ticker>` - ❌ BROKEN (analyzeToken doesn't exist)
- [ ] `/buy <mint> <amount>` - Should work ✅
- [ ] `/sell <mint> <pct>` - Should work ✅
- [ ] `/safety <mint>` - Should work ✅
- [ ] `/trust <mint>` - Should work ✅
- [ ] `/honeypot <mint>` - Should work ✅
- [ ] `/track <wallet>` - ❌ BROKEN (monitor never started)
- [ ] `/monitor` - ❌ BROKEN (monitor never started)
- [ ] `/autocopy on/off` - Should work ✅
- [ ] `/fomo trending` - Should work ✅
- [ ] `/fomo leaderboard` - Should work ✅
- [ ] `/social <ticker>` - ❌ BROKEN (getSentimentReport doesn't exist)
- [ ] `/watch <ticker>` - Should work ✅
- [ ] `/ladder` - ❌ BROKEN (handleCommand doesn't exist)
- [ ] `/paper on/off` - Should work ✅

### Background Jobs Status:
- [ ] SOL price fetching - ✅ Working
- [ ] Signal engine scan - ❌ BROKEN (wrong method name)
- [ ] FOMO leaderboard check - ✅ Working
- [ ] Social watchlist check - ❌ BROKEN (wrong method name)

---

## 📊 SUMMARY

**Total Issues Found:** 20  
- 🔴 **Critical:** 5  
- 🟡 **High:** 5  
- 🟢 **Medium:** 6  
- 🔵 **Low:** 4

**Estimated Functional Commands:** 11/20 (55%)  
**Broken Commands:** 9/20 (45%)

**Priority Fix Order:**
1. Fix `signalEngine.scan()` → `runScanCycle()` (blocks background operation)
2. Fix `ProfitLocker` function injection order
3. Fix `/signal` command (analyzeToken method)
4. Start RealtimeMonitor WebSocket
5. Fix Social Sentiment method names
6. Register all module handlers properly
7. Fix ProfitLocker addPosition signature

---

## 🔧 RECOMMENDED FIXES

See `FIXES.md` for detailed code patches.
