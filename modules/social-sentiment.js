// ═══════════════════════════════════════════════════════════
//  SOCIAL SENTIMENT ENGINE
//  Twitter/X + LunarCrush → Crypto-aware VADER → Confidence Score
// ═══════════════════════════════════════════════════════════

const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ── Crypto-Enhanced VADER (inline) ──
const CRYPTO_LEXICON = {
  // Bullish
  moon: 2.5, gem: 2.2, ape: 1.8, wagmi: 2.0, based: 2.0,
  pamp: 2.3, hodl: 1.8, ser: 0.8, gm: 1.0, fast: 1.2,
  rarer: 2.5, sending: 2.0, rocket: 2.2, pump: 1.8, bull: 1.5,
  breakout: 2.0, early: 1.5, alpha: 2.0, degen: 1.0,
  // Bearish
  rug: -3.0, rekt: -2.8, scam: -3.0, honeypot: -3.0,
  fud: -1.5, dump: -2.5, exit: -1.8, rugged: -3.0,
  ngmi: -2.0, sell: -1.2, dead: -2.0, pull: -1.5,
  drained: -2.5,
};

class VADERCrypto {
  constructor() {
    this.lexicon = { ...CRYPTO_LEXICON };
  }

  score(text) {
    const words = text
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/);

    let sum = 0;
    let count = 0;

    for (const word of words) {
      if (this.lexicon[word] !== undefined) {
        sum += this.lexicon[word];
        count++;
      }
    }

    const raw = count > 0 ? sum / count : 0;
    const compound = Math.tanh(raw * 0.5);

    let sentiment = "neutral";
    if (compound > 0.2) sentiment = "bullish";
    else if (compound < -0.2) sentiment = "bearish";

    return { compound, sentiment };
  }
}

// ═══════════════════════════════════════════════════════════
//  MAIN CLASS
// ═══════════════════════════════════════════════════════════

class SocialSentiment {
  constructor(config = {}) {
    // ── API Keys (try in priority order) ──
    this.twitterBearer = config.twitterBearerToken || process.env.TWITTER_BEARER_TOKEN || "";
    this.apifyToken = config.apifyToken || process.env.APIFY_API_KEY || "";
    this.lunarcrushKey = config.lunarcrushKey || process.env.LUNARCRUSH_API_KEY || "";
    this.openaiKey = config.openaiApiKey || process.env.OPENAI_API_KEY || "";

    // ── Telegram ──
    this.bot = config.telegramBot;
    this.chatId = config.chatId;

    // ── Sentiment engine ──
    this.vader = new VADERCrypto();

    // ── Config ──
    this.config = {
      maxTweetsPerQuery: 20,
      pollIntervalMs: 120_000,   // 2 minutes
      cacheHotTtlMs: 120_000,    // 2 min
      cacheColdTtlMs: 900_000,   // 15 min
      watchlist: new Map(),       // ticker -> { alertThreshold, created }
      minMentionsForSignal: 5,
      maxShillPct: 0.40,         // >40% shill → cap score at 35
    };

    // ── State ──
    this.cache = new Map();       // ticker -> { data, at }
    this.shillAccounts = new Set();
    this.alertHistory = new Map();

    // ── Thresholds for signal engine ──
    this.thresholds = {
      minSocialScoreForBuy: 30,   // minimum social score to contribute
      maxSocialScore: 35,         // cap individual social contribution
    };

    console.log("[SocialSentiment] Initialized");
    this.printSourceStatus();
  }

  printSourceStatus() {
    const sources = [];
    if (this.twitterBearer) sources.push("Twitter API v2 ✓");
    if (this.apifyToken) sources.push("Apify Scraper ✓");
    if (this.lunarcrushKey) sources.push("LunarCrush ✓");
    if (this.openaiKey) sources.push("OpenAI Analysis ✓");
    console.log(`[SocialSentiment] Sources: ${sources.length > 0 ? sources.join(", ") : "NONE — add API keys"}`);
  }

  // ══════════════════════════════════════════════════════
  //  1. TWITTER API v2 (pay-per-use)
  // ══════════════════════════════════════════════════════

  async fetchTwitterPPU(query, maxResults = 20) {
    if (!this.twitterBearer) return null;

    try {
      const searchQuery = `${query} -is:retweet lang:en`;
      const res = await axios.get(
        "https://api.twitter.com/2/tweets/search/recent",
        {
          headers: { Authorization: `Bearer ${this.twitterBearer}` },
          params: {
            query: searchQuery,
            max_results: Math.min(maxResults, 100),
            "tweet.fields": "created_at,public_metrics,author_id,text",
            expansions: "author_id",
            "user.fields": "created_at,public_metrics,verified",
          },
          timeout: 10000,
        }
      );

      const tweets = res.data?.data || [];
      const users = res.data?.includes?.users || [];
      const userMap = new Map(users.map((u) => [u.id, u]));

      return tweets.map((t) => ({
        text: t.text,
        author: userMap.get(t.author_id),
        metrics: t.public_metrics,
        createdAt: t.created_at,
        source: "twitter_ppu",
      }));
    } catch (e) {
      console.error("[Social] Twitter PPU failed:", e.message);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════
  //  2. APIFY SCRAPER (cheaper alternative)
  // ══════════════════════════════════════════════════════

  async fetchApify(query, maxResults = 20) {
    if (!this.apifyToken) return null;

    try {
      // Run Apify Twitter scraper actor
      const runRes = await axios.post(
        "https://api.apify.com/v2/acts/trudax~twitter-scraper/runs",
        {
          searchTerms: [query],
          maxTweets: maxResults,
          sort: "Latest",
        },
        {
          params: { token: this.apifyToken },
          timeout: 30000,
        }
      );

      const runId = runRes.data?.data?.id;
      if (!runId) return null;

      // Wait for completion (max 30s)
      let status = "RUNNING";
      let attempts = 0;
      while (status === "RUNNING" && attempts < 6) {
        await new Promise((r) => setTimeout(r, 5000));
        const statusRes = await axios.get(
          `https://api.apify.com/v2/actor-runs/${runId}`,
          { params: { token: this.apifyToken }, timeout: 10000 }
        );
        status = statusRes.data?.data?.status;
        attempts++;
      }

      if (status !== "SUCCEEDED") return null;

      // Fetch results
      const datasetId = runRes.data?.data?.defaultDatasetId;
      const resultsRes = await axios.get(
        `https://api.apify.com/v2/datasets/${datasetId}/items`,
        { params: { token: this.apifyToken, limit: maxResults }, timeout: 10000 }
      );

      const tweets = resultsRes.data || [];
      return tweets.map((t) => ({
        text: t.full_text || t.text || "",
        author: { username: t.user?.screen_name, followers: t.user?.followers_count },
        metrics: { like_count: t.favorite_count, retweet_count: t.retweet_count },
        createdAt: t.created_at,
        source: "apify",
      }));
    } catch (e) {
      console.error("[Social] Apify failed:", e.message);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════
  //  3. LUNARCRUSH (free tier)
  // ══════════════════════════════════════════════════════

  async fetchLunarCrush(ticker) {
    if (!this.lunarcrushKey) return null;

    try {
      const res = await axios.get(
        `https://lunarcrush.com/api/v4/coins/${ticker}/v2`,
        {
          headers: { Authorization: `Bearer ${this.lunarcrushKey}` },
          timeout: 10000,
        }
      );

      const coin = res.data?.data;
      if (!coin) return null;

      return {
        socialScore: coin.social_score || 0,
        socialVolume: coin.social_volume || 0,
        socialDominance: coin.social_dominance || 0,
        sentimentBullish: coin.sentiment_bullish || 0,
        sentimentBearish: coin.sentiment_bearish || 0,
        socialContributors: coin.social_contributors || 0,
        galaxyScore: coin.galaxy_score || 0,
        source: "lunarcrush",
      };
    } catch (e) {
      console.error("[Social] LunarCrush failed:", e.message);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════
  //  4. ANTI-SHILL DETECTION
  // ══════════════════════════════════════════════════════

  analyzeShillRisk(tweets) {
    if (!tweets || tweets.length === 0) return { shillPct: 0, flagged: [] };

    let shillCount = 0;
    const flagged = [];

    for (const tweet of tweets) {
      const author = tweet.author || {};
      const text = (tweet.text || "").toLowerCase();

      // Check 1: Low followers but high mention count
      if (author.followers && author.followers < 100) {
        shillCount++;
        flagged.push({ type: "low_followers", text: tweet.text?.slice(0, 60) });
        continue;
      }

      // Check 2: New account (< 90 days)
      if (author.createdAt) {
        const age = Date.now() - new Date(author.createdAt).getTime();
        if (age < 90 * 24 * 60 * 60 * 1000) {
          shillCount++;
          flagged.push({ type: "new_account", text: tweet.text?.slice(0, 60) });
          continue;
        }
      }

      // Check 3: Repetitive phrases (copy-paste army)
      const spamPhrases = [
        "not financial advice",
        "1000x gem",
        "early entry",
        "next shib",
        "dont miss",
        "guaranteed",
        "dm for alpha",
        "whitelist open",
      ];
      if (spamPhrases.some((p) => text.includes(p))) {
        shillCount++;
        flagged.push({ type: "spam_phrase", text: tweet.text?.slice(0, 60) });
        continue;
      }

      // Check 4: All caps + excessive emojis
      const capsRatio = (tweet.text || "").replace(/[^A-Z]/g, "").length / (tweet.text || "").length;
      const emojiCount = (tweet.text || "").match(/[\u{1F600}-\u{1F9FF}]/gu)?.length || 0;
      if (capsRatio > 0.7 && emojiCount > 3) {
        shillCount++;
        flagged.push({ type: "shouting", text: tweet.text?.slice(0, 60) });
      }
    }

    return {
      shillPct: tweets.length > 0 ? shillCount / tweets.length : 0,
      flagged: flagged.slice(0, 5),
    };
  }

  // ══════════════════════════════════════════════════════
  //  5. COMBINED SENTIMENT SCORE
  // ══════════════════════════════════════════════════════

  async getSentimentScore(ticker, mintAddress = null) {
    // Check cache
    const cached = this.cache.get(ticker);
    if (cached && Date.now() - cached.at < this.config.cacheColdTtlMs) {
      return { ...cached.data, cached: true };
    }

    const result = {
      ticker,
      mint: mintAddress,
      socialScore: 0,
      mentionCount: 0,
      avgSentiment: 0,
      shillPct: 0,
      sources: [],
      tweets: [],
      lunarcrush: null,
      breakdown: {},
      timestamp: Date.now(),
    };

    // Fetch from all available sources
    const [tweets, lunar] = await Promise.allSettled([
      this.fetchTwitterPPU(`${ticker} solana crypto`).then((r) =>
        r || this.fetchApify(`${ticker} solana crypto`)
      ),
      this.fetchLunarCrush(ticker),
    ]);

    // Process tweets
    const tweetList = tweets.status === "fulfilled" ? tweets.value : [];
    if (tweetList && tweetList.length > 0) {
      result.sources.push("twitter");
      result.mentionCount = tweetList.length;
      result.tweets = tweetList.slice(0, 10);

      // VADER sentiment on each tweet
      let sentimentSum = 0;
      for (const tweet of tweetList) {
        const { compound } = this.vader.score(tweet.text || "");
        sentimentSum += compound;
      }
      result.avgSentiment = sentimentSum / tweetList.length;

      // Anti-shill
      const shill = this.analyzeShillRisk(tweetList);
      result.shillPct = shill.shillPct;
      result.shillFlagged = shill.flagged;

      // Tweet volume score (0-10)
      result.breakdown.tweetVolume = Math.min(10, Math.floor(tweetList.length / 2));

      // Sentiment polarity score (0-10)
      result.breakdown.sentimentPolarity = Math.round(
        Math.max(0, (result.avgSentiment + 1) * 5)
      );
    }

    // Process LunarCrush
    if (lunar.status === "fulfilled" && lunar.value) {
      result.sources.push("lunarcrush");
      result.lunarcrush = lunar.value;

      result.breakdown.lunarCrush = Math.min(10, Math.floor(lunar.value.socialScore / 10));
    }

    // Calculate total social score (0-35)
    let rawScore = Object.values(result.breakdown).reduce((s, v) => s + v, 0);

    // Anti-shill penalty
    if (result.shillPct > this.config.maxShillPct) {
      const penalty = Math.floor((result.shillPct - this.config.maxShillPct) * 50);
      rawScore = Math.min(rawScore, 35 - penalty);
      result.breakdown.shillPenalty = -penalty;
    }

    // Clamp
    result.socialScore = Math.max(0, Math.min(35, rawScore));

    // Cache
    this.cache.set(ticker, { data: result, at: Date.now() });
    return result;
  }

  // ══════════════════════════════════════════════════════
  //  6. FOR SIGNAL ENGINE INTEGRATION
  // ══════════════════════════════════════════════════════

  async getSocialContribution(ticker, mintAddress = null) {
    const score = await this.getSentimentScore(ticker, mintAddress);

    // Normalize for signal engine (max 15 points)
    let contribution = Math.floor(score.socialScore * 15 / 35);

    // Apply minimum threshold
    if (contribution < this.thresholds.minSocialScoreForScore) {
      contribution = 0;
    }

    // Cap
    contribution = Math.min(contribution, this.thresholds.maxSocialScore);

    return {
      points: contribution,
      socialScore: score.socialScore,
      mentionCount: score.mentionCount,
      avgSentiment: score.avgSentiment,
      shillPct: score.shillPct,
      sources: score.sources,
      cached: score.cached || false,
    };
  }

  // ══════════════════════════════════════════════════════
  //  7. TELEGRAM COMMANDS
  // ══════════════════════════════════════════════════════

  registerHandlers(bot) {
    // /social <ticker> — Full sentiment report
    bot.onText(/\/social (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const ticker = match[1].trim().toUpperCase();

      await bot.sendMessage(chatId, `🐦 Fetching sentiment for ${ticker}...`);

      try {
        const score = await this.getSentimentScore(ticker);

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

        await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });

        // Show sample tweets if available
        if (score.tweets && score.tweets.length > 0) {
          const tweetText = score.tweets
            .slice(0, 3)
            .map((t, i) => `${i + 1}. "${(t.text || "").slice(0, 100)}..."`)
            .join("\n\n");
          await bot.sendMessage(chatId, `📝 **Sample Tweets:**\n\n${tweetText}`, { parse_mode: "Markdown" });
        }
      } catch (e) {
        await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
      }
    });

    // /watch <ticker> — Add to sentiment watchlist
    bot.onText(/\/watch (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      const ticker = match[1].trim().toUpperCase();
      this.config.watchlist.set(ticker, { created: Date.now() });
      bot.sendMessage(chatId, `👁️ Added ${ticker} to sentiment watchlist`);
    });

    // /unwatch <ticker>
    bot.onText(/\/unwatch (.+)/, (msg, match) => {
      const chatId = msg.chat.id;
      const ticker = match[1].trim().toUpperCase();
      this.config.watchlist.delete(ticker);
      bot.sendMessage(chatId, `🚫 Removed ${ticker} from watchlist`);
    });

    // /watchlist
    bot.onText(/\/watchlist/, (msg) => {
      const chatId = msg.chat.id;
      const list = Array.from(this.config.watchlist.keys());
      if (list.length === 0) {
        bot.sendMessage(chatId, "No tokens in watchlist. Use /watch <ticker> to add.");
        return;
      }
      bot.sendMessage(chatId, `👁️ **Watchlist:** ${list.join(", ")}`, { parse_mode: "Markdown" });
    });

    // /socialon /socialoff — Toggle sentiment in scoring
    bot.onText(/\/social(on|off)/, (msg, match) => {
      const chatId = msg.chat.id;
      const enabled = match[1] === "on";
      this.config.enabled = enabled;
      bot.sendMessage(
        chatId,
        enabled
          ? "🟢 Social sentiment ENABLED — will contribute to signal scoring"
          : "🔴 Social sentiment DISABLED — excluded from scoring"
      );
    });
  }

  // ══════════════════════════════════════════════════════
  //  8. ALERT SYSTEM
  // ══════════════════════════════════════════════════════

  async checkWatchlistAlerts() {
    if (this.config.watchlist.size === 0 || !this.bot || !this.chatId) return;

    for (const [ticker] of this.config.watchlist) {
      try {
        const score = await this.getSentimentScore(ticker);

        // Alert if score jumped significantly
        const alertKey = `${ticker}_lastScore`;
        const lastScore = this.alertHistory.get(alertKey) || 0;
        const jump = score.socialScore - lastScore;

        if (Math.abs(jump) > 10 && score.mentionCount >= this.config.minMentionsForSignal) {
          const direction = jump > 0 ? "📈 Surged" : "📉 Dropped";
          await this.bot.sendMessage(
            this.chatId,
            `🚨 **${ticker} Sentiment ${direction}!**\nScore: ${lastScore} → ${score.socialScore}\nMentions: ${score.mentionCount}`,
            { parse_mode: "Markdown" }
          );
        }

        this.alertHistory.set(alertKey, score.socialScore);
      } catch (e) {
        console.error(`[Social] Alert check failed for ${ticker}:`, e.message);
      }
    }
  }
}

module.exports = SocialSentiment;
