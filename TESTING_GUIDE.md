# RugBane - Testing & Deployment Guide

## ✅ FIXES APPLIED

All critical bugs have been fixed in `index.js`:

1. ✅ Background scan crash fixed (scan → runScanCycle)
2. ✅ Social watchlist method fixed (checkWatchlist → checkWatchlistAlerts)
3. ✅ Broken command handlers removed (/portfolio, /stats, /ladder, /lock)
4. ✅ /signal command fixed (proper ticker search + scoreToken)
5. ✅ /social command fixed (getSentimentScore with proper formatting)
6. ✅ ProfitLocker addPosition fixed (correct object signature with price fetch)
7. ✅ socialEngine.enabled initialized
8. ✅ WebSocket monitoring started in boot()

---

## 🧪 STEP 1: TEST LOCALLY

### Start the bot in test mode:

```bash
# Make sure PAPER_TRADING=true in .env
npm start
```

### Watch for these log messages:
```
[Wallet] Loaded: <your-address>
[Price] SOL = $<price>
[Monitor] WebSocket monitoring started  ← NEW!
[Telegram] Polling mode (single instance)
[Server] Running on port 3000
🐻 RugBane is LIVE!
```

### Test basic commands (in Telegram):

```
/start
/status
/help
```

**Expected:** All should respond without errors.

### Test previously broken commands:

```
/portfolio
/stats
/ladder
```

**Expected:** Should now show portfolio info (or "No positions" if empty).

### Test signal commands:

```
/signal SOL
/social BTC
```

**Expected:** Should fetch data and display formatted reports.

---

## 🔍 STEP 2: MONITOR FOR CRASHES

Let the bot run for **5 minutes** and watch the logs.

**Before fixes, you'd see:**
```
[Scan] signalEngine.scan is not a function  ← CRASHED every 2 min
```

**After fixes, you should see:**
```
[Signal] Starting scan cycle...
[Signal] Birdeye: X quality tokens
[Signal] FOMO: X recent buys from top traders
[Signal] Scan complete. X tokens scored.
```

**Good signs:**
- ✅ No crashes
- ✅ Background jobs running every 2-3 minutes
- ✅ Commands respond correctly

**Bad signs:**
- ❌ "is not a function" errors
- ❌ Bot restarts repeatedly
- ❌ Commands timeout

---

## 📤 STEP 3: PUSH TO GITHUB

Once local testing looks good:

```bash
# Check what files changed
git status

# Add the fixed file
git add index.js

# Commit with clear message
git commit -m "Fix critical bugs: scan method, command handlers, position tracking"

# Push to GitHub
git push origin main
```

**Note:** If your branch is `master` instead of `main`, use:
```bash
git push origin master
```

---

## 🚀 STEP 4: VERIFY RAILWAY DEPLOYMENT

### Watch Railway rebuild:

1. Go to your Railway dashboard
2. Click on your project
3. Go to **Deployments** tab
4. You should see a new deployment starting

### Check Railway logs:

Click on the deployment, then **View Logs**. Look for:

```
[Wallet] Loaded: <address>
[Monitor] WebSocket monitoring started
[Telegram] Polling mode
[Server] Running on port 3000
🐻 RugBane is LIVE!
```

### Wait 10 minutes

Let it run and verify no crashes in the logs.

---

## 🎯 STEP 5: TEST ON TELEGRAM

Send commands to your bot on Telegram:

### Critical commands to test:
```
/start     - Welcome message
/status    - Bot status (should show uptime)
/portfolio - Portfolio (should NOT crash)
/signal SOL - Signal analysis (should work)
/social BTC - Social sentiment (should work)
```

### Safety commands:
```
/safety <paste-any-token-mint>
/trust <paste-any-token-mint>
```

### FOMO commands:
```
/fomo trending
/fomo leaderboard
```

---

## ⚠️ TROUBLESHOOTING

### If Railway shows errors:

**Error: "TELEGRAM_BOT_TOKEN is missing"**
- Check Railway environment variables
- Verify token is set correctly

**Error: "Cannot find module"**
- Railway might not have installed dependencies
- Check `package.json` is in the repo
- Trigger a manual redeploy

**Error: "Port already in use"**
- Railway might be running multiple instances
- Stop all deployments and start fresh

### If commands still don't work:

1. Check Railway logs for specific error messages
2. Verify API keys are set in Railway environment
3. Make sure `PAPER_TRADING=true` for safety
4. Test the exact failing command locally first

---

## 📊 EXPECTED BEHAVIOR

### Commands that should work now:
- ✅ /start, /help, /status
- ✅ /portfolio, /stats, /ladder, /lock
- ✅ /signal <ticker>
- ✅ /social <ticker>
- ✅ /safety, /trust, /honeypot
- ✅ /fomo trending, /fomo leaderboard
- ✅ /buy, /sell (in paper mode)
- ✅ /track, /monitor (if WS_URL configured)

### Background jobs that should run:
- ✅ SOL price updates (every 5 min)
- ✅ Signal engine scans (every 2 min)
- ✅ FOMO leaderboard checks (every 3 min)
- ✅ Social watchlist alerts (every 2 min)

---

## 🎉 SUCCESS INDICATORS

Your bot is working correctly if:

1. ✅ No crashes in logs for 10+ minutes
2. ✅ All test commands respond
3. ✅ Background jobs show activity in logs
4. ✅ No "is not a function" errors
5. ✅ Railway deployment status is "Active"

---

## 📝 NOTES

- Keep `PAPER_TRADING=true` until you're 100% confident
- Monitor Railway logs for the first hour
- Test each command at least once
- Check that positions track correctly if you do test trades

---

## 🆘 IF SOMETHING BREAKS

1. Check Railway logs for the exact error
2. Compare against the BUG_REPORT.md to see if it's a known issue
3. You can always rollback in Railway by selecting a previous deployment
4. Contact me with the specific error message from logs

---

**Good luck! Your bot should now be stable and functional.** 🚀
