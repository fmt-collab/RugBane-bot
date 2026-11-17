// ═══════════════════════════════════════════════════════════
//  RUGBANE — TELEGRAM TRADING TERMINAL (UI LAYER)
//  Inline-keyboard menus, live position cards, buy/sell flows,
//  safety scanner and settings. No typing needed to trade.
// ═══════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const SEP = "━━━━━━━━━━━━━━━━━━━";
const SETTINGS_PATH =
  process.env.UI_SETTINGS_PATH ||
  path.join(__dirname, "..", "data", "ui-settings.json");

const DEFAULT_SETTINGS = {
  slippageBps: 500,
  buyPresets: [0.05, 0.1, 0.25, 0.5, 1],
};

const SLIPPAGE_STEPS = [100, 250, 500, 1000, 1500];
const BASE58_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

// ── Formatting helpers ──
function short(addr, n = 4) {
  const s = String(addr || "");
  if (!s) return "?";
  if (s.length <= n * 2 + 3) return s;
  return `${s.slice(0, n)}…${s.slice(-n)}`;
}

function sign(n, digits = 2) {
  const v = Number(n) || 0;
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
}

function emojiFor(mult) {
  if (mult >= 2) return "🚀";
  if (mult >= 1) return "🟢";
  if (mult >= 0.7) return "🟡";
  return "🔴";
}

function bar(pct, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

function card(title, body) {
  return `🐻 RUGBANE · ${title}\n${SEP}\n${body}`;
}

class UiManager {
  constructor({ bot, chatId, services = {}, settingsPath = SETTINGS_PATH }) {
    this.bot = bot;
    this.chatId = String(chatId || "");
    this.s = services;
    this.settingsPath = settingsPath;

    // chatId -> { type, mint? } for multi-step flows
    this.pending = new Map();
    // chatId -> mint chosen before picking an amount
    this.pendingBuyMint = new Map();

    this.settings = this.loadSettings();

    // Push persisted slippage into the swap executor
    if (this.s.setSlippage) this.s.setSlippage(this.settings.slippageBps);

    console.log("[UI] Trading terminal ready");
  }

  // ── Settings persistence ──
  loadSettings() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, "utf8"));
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        buyPresets: Array.isArray(raw.buyPresets) && raw.buyPresets.length
          ? raw.buyPresets
          : DEFAULT_SETTINGS.buyPresets,
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings() {
    try {
      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
    } catch (e) {
      console.error("[UI] Settings save failed:", e.message);
    }
  }

  // ── Plumbing ──
  isOwner(chatId) {
    return !this.chatId || String(chatId) === this.chatId;
  }

  async send(chatId, text, keyboard) {
    const opts = { disable_web_page_preview: true };
    if (keyboard) opts.reply_markup = { inline_keyboard: keyboard };
    return this.bot.sendMessage(chatId, text, opts);
  }

  // Edit in place so the chat stays clean, fall back to a new message
  async render(chatId, messageId, text, keyboard) {
    const opts = { disable_web_page_preview: true };
    if (keyboard) opts.reply_markup = { inline_keyboard: keyboard };
    if (messageId) {
      try {
        await this.bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          ...opts,
        });
        return;
      } catch {
        // message too old / identical content — send a fresh one
      }
    }
    await this.bot.sendMessage(chatId, text, opts);
  }

  async answer(callbackId, text) {
    try {
      await this.bot.answerCallbackQuery(
        callbackId,
        text ? { text } : undefined
      );
    } catch {
      // callback may have already expired
    }
  }

  back(text = "« Menu") {
    return { text, callback_data: "m" };
  }

  solPrice() {
    const p = Number(this.s.getSolPrice ? this.s.getSolPrice() : 0);
    return Number.isFinite(p) && p > 0 ? p : 0;
  }

  paperMode() {
    return this.s.getPaperMode ? !!this.s.getPaperMode() : true;
  }

  positions() {
    const open = this.s.profitLocker?.state?.openPositions || {};
    return Object.entries(open);
  }

  // ══════════════════════════════════════
  //  MAIN MENU
  // ══════════════════════════════════════
  async showMainMenu(chatId, messageId) {
    const pos = this.positions();
    const auto = this.s.signalEngine?.autoCopyEnabled ? "ON" : "OFF";
    const mode = this.paperMode() ? "📝 PAPER" : "🔴 LIVE";

    let pnl = 0;
    for (const [, p] of pos) {
      const mult = p.entryPriceSol ? p.currentPriceSol / p.entryPriceSol : 1;
      pnl += (mult - 1) * 100;
    }

    const body = [
      `Mode        ${mode}`,
      `SOL         $${this.solPrice().toFixed(2)}`,
      `Positions   ${pos.length}`,
      `Open P&L    ${pos.length ? sign(pnl / pos.length) + "%" : "—"}`,
      `Auto-copy   ${auto}`,
      `Slippage    ${(this.settings.slippageBps / 100).toFixed(1)}%`,
    ].join("\n");

    const keyboard = [
      [
        { text: "🛒 Buy", callback_data: "b" },
        { text: `📊 Positions (${pos.length})`, callback_data: "p" },
      ],
      [
        { text: "🛡 Safety Scan", callback_data: "f" },
        { text: "📈 Signals", callback_data: "g" },
      ],
      [
        { text: "💼 Wallet", callback_data: "w" },
        { text: "⚙️ Settings", callback_data: "s" },
      ],
      [
        { text: `🤖 Auto-Copy ${auto}`, callback_data: "a" },
        { text: "🔄 Refresh", callback_data: "m" },
      ],
    ];

    await this.render(chatId, messageId, card("TERMINAL", body), keyboard);
  }

  // ══════════════════════════════════════
  //  BUY FLOW
  // ══════════════════════════════════════
  async showBuy(chatId, messageId) {
    const mint = this.pendingBuyMint.get(String(chatId));
    if (mint) return this.showAmounts(chatId, messageId, mint);

    this.pending.set(String(chatId), { type: "buy_mint" });
    await this.render(
      chatId,
      messageId,
      card(
        "BUY",
        "Send me the token address.\n" +
          "DexScreener / Solscan links work too.\n\n" +
          `Presets: ${this.settings.buyPresets.join(" / ")} SOL`
      ),
      [[this.back("« Cancel")]]
    );
  }

  async showAmounts(chatId, messageId, mint, symbol) {
    this.pendingBuyMint.set(String(chatId), mint);

    const rows = [];
    const presets = this.settings.buyPresets;
    for (let i = 0; i < presets.length; i += 2) {
      rows.push(
        presets.slice(i, i + 2).map((a) => ({
          text: `${a} SOL`,
          callback_data: `y:${a}:${mint}`,
        }))
      );
    }
    rows.push([{ text: "✏️ Custom amount", callback_data: `b:c:${mint}` }]);
    rows.push([this.back("« Cancel")]);

    await this.render(
      chatId,
      messageId,
      card(
        "BUY",
        `Token   ${symbol || short(mint, 6)}\n` +
          `Mint    ${short(mint, 6)}\n` +
          `Slippage ${(this.settings.slippageBps / 100).toFixed(1)}%\n\n` +
          "Pick an amount — safety checks run before every buy."
      ),
      rows
    );
  }

  async doBuy(chatId, messageId, mint, amountSol) {
    const amount = Number(amountSol);
    if (!Number.isFinite(amount) || amount <= 0) {
      return this.render(
        chatId,
        messageId,
        card("BUY", "❌ Invalid amount."),
        [[this.back()]]
      );
    }

    this.pending.delete(String(chatId));
    this.pendingBuyMint.delete(String(chatId));

    await this.render(
      chatId,
      messageId,
      card("BUYING", `${amount} SOL → ${short(mint, 6)}\nRunning safety checks…`),
      [[this.back()]]
    );

    let res;
    try {
      res = await this.s.buy(mint, amount, short(mint, 6));
    } catch (e) {
      res = { success: false, error: e.message };
    }

    if (res && res.success) {
      return this.render(
        chatId,
        messageId,
        card(
          "ORDER FILLED",
          `Token   ${short(mint, 6)}\n` +
            `Spent   ${amount} SOL\n` +
            `Mode    ${this.paperMode() ? "📝 paper" : "🔴 live"}\n` +
            `TX      ${short(res.signature || "—", 8)}`
        ),
        [
          [{ text: "📊 Positions", callback_data: "p" }],
          [this.back()],
        ]
      );
    }

    await this.render(
      chatId,
      messageId,
      card(
        "ORDER REJECTED",
        `Token   ${short(mint, 6)}\n` +
          `Reason  ${(res && (res.error || res.reason)) || "unknown"}`
      ),
      [[this.back()]]
    );
  }

  // ══════════════════════════════════════
  //  POSITIONS
  // ══════════════════════════════════════
  async showPositions(chatId, messageId) {
    const pos = this.positions();

    if (pos.length === 0) {
      return this.render(
        chatId,
        messageId,
        card("POSITIONS", "No open positions.\n\nUse 🛒 Buy to open one."),
        [
          [{ text: "🛒 Buy", callback_data: "b" }],
          [this.back()],
        ]
      );
    }

    const lines = [];
    const rows = [];

    for (const [mint, p] of pos.slice(0, 4)) {
      const mult = p.entryPriceSol ? p.currentPriceSol / p.entryPriceSol : 1;
      const soldPct = Math.round(p.soldPct || 0);
      lines.push(
        `${emojiFor(mult)} ${p.symbol || short(mint, 4)}  ${mult.toFixed(2)}x  ${sign((mult - 1) * 100)}%`,
        `   ${bar(soldPct)} sold ${soldPct}%`
      );
      rows.push([
        { text: `Sell 25% ${p.symbol || ""}`.trim(), callback_data: `x:25:${mint}` },
        { text: "50%", callback_data: `x:50:${mint}` },
        { text: "100%", callback_data: `x:100:${mint}` },
      ]);
    }

    if (pos.length > 4) lines.push(`…and ${pos.length - 4} more`);

    rows.push([
      { text: "🔄 Refresh", callback_data: "p" },
      this.back(),
    ]);

    await this.render(
      chatId,
      messageId,
      card("POSITIONS", `${lines.join("\n")}\n\n${pos.length} open`),
      rows
    );
  }

  async doSell(chatId, messageId, mint, pct) {
    const percentage = Math.max(1, Math.min(100, Number(pct) || 100));
    await this.render(
      chatId,
      messageId,
      card("SELLING", `${percentage}% of ${short(mint, 6)}\nSubmitting…`),
      [[this.back()]]
    );

    let res;
    try {
      res = await this.s.sellToken(mint, percentage);
    } catch (e) {
      res = { success: false, error: e.message };
    }

    if (res && res.success) {
      return this.showPositions(chatId, messageId);
    }

    await this.render(
      chatId,
      messageId,
      card(
        "SELL FAILED",
        `Token   ${short(mint, 6)}\n` +
          `Reason  ${(res && res.error) || "unknown"}`
      ),
      [
        [{ text: "« Back to positions", callback_data: "p" }],
        [this.back()],
      ]
    );
  }

  // ══════════════════════════════════════
  //  WALLET / SETTINGS / SIGNALS / HELP
  // ══════════════════════════════════════
  async showWallet(chatId, messageId) {
    let bal = 0;
    try {
      if (this.s.getSolBalance) bal = await this.s.getSolBalance();
    } catch {
      bal = 0;
    }

    const paper = this.s.profitLocker?.paperBalances?.get?.("A");
    const cold = this.s.profitLocker?.coldWallet;
    const usd = bal * this.solPrice();

    const body = [
      `Wallet      ${short(this.s.profitLocker?.wallet?.publicKey?.toBase58?.() || "—", 6)}`,
      `SOL         ${bal.toFixed(4)}  (~$${usd.toFixed(2)})`,
      paper != null ? `Paper       ${Number(paper).toFixed(4)} SOL` : null,
      cold ? `Cold        ${short(cold, 6)}` : "Cold        not set",
    ]
      .filter(Boolean)
      .join("\n");

    await this.render(chatId, messageId, card("WALLET", body), [
      [
        { text: "🔄 Refresh", callback_data: "w" },
        this.back(),
      ],
    ]);
  }

  async showSettings(chatId, messageId) {
    const body = [
      `Mode        ${this.paperMode() ? "📝 PAPER (safe)" : "🔴 LIVE (real funds)"}`,
      `Slippage    ${(this.settings.slippageBps / 100).toFixed(1)}%`,
      `Auto-copy   ${this.s.signalEngine?.autoCopyEnabled ? "ON" : "OFF"}`,
      `Presets     ${this.settings.buyPresets.join(" / ")} SOL`,
    ].join("\n");

    await this.render(chatId, messageId, card("SETTINGS", body), [
      [
        {
          text: this.paperMode() ? "Switch to 🔴 LIVE" : "Switch to 📝 PAPER",
          callback_data: "s:p",
        },
      ],
      [
        { text: "Slippage →", callback_data: "s:l" },
        {
          text: `Auto-copy ${this.s.signalEngine?.autoCopyEnabled ? "OFF" : "ON"}`,
          callback_data: "s:a",
        },
      ],
      [this.back()],
    ]);
  }

  async showSignals(chatId, messageId) {
    const all = Array.from(this.s.signalEngine?.unifiedSignals?.values?.() || [])
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);

    if (all.length === 0) {
      return this.render(
        chatId,
        messageId,
        card("SIGNALS", "No signals yet.\nRun /scan to analyse the market."),
        [
          [{ text: "🔄 Refresh", callback_data: "g" }],
          [this.back()],
        ]
      );
    }

    const lines = all.map((sig, i) => {
      const dot = sig.action === "buy" ? "🟢" : sig.action === "watch" ? "👀" : "⚪";
      return `${dot} ${i + 1}. ${short(sig.mint, 4)}  ${sig.total}/100  ${sig.action.toUpperCase()}`;
    });

    const rows = all
      .filter((sig) => sig.action === "buy")
      .slice(0, 2)
      .map((sig) => [
        {
          text: `🛒 Buy ${short(sig.mint, 4)}`,
          callback_data: `y:${this.settings.buyPresets[0]}:${sig.mint}`,
        },
      ]);
    rows.push([{ text: "🔄 Refresh", callback_data: "g" }, this.back()]);

    await this.render(chatId, messageId, card("SIGNALS", lines.join("\n")), rows);
  }

  async showHelp(chatId, messageId) {
    const body = [
      "Tap the buttons — no typing required.",
      "",
      "/menu      open the terminal",
      "/buy       <mint> <sol>",
      "/sell      <mint> <pct>",
      "/portfolio /stats  positions & PnL",
      "/safety    <mint>  rug report",
      "/trust     <mint>  wash/cluster score",
      "/honeypot  <mint>",
      "/signal    <ticker>",
      "/autocopy  on|off",
      "/paper     on|off",
    ].join("\n");

    await this.render(chatId, messageId, card("HELP", body), [[this.back()]]);
  }

  // ══════════════════════════════════════
  //  SAFETY SCANNER
  // ══════════════════════════════════════
  async promptSafety(chatId, messageId) {
    this.pending.set(String(chatId), { type: "safety_mint" });
    await this.render(
      chatId,
      messageId,
      card("SAFETY SCAN", "Send the token address to scan.\nRugCheck + wash trading + honeypot."),
      [[this.back("« Cancel")]]
    );
  }

  async runSafety(chatId, messageId, mint) {
    await this.render(
      chatId,
      messageId,
      card("SAFETY SCAN", `Scanning ${short(mint, 6)}…\nThis takes a few seconds.`),
      [[this.back()]]
    );

    const [rug, wash, honey] = await Promise.allSettled([
      this.s.rugCheck ? this.s.rugCheck.inspect(mint) : Promise.resolve(null),
      this.s.washDetector ? this.s.washDetector.inspectToken(mint, "?") : Promise.resolve(null),
      this.s.honeypotDetector ? this.s.honeypotDetector.analyze(mint) : Promise.resolve(null),
    ]);

    const r = rug.status === "fulfilled" ? rug.value : null;
    const w = wash.status === "fulfilled" ? wash.value : null;
    const h = honey.status === "fulfilled" ? honey.value : null;

    const trust = w?.trustScore ?? null;
    const verdict = [
      r && r.pass ? "RugCheck ✅" : r ? "RugCheck ❌" : null,
      trust != null ? `Trust ${trust}/100` : null,
      h ? (h.isHoneypot ? "Honeypot ⚠️" : "Honeypot ✅") : null,
    ]
      .filter(Boolean)
      .join("  ·  ");

    const flags = [
      ...(r?.flags || []),
      ...(w?.flags || []),
      ...((h?.flags || []).filter((f) => !f.includes("LIKELY SAFE"))),
    ].slice(0, 6);

    const body = [
      `Token   ${r?.symbol && r.symbol !== "?" ? r.symbol : short(mint, 6)}`,
      `Mint    ${short(mint, 6)}`,
      `Risk    ${r?.riskLevel || "UNKNOWN"}`,
      `Signals ${verdict || "—"}`,
      "",
      flags.length ? `⚠️ ${flags.join("\n⚠️ ")}` : "✅ No critical flags",
    ].join("\n");

    const safe = (r ? !!r.pass : true) && (trust == null || trust >= 60) && !h?.isHoneypot;

    const rows = [];
    if (safe) {
      rows.push(
        this.settings.buyPresets.slice(0, 3).map((a) => ({
          text: `🛒 Buy ${a} SOL`,
          callback_data: `y:${a}:${mint}`,
        }))
      );
    }
    rows.push([{ text: "🔄 Rescan", callback_data: `f:${mint}` }, this.back()]);

    await this.render(chatId, messageId, card("SAFETY REPORT", body), rows);
  }

  // ══════════════════════════════════════
  //  CALLBACK ROUTER
  // ══════════════════════════════════════
  async handleCallback(query) {
    const chatId = query?.message?.chat?.id;
    const messageId = query?.message?.message_id;
    const data = String(query?.data || "");

    if (!chatId || !this.isOwner(chatId)) {
      return this.answer(query.id, "⛔ Unauthorized");
    }

    try {
      if (data === "m") {
        await this.answer(query.id);
        return await this.showMainMenu(chatId, messageId);
      }
      if (data === "b") {
        await this.answer(query.id);
        return await this.showBuy(chatId, messageId);
      }
      if (data === "p") {
        await this.answer(query.id);
        return await this.showPositions(chatId, messageId);
      }
      if (data === "w") {
        await this.answer(query.id);
        return await this.showWallet(chatId, messageId);
      }
      if (data === "s") {
        await this.answer(query.id);
        return await this.showSettings(chatId, messageId);
      }
      if (data === "g") {
        await this.answer(query.id);
        return await this.showSignals(chatId, messageId);
      }
      if (data === "h") {
        await this.answer(query.id);
        return await this.showHelp(chatId, messageId);
      }
      if (data === "f") {
        await this.answer(query.id);
        return await this.promptSafety(chatId, messageId);
      }

      // ── Settings actions ──
      if (data === "s:p") {
        const next = !this.paperMode();
        if (this.s.setPaperMode) this.s.setPaperMode(next);
        await this.answer(query.id, next ? "📝 Paper trading" : "🔴 LIVE trading");
        return await this.showSettings(chatId, messageId);
      }
      if (data === "s:l") {
        const idx = SLIPPAGE_STEPS.indexOf(this.settings.slippageBps);
        this.settings.slippageBps = SLIPPAGE_STEPS[(idx + 1) % SLIPPAGE_STEPS.length];
        if (this.s.setSlippage) this.s.setSlippage(this.settings.slippageBps);
        this.saveSettings();
        await this.answer(query.id, `Slippage ${(this.settings.slippageBps / 100).toFixed(1)}%`);
        return await this.showSettings(chatId, messageId);
      }
      if (data === "s:a") {
        const eng = this.s.signalEngine;
        if (eng) eng.autoCopyEnabled = !eng.autoCopyEnabled;
        await this.answer(query.id, eng?.autoCopyEnabled ? "Auto-copy ON" : "Auto-copy OFF");
        return await this.showSettings(chatId, messageId);
      }
      if (data === "a") {
        const eng = this.s.signalEngine;
        if (eng) eng.autoCopyEnabled = !eng.autoCopyEnabled;
        await this.answer(query.id, eng?.autoCopyEnabled ? "Auto-copy ON" : "Auto-copy OFF");
        return await this.showMainMenu(chatId, messageId);
      }

      // ── Buy: custom amount prompt ──
      if (data.startsWith("b:c:")) {
        const mint = data.slice(4);
        this.pending.set(String(chatId), { type: "buy_amount", mint });
        await this.answer(query.id);
        return await this.render(
          chatId,
          messageId,
          card("BUY", `Amount in SOL for ${short(mint, 6)}\n\nExample: 0.15`),
          [[{ text: "« Back", callback_data: `b` }], [this.back()]]
        );
      }

      // ── Buy: preset amount ──
      if (data.startsWith("y:")) {
        const rest = data.slice(2);
        const sep = rest.indexOf(":");
        const amount = sep === -1 ? rest : rest.slice(0, sep);
        const mint =
          sep === -1 ? this.pendingBuyMint.get(String(chatId)) : rest.slice(sep + 1);
        await this.answer(query.id);
        if (!mint) {
          return await this.showBuy(chatId, messageId);
        }
        return await this.doBuy(chatId, messageId, mint, amount);
      }

      // ── Sell ──
      if (data.startsWith("x:")) {
        const [, pct, mint] = data.split(":");
        await this.answer(query.id);
        return await this.doSell(chatId, messageId, mint, pct);
      }

      // ── Rescan from a safety card ──
      if (data.startsWith("f:")) {
        const mint = data.slice(2);
        await this.answer(query.id);
        return await this.runSafety(chatId, messageId, mint);
      }

      await this.answer(query.id);
    } catch (e) {
      console.error("[UI] Callback error:", e.message);
      await this.answer(query.id, "⚠️ Something went wrong");
    }
  }

  // ══════════════════════════════════════
  //  TEXT INPUT ROUTER (multi-step flows)
  // ══════════════════════════════════════
  async handleMessage(msg) {
    const chatId = msg?.chat?.id;
    const text = (msg?.text || "").trim();

    // Commands and non-owner traffic are handled elsewhere
    if (!chatId || !text || text.startsWith("/") || !this.isOwner(chatId)) return;

    const key = String(chatId);
    const pending = this.pending.get(key);
    if (!pending) return;

    const mint = this.extractMint(text);

    if (pending.type === "buy_mint" || pending.type === "safety_mint") {
      if (!mint) {
        return this.send(
          chatId,
          card("INVALID", "That doesn't look like a Solana token address.\nTry again or tap « Cancel."),
          [[this.back("« Cancel")]]
        );
      }
      this.pending.delete(key);
      if (pending.type === "safety_mint") return this.runSafety(chatId, null, mint);
      return this.showAmounts(chatId, null, mint);
    }

    if (pending.type === "buy_amount") {
      this.pending.delete(key);
      const amount = Number(text.replace(",", "."));
      if (!Number.isFinite(amount) || amount <= 0) {
        return this.send(
          chatId,
          card("INVALID", "Send a positive number of SOL, e.g. 0.15"),
          [[this.back("« Cancel")]]
        );
      }
      return this.doBuy(chatId, null, pending.mint, amount);
    }
  }

  extractMint(text) {
    const m = String(text || "").match(BASE58_RE);
    return m ? m[0] : null;
  }
}

module.exports = UiManager;
