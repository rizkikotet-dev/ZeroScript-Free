// SPDX-License-Identifier: GPL-3.0-or-later
// providers/chatgpt.js - the ChatGPT (chatgpt.com) provider.
// Exports the same ZSProvider interface as providers/deepseek.js; the core
// (core/main.js) is provider-agnostic. To DISABLE ChatGPT support, simply remove
// this file from manifest.json (and its URL from background.js PROVIDER_URLS).
//
// ChatGPT DOM notes (validated live, 2026):
//  - React app with server components. Each turn is a <div[data-message-author-role]>
//    with role="user" or "assistant". The assistant reply markdown lives in a
//    .markdown.prose element inside the turn container.
//  - Reasoning (o1 models) renders in a collapsible [data-reasoning-content] block
//    which we exclude from the main reply text (same pattern as DeepThink/Gemini).
//  - The composer is a contenteditable <div> inside a form, with a send button
//    that shows a stop square during generation and a send arrow when idle.
//  - Generation detection: the stop button appears during streaming, and the
//    message content grows. We use both signals for robust detection.
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let diag = () => {}; // injected by core via init()

  const S = {
    userItem: '[data-message-author-role="user"]',
    assistantItem: '[data-message-author-role="assistant"]',
    anyItem: '[data-message-author-role]',
    reply: ".markdown.prose",
    thinking: "[data-reasoning-content]",
    editor: "form textarea, [contenteditable][role='textbox']",
    inputForm: "form",
    sendBtn: "button[type='submit']",
    stopBtn: "[aria-label='Stop generating'], button svg path[d*='M3'], button svg rect",
    codeWrap: "pre code, .syntax-highlighted-code",
    errorSurfaces: '[role="alert"],[class*="toast"],[class*="error"],[class*="warning"]',
  };

  const RE = {
    contextLimit: new RegExp(
      [
        "conversation.{0,20}(too long|trop long)",
        "context.{0,20}(limit|exceeded|dépassé)",
        "please.{0,30}(start|create).{0,20}(new|nouveau).{0,20}(chat|conversation)",
        "(token|context).{0,10}limit",
        "maximum.{0,20}context",
        "this conversation has reached",
      ].join("|"),
      "i"
    ),
    tooLong: /conversation .{0,20}(too long|getting too long|trop longue)/i,
    busy: /something went wrong|une erreur s.est produite|try again later|réessayer plus tard|temporarily unavailable|rate limit/i,
    continueBtn: /^(continue|regenerate)$/i,
  };

  // ChatGPT streams with a hard stop-button signal for the WHOLE generation
  // (including reasoning on o1 models), so idle windows can be tight.
  const timings = {
    GEN_IDLE_MS: 1500,
    REASON_IDLE_MS: 12000,
    WARMUP_MS: 45000,
    REASON_NOREPLY_MS: 90000,
    STABLE_MS: 9000,
    RESPONSE_TIMEOUT_MS: 300000,
  };

  // ── Turn classification ───────────────────────────────────────────────────
  const isUserItem = (item) => !!item && item.matches(S.userItem);
  const isAssistantItem = (item) => !!item && item.matches(S.assistantItem);

  // Extract text from an item, excluding reasoning and any excluded subtree
  // (like the core's own chip selector).
  function textWithout(root, excludeSel) {
    if (!root) return "";
    const skip = S.thinking + (excludeSel ? ", " + excludeSel : "");
    let t = "";
    const walk = (n) => {
      if (n.nodeType === 3) { t += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      if (n.matches && n.matches(skip)) return;
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return t;
  }

  function itemText(item) {
    if (!item) return "";
    if (isAssistantItem(item)) {
      const md = item.querySelector(S.reply);
      return md ? textWithout(md) : "";
    }
    return textWithout(item);
  }

  function classifyText(item, excludeSel) {
    if (isAssistantItem(item)) {
      const md = item.querySelector(S.reply);
      if (!md || (excludeSel && md.closest(excludeSel))) return "";
      return textWithout(md, excludeSel);
    }
    return textWithout(item, excludeSel);
  }

  // ── DOM primitives ────────────────────────────────────────────────────────
  const allItems = () => [...document.querySelectorAll(S.anyItem)];
  const assistantItems = () => [...document.querySelectorAll(S.assistantItem)];
  const assistantCount = () => assistantItems().length;
  const userCount = () => document.querySelectorAll(S.userItem).length;

  // Scope to the SITE's composer only: skip ZeroScript's own injected UI.
  const getEditor = () => {
    for (const sel of [S.editor, "textarea", "[contenteditable]"]) {
      for (const e of document.querySelectorAll(sel)) {
        if (!e.closest("#zs-root")) return e;
      }
    }
    return null;
  };

  const editorText = () => {
    const e = getEditor();
    if (!e) return "";
    return e.tagName === "TEXTAREA" ? (e.value || "") : (e.textContent || "");
  };

  const lastAssistant = () => {
    const it = assistantItems();
    return it.length ? it[it.length - 1] : null;
  };

  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && location.pathname === "/" && !!getEditor();

  // The composer frame (the form element or its wrapper).
  const composerFrame = () => document.querySelector(S.inputForm) || (getEditor() && getEditor().closest("div"));

  // ── Input lock ────────────────────────────────────────────────────────────
  let _locked = false;
  function setInputLock(on) {
    _locked = on;
    const ed = getEditor();
    if (!ed) return;
    if (on) {
      if (!ed.dataset.zsPlaceholder) ed.dataset.zsPlaceholder = ed.getAttribute("placeholder") || "";
      ed.setAttribute("contenteditable", "false");
      ed.setAttribute("placeholder", "⏳ Agent working… please wait");
    } else {
      ed.removeAttribute("contenteditable");
      if (ed.dataset.zsPlaceholder != null) ed.setAttribute("placeholder", ed.dataset.zsPlaceholder);
    }
  }

  // ── Action button (send / stop) ─────────────────────────────────────────
  function actionButtons() {
    const form = document.querySelector(S.inputForm);
    return form ? [...form.querySelectorAll("button")].filter((b) => b.offsetParent !== null) : [];
  }

  const findButtonByIcon = (name) => {
    const buttons = actionButtons();
    // Try aria-label first
    let btn = buttons.find((b) => (b.getAttribute("aria-label") || "").toLowerCase().includes(name.toLowerCase()));
    if (btn) return btn;
    // Try SVG content
    return buttons.find((b) => {
      const svg = b.querySelector("svg");
      if (!svg) return false;
      const path = svg.querySelector("path");
      const rect = svg.querySelector("rect");
      if (name === "stop" && rect) return true;
      if (name === "stop" && path && path.getAttribute("d")?.startsWith("M3")) return true;
      if (name === "send" && path && path.getAttribute("d")?.includes("M8")) return true;
      return false;
    }) || null;
  };

  const sendButton = () => findButtonByIcon("send") || findButtonByIcon("arrow");
  const stopButton = () => findButtonByIcon("stop");

  // ── Generation detection ──────────────────────────────────────────────────
  function streamText(item) {
    if (!item) return "";
    const think = item.querySelector(S.thinking);
    const md = item.querySelector(S.reply);
    return (think ? (think.textContent || "") : "") + "\n" + (md ? textWithout(md, ".zs-chip") : "");
  }

  const streamLen = (item) => streamText(item === undefined ? lastAssistant() : item).length;

  let _streamMax = -1, _streamAt = 0, _streamItem = null;
  function sampleStream() {
    const item = lastAssistant();
    const len = streamText(item).length;
    const now = Date.now();
    if (item !== _streamItem || len < _streamMax - 400) {
      _streamItem = item; _streamMax = len; _streamAt = now; return;
    }
    if (len > _streamMax) { _streamMax = len; _streamAt = now; }
  }

  const grewWithin = (ms) => _streamMax > 1 && Date.now() - _streamAt < ms;

  let _stopSince = 0;
  const WEDGE_MS = 10000;

  function genActive() {
    sampleStream();
    const stop = !!stopButton();
    const now = Date.now();
    if (stop) {
      if (!_stopSince) _stopSince = now;
      return (now - _streamAt < WEDGE_MS) || (now - _stopSince < 2000);
    }
    _stopSince = 0;
    return grewWithin(timings.GEN_IDLE_MS);
  }

  const isGenerating = genActive;
  const isBusyNow = genActive;
  const isHardGenerating = genActive;

  function unwedgeStop() {
    const stop = stopButton();
    if (stop && !genActive()) {
      diag("send.unwedge", {});
      try { stop.click(); } catch {}
      return true;
    }
    return false;
  }

  async function unwedgeStopPersistently(totalMs = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < totalMs) {
      if (sendButton()) return true;
      if (unwedgeStop() && await waitFor(() => !!sendButton(), 1500)) return true;
      await sleep(250);
    }
    return !!sendButton();
  }

  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  // Composer enforcement (no-op for ChatGPT, composer is always ready)
  const enforceComposer = () => ({ ready: true });
  
  async function ensureComposerReady(reason) {
    for (let i = 0; i < 20; i++) {
      if (getEditor()) break;
      await sleep(150);
    }
    const ready = !!getEditor();
    diag("mode_ready", { reason, provider: "chatgpt", ready });
    return { ready };
  }

  function snapshot() {
    try {
      const it = lastAssistant();
      if (!it) return { th: 0, rp: 0 };
      const think = it.querySelector(S.thinking);
      const md = it.querySelector(S.reply);
      return {
        th: think ? (think.textContent || "").trim().length : 0,
        rp: md ? (md.textContent || "").length : 0,
      };
    } catch { return {}; }
  }

  function readAssistant() {
    const item = lastAssistant();
    if (!item) return { present: false, reply: "", thinking: "", item: null };
    const think = item.querySelector(S.thinking);
    const md = item.querySelector(S.reply);
    return {
      present: true,
      reply: md ? textWithout(md, ".zs-chip").trim() : "",
      thinking: think ? (think.textContent || "").trim() : "",
      item,
    };
  }

  async function waitFor(pred, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  }

  // ── Sending ───────────────────────────────────────────────────────────────
  function setTextareaValue(el, text) {
    if (!el) return;
    const proto = Object.getPrototypeOf(el);
    const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function typeAndSend(text, imageFiles) {
    const ed = getEditor();
    if (!ed) {
      diag("send.no-editor", {});
      return { sent: false, error: "No editor found" };
    }

    // Handle images if provided (ChatGPT supports image upload)
    if (imageFiles && imageFiles.length > 0) {
      const attachArea = document.querySelector(S.attachArea || "input[type='file']");
      if (attachArea) {
        // Image attachment would require more complex handling
        // For now, we'll just send the text
        diag("send.image-not-supported", {});
      }
    }

    // Set the text
    if (ed.tagName === "TEXTAREA") {
      setTextareaValue(ed, text);
    } else {
      ed.textContent = text;
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // Wait for send button to appear
    await sleep(150);

    // Try to click send button
    const send = sendButton();
    if (send) {
      try {
        send.click();
        return { sent: true };
      } catch (e) {
        diag("send.click-failed", { error: e.message });
      }
    }

    // Fallback: simulate Enter key
    diag("send.fallback-enter", {});
    ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    await sleep(100);
    return { sent: true };
  }

  // ── Context limit detection ───────────────────────────────────────────────
  function hitContextLimit() {
    const errs = document.querySelectorAll(S.errorSurfaces);
    for (const e of errs) {
      const t = (e.textContent || "").toLowerCase();
      if (RE.contextLimit.test(t) || RE.tooLong.test(t)) return true;
    }
    const last = lastAssistant();
    if (last) {
      const t = classifyText(last, ".zs-chip").toLowerCase();
      if (RE.contextLimit.test(t) || RE.tooLong.test(t)) return true;
    }
    return false;
  }

  // ── Error surface clearing ────────────────────────────────────────────────
  function clearErrors() {
    const errs = document.querySelectorAll(S.errorSurfaces);
    for (const e of errs) {
      const close = e.querySelector("[class*='close'], [class*='dismiss'], button[aria-label*='close']");
      if (close) { try { close.click(); } catch {} }
      if (e.parentElement && e.parentElement.classList.contains("toast")) {
        try { e.parentElement.remove(); } catch {}
      }
    }
  }

  const newChat = () => {
    const btn = document.querySelector('[aria-label*="New chat"], [data-testid*="new-chat"], button[class*="new-chat"]');
    if (btn) { btn.click(); return true; }
    // Fallback: navigate to root
    if (location.pathname !== "/") {
      history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
      return true;
    }
    return false;
  };

  const conversationKey = () => (location.pathname === "/" ? "" : location.pathname);

  // ── Send hooks ────────────────────────────────────────────────────────────
  function installSendHooks(handlers) {
    let lastUserSendAt = 0;
    const notifyUserSend = () => {
      const now = Date.now();
      if (now - lastUserSendAt < 500) return;
      lastUserSendAt = now;
      handlers.onUserMessage(assistantCount());
    };

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const ed = getEditor();
      if (!ed || !ed.contains(event.target) || !editorText().trim()) return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (chatIsEmpty()) handlers.onBlockedAttempt();
        return;
      }
      notifyUserSend();
    }, true);

    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button");
      if (!button) return;
      const label = (button.textContent || button.getAttribute("aria-label") || "").trim();
      if (button.matches(S.stopBtn)) {
        handlers.onNativeStop();
        return;
      }
      if (RE.continueBtn.test(label)) {
        handlers.onNativeContinue();
        return;
      }
      if (!button.matches(S.sendBtn) || button.disabled || button.getAttribute("aria-disabled") === "true") return;
      if (!getEditor() || !editorText().trim() || handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (chatIsEmpty()) handlers.onBlockedAttempt();
        return;
      }
      notifyUserSend();
    }, true);
  }

  // ── Export ────────────────────────────────────────────────────────────────
  return {
    name: "chatgpt",
    domain: "chatgpt.com",
    timings,
    init(diagFn) { if (diagFn) diag = diagFn; },
    isUserItem,
    isAssistantItem,
    itemText,
    classifyText,
    allItems,
    assistantItems,
    assistantCount,
    userCount,
    getEditor,
    editorText,
    composerFrame,
    isFreshChat,
    setInputLock,
    isGenerating,
    isBusyNow,
    isHardGenerating,
    turnHalted,
    findContinueBtn,
    clickContinueBtn,
    lastAssistant,
    lastAssistantId: () => null,
    readAssistant,
    snapshot,
    typeAndSend,
    hitContextLimit,
    clearErrors,
    newChat,
    barAnchor: () => composerFrame(),
    barMount: () => {
      const form = composerFrame();
      if (!form) return null;
      return { parent: form.parentElement || form, before: form };
    },
    ensureOwnedChip: (anchor, chip) => {
      if (!anchor || !chip) return;
      if (!anchor.contains(chip)) {
        const existing = anchor.querySelector(".zs-chip");
        if (existing) existing.remove();
        anchor.insertBefore(chip, anchor.firstChild);
      }
    },
    attachImages: async () => false,
    clearAttachments: () => {},
    conversationKey,
    enforceComposer,
    ensureComposerReady,
    installSendHooks,
  };
})();
