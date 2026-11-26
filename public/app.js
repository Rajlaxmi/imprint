/**
 * Imprint — Interactive Multi-Book Reader + Background Gemini Sync + IndexedDB Storage
 * Renders uploaded EPUB / PDF books in the exact 3-column Melville House visualization.
 */
(function () {
  "use strict";

  const root = document.documentElement;

  /* ========================================================================
     0. Browser IndexedDB + localStorage Persistence ("Book data stored in website")
     ======================================================================== */
  const IDB_NAME = "BookVizStudioDB";
  const IDB_VERSION = 2;
  const IDB_BOOK_STORE = "books";
  const IDB_STATE_STORE = "states";

  const PREFS_KEY = "bvs_reader_prefs_v1";
  const ACTIVE_BOOK_KEY = "bvs_active_book_v1";
  const RIGHT_TAB_KEY = "bvs_right_tab_v1";

  function openBookDB() {
    return new Promise((resolve) => {
      if (!("indexedDB" in window)) return resolve(null);
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_BOOK_STORE)) {
          db.createObjectStore(IDB_BOOK_STORE, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(IDB_STATE_STORE)) {
          db.createObjectStore(IDB_STATE_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  async function idbSaveChapterState(bookId, ch, data) {
    if (!bookId || !ch) return;
    const db = await openBookDB();
    if (!db || !db.objectStoreNames.contains(IDB_STATE_STORE)) return;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STATE_STORE, "readwrite");
      tx.objectStore(IDB_STATE_STORE).put({
        id: `v3::${bookId}::${ch}`,
        bookId,
        chapter: ch,
        annotations: data.annotations || [],
        chatMessages: data.chatMessages || [],
        updatedAt: Date.now(),
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  async function idbGetChapterState(bookId, ch) {
    if (!bookId || !ch) return null;
    const db = await openBookDB();
    if (!db || !db.objectStoreNames.contains(IDB_STATE_STORE)) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STATE_STORE, "readonly");
      const req = tx.objectStore(IDB_STATE_STORE).get(`v3::${bookId}::${ch}`);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async function idbSaveBook(book) {
    if (!book || !book.id) return;
    const db = await openBookDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_BOOK_STORE, "readwrite");
      tx.objectStore(IDB_BOOK_STORE).put(book);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  async function idbGetBook(bookId) {
    if (!bookId) return null;
    const db = await openBookDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_BOOK_STORE, "readonly");
      const req = tx.objectStore(IDB_BOOK_STORE).get(bookId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async function idbGetAllBooks() {
    const db = await openBookDB();
    if (!db) return [];
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_BOOK_STORE, "readonly");
      const req = tx.objectStore(IDB_BOOK_STORE).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
  }

  async function idbDeleteBook(bookId) {
    const db = await openBookDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_BOOK_STORE, "readwrite");
      tx.objectStore(IDB_BOOK_STORE).delete(bookId);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJSON(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (_) {
      // Ignore quota errors
    }
  }

  function activeChapterKey(bookId) {
    return `bvs_${bookId}_active_ch`;
  }
  function annStorageKey(bookId, ch) {
    return `bvs_v3_${bookId}_${ch}_annotations`;
  }
  function annDeletedKey(bookId, ch) {
    return `bvs_v3_${bookId}_${ch}_ann_deleted`;
  }
  function annClearedKey(bookId, ch) {
    return `bvs_v3_${bookId}_${ch}_ann_cleared_at`;
  }
  function chatStorageKey(bookId, ch) {
    return `bvs_v3_${bookId}_${ch}_chat`;
  }
  function chatClearedKey(bookId, ch) {
    return `bvs_v3_${bookId}_${ch}_chat_cleared_at`;
  }

  function mergeAnnotationListsClient(lists, deletedSet = new Set(), clearedAfter = 0, targetBookId = "") {
    const byId = new Map();
    for (const arr of lists) {
      if (!Array.isArray(arr)) continue;
      for (const a of arr) {
        if (!a || !a.id) continue;
        if (targetBookId && a.bookId && a.bookId !== targetBookId) continue;
        if (deletedSet.has(a.id)) continue;
        if (clearedAfter && (a.createdAt || 0) <= clearedAfter) continue;
        const prev = byId.get(a.id);
        // Prefer entry with non-empty note or numeric offsets
        if (!prev || ((a.note || "").length >= (prev.note || "").length)) {
          byId.set(a.id, {
            ...prev,
            ...a,
            bookId: targetBookId || a.bookId || prev?.bookId || "",
            start: typeof a.start === "number" ? a.start : prev?.start ?? null,
            end: typeof a.end === "number" ? a.end : prev?.end ?? null,
          });
        }
      }
    }
    return Array.from(byId.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function mergeChatMessageLists(lists, clearedAfter = 0, targetBookId = "") {
    const byId = new Map();
    for (const arr of lists) {
      if (!Array.isArray(arr)) continue;
      for (const m of arr) {
        if (!m || !m.id) continue;
        if (targetBookId && m.bookId && m.bookId !== targetBookId) continue;
        if (clearedAfter && (m.createdAt || 0) <= clearedAfter) continue;
        byId.set(m.id, targetBookId && !m.bookId ? { ...m, bookId: targetBookId } : m);
      }
    }
    return Array.from(byId.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function persistChatLocally(bookId, ch, messages) {
    saveJSON(chatStorageKey(bookId, ch), messages);
    const existingAnns = chapterData[ch]?.annotations || loadJSON(annStorageKey(bookId, ch), []);
    idbSaveChapterState(bookId, ch, { annotations: existingAnns, chatMessages: messages });
  }

  /* ========================================================================
     1. DOM References
     ======================================================================== */
  const progressBar = document.getElementById("progressBar");
  const readingStat = document.getElementById("readingStat");
  const currentSectionLabel = document.getElementById("currentSectionLabel");
  const topBarSep = document.getElementById("topBarSep");
  const brandBookShort = document.getElementById("brandBookShort");

  const indexNavBtn = document.getElementById("indexNavBtn");
  const indexPage = document.getElementById("indexPage");
  const shelfIconsGrid = document.getElementById("shelfIconsGrid");
  const shelfSearchInput = document.getElementById("shelfSearchInput");
  const shelfAddBtn = document.getElementById("shelfAddBtn");
  const shelfCountAll = document.getElementById("shelfCountAll");
  const shelfCountBooks = document.getElementById("shelfCountBooks");
  const shelfCountPages = document.getElementById("shelfCountPages");

  const libraryOpenBtn = document.getElementById("libraryOpenBtn");
  const receiptUploadCta = document.getElementById("receiptUploadCta");
  const emptyStageCard = document.getElementById("emptyStageCard");
  const emptyStageUploadBtn = document.getElementById("emptyStageUploadBtn");
  const libraryModal = document.getElementById("libraryModal");
  const libraryCloseBtn = document.getElementById("libraryCloseBtn");
  const uploadDropzone = document.getElementById("uploadDropzone");
  const bookFileInput = document.getElementById("bookFileInput");
  const uploadBrowseBtn = document.getElementById("uploadBrowseBtn");
  const bookUrlForm = document.getElementById("bookUrlForm");
  const bookUrlInput = document.getElementById("bookUrlInput");
  const bookUrlSubmitBtn = document.getElementById("bookUrlSubmitBtn");
  const comicModeSelect = document.getElementById("comicModeSelect");
  const uploadStatusBar = document.getElementById("uploadStatusBar");
  const uploadStatusText = document.getElementById("uploadStatusText");
  const uploadStatusPct = document.getElementById("uploadStatusPct");
  const uploadProgressFill = document.getElementById("uploadProgressFill");
  const libraryBookCount = document.getElementById("libraryBookCount");
  const libraryGrid = document.getElementById("libraryGrid");

  const liveJobPill = document.getElementById("liveJobPill");
  const liveJobPillText = document.getElementById("liveJobPillText");

  const receiptPublisher = document.getElementById("receiptPublisher");
  const receiptPubDate = document.getElementById("receiptPubDate");
  const receiptBookTitle = document.getElementById("receiptBookTitle");
  const receiptBookSubtitle = document.getElementById("receiptBookSubtitle");
  const receiptAuthor = document.getElementById("receiptAuthor");
  const receiptItem = document.getElementById("receiptItem");
  const receiptFolio = document.getElementById("receiptFolio");
  const receiptNotes = document.getElementById("receiptNotes");
  const receiptSourceRow = document.getElementById("receiptSourceRow");
  const receiptSourceLink = document.getElementById("receiptSourceLink");
  const receiptBalanceDue = document.getElementById("receiptBalanceDue");
  const receiptTagline = document.getElementById("receiptTagline");
  const colophonTitle = document.getElementById("colophonTitle");
  const colophonPub = document.getElementById("colophonPub");

  const leftRail = document.getElementById("leftRail");
  const leftTocNav = document.getElementById("leftTocNav");
  const rightRail = document.getElementById("rightRail");
  const leftRailToggle = document.getElementById("leftRailToggle");
  const rightRailToggle = document.getElementById("rightRailToggle");
  const leftRailClose = document.getElementById("leftRailClose");
  const rightRailClose = document.getElementById("rightRailClose");
  const drawerBackdrop = document.getElementById("drawerBackdrop");

  const topChPicker = document.getElementById("topChPicker");
  const topChMenuToggle = document.getElementById("topChMenuToggle");
  const topChMenuPanel = document.getElementById("topChMenuPanel");
  const topChBadge = document.getElementById("topChBadge");
  const topChLabel = document.getElementById("topChLabel");

  const stageChapterBar = document.getElementById("stageChapterBar");
  const stageChMenuToggle = document.getElementById("stageChMenuToggle");
  const stageChMenuPanel = document.getElementById("stageChMenuPanel");
  const stageChEyebrow = document.getElementById("stageChEyebrow");
  const stageChTitle = document.getElementById("stageChTitle");
  const stageChPrev = document.getElementById("stageChPrev");
  const stageChNext = document.getElementById("stageChNext");
  const chaptersContainer = document.getElementById("chaptersContainer");

  const aiModelPillBtn = document.getElementById("aiModelPillBtn");
  const aiStatusText = document.getElementById("aiStatusText");
  const searchToggle = document.getElementById("searchToggle");
  const searchPanel = document.getElementById("searchPanel");
  const prefsToggle = document.getElementById("prefsToggle");
  const prefsPanel = document.getElementById("prefsPanel");
  const folioToggle = document.getElementById("folioToggle");

  const tabNotesBtn = document.getElementById("tabNotesBtn");
  const tabAiBtn = document.getElementById("tabAiBtn");
  const aiChatTabCount = document.getElementById("aiChatTabCount");
  const tabEndnotesBtn = document.getElementById("tabEndnotesBtn");
  const endnotesTabCount = document.getElementById("endnotesTabCount");
  const userNotesPane = document.getElementById("userNotesPane");
  const aiChatPane = document.getElementById("aiChatPane");
  const bookEndnotesPane = document.getElementById("bookEndnotesPane");
  const railEndnotesIntro = document.getElementById("railEndnotesIntro");
  const railEndnotesList = document.getElementById("railEndnotesList");

  const notesList = document.getElementById("notesList");
  const notesEmptyState = document.getElementById("notesEmptyState");
  const notesTabCount = document.getElementById("notesTabCount");
  const notesCountBadge = document.getElementById("notesCountBadge");
  const addStandaloneNoteBtn = document.getElementById("addStandaloneNoteBtn");
  const askAiWithAllNotesBtn = document.getElementById("askAiWithAllNotesBtn");
  const exportNotesBtn = document.getElementById("exportNotesBtn");
  const clearAllNotesBtn = document.getElementById("clearAllNotesBtn");

  const aiModelSelect = document.getElementById("aiModelSelect");
  const aiMessagesList = document.getElementById("aiMessagesList");
  const aiEmptyState = document.getElementById("aiEmptyState");
  const clearChatBtn = document.getElementById("clearChatBtn");
  const aiContextBox = document.getElementById("aiContextBox");
  const aiContextLoc = document.getElementById("aiContextLoc");
  const aiContextQuote = document.getElementById("aiContextQuote");
  const aiContextClearBtn = document.getElementById("aiContextClearBtn");
  const aiIncludeNotesCheck = document.getElementById("aiIncludeNotesCheck");
  const aiNotesAttachedCount = document.getElementById("aiNotesAttachedCount");
  const aiQuickPrompts = document.getElementById("aiQuickPrompts");
  const aiPromptInput = document.getElementById("aiPromptInput");
  const aiSendBtn = document.getElementById("aiSendBtn");
  const syncStatusBar = document.getElementById("syncStatusBar");
  const syncFooterText = document.getElementById("syncFooterText");

  const selectionToolbar = document.getElementById("selectionToolbar");
  const selectionAddNoteBtn = document.getElementById("selectionAddNoteBtn");
  const selectionAddEndnoteBtn = document.getElementById("selectionAddEndnoteBtn");
  const selectionAskAiBtn = document.getElementById("selectionAskAiBtn");
  const addEndnoteBtn = document.getElementById("addEndnoteBtn");

  const notePopover = document.getElementById("notePopover");
  const notePopoverTitle = document.getElementById("notePopoverTitle");
  const notePopoverJump = document.getElementById("notePopoverJump");
  const notePopoverClose = document.getElementById("notePopoverClose");
  const notePopoverContent = document.getElementById("notePopoverContent");

  /* ========================================================================
     2. Runtime State
     ======================================================================== */
  let libraryBooks = [];
  let currentBook = null;
  let CHAPTER_META = {};
  let CHAPTER_ORDER = [];
  let allChapterArticles = [];
  let allTocGroups = [];

  let activeChapter = "chapter-1";
  let chapterEl = null;
  let chapterData = {}; // slug -> { annotations, chatMessages }
  let annotations = [];
  let chatMessages = [];

  let pendingSelection = null;
  let selectedAnnotationId = null;
  let stagedAiHighlight = null;
  let activeNoteLink = null;
  let syncTimer = null;
  let pollTimer = null;
  let serverAvailable = false;
  let activeModel = "gemini-4-neon";
  let activeModelLabel = "Gemini 4 Neon";
  let activeView = "index"; // "index" | "reader"
  let shelfFilter = "all"; // "all" | "books" | "pages"
  let shelfQuery = "";

  const editingNoteIds = new Set();
  const expandedNoteIds = new Set();
  const editingEndnoteNums = new Set();
  const expandedEndnoteNums = new Set();
  const visualControllers = new Map(); // sectionId -> controller

  function escapeHTML(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const LATEX_SYMBOL_MAP = {
    "\\neq": "≠",
    "\\ne": "≠",
    "\\leq": "≤",
    "\\le": "≤",
    "\\geq": "≥",
    "\\ge": "≥",
    "\\approx": "≈",
    "\\equiv": "≡",
    "\\sim": "∼",
    "\\simeq": "≃",
    "\\cong": "≅",
    "\\times": "×",
    "\\cdot": "·",
    "\\pm": "±",
    "\\mp": "∓",
    "\\infty": "∞",
    "\\partial": "∂",
    "\\nabla": "∇",
    "\\forall": "∀",
    "\\exists": "∃",
    "\\in": "∈",
    "\\notin": "∉",
    "\\subset": "⊂",
    "\\subseteq": "⊆",
    "\\subsetneq": "⊊",
    "\\supset": "⊃",
    "\\supseteq": "⊇",
    "\\cup": "∪",
    "\\cap": "∩",
    "\\to": "→",
    "\\rightarrow": "→",
    "\\leftarrow": "←",
    "\\Rightarrow": "⇒",
    "\\Leftrightarrow": "⇔",
    "\\iff": "⟺",
    "\\lceil": "⌈",
    "\\rceil": "⌉",
    "\\lfloor": "⌊",
    "\\rfloor": "⌋",
    "\\alpha": "α",
    "\\beta": "β",
    "\\gamma": "γ",
    "\\delta": "δ",
    "\\epsilon": "ε",
    "\\varepsilon": "ε",
    "\\zeta": "ζ",
    "\\eta": "η",
    "\\theta": "θ",
    "\\lambda": "λ",
    "\\mu": "μ",
    "\\nu": "ν",
    "\\xi": "ξ",
    "\\pi": "π",
    "\\rho": "ρ",
    "\\sigma": "σ",
    "\\tau": "τ",
    "\\phi": "φ",
    "\\varphi": "φ",
    "\\chi": "χ",
    "\\psi": "ψ",
    "\\omega": "ω",
    "\\Gamma": "Γ",
    "\\Delta": "Δ",
    "\\Theta": "Θ",
    "\\Lambda": "Λ",
    "\\Pi": "Π",
    "\\Sigma": "Σ",
    "\\Phi": "Φ",
    "\\Psi": "Ψ",
    "\\Omega": "Ω",
    "\\log": "log",
    "\\ln": "ln",
    "\\exp": "exp",
    "\\sin": "sin",
    "\\cos": "cos",
    "\\max": "max",
    "\\min": "min",
    "\\poly": "poly",
  };

  function fallbackLatexToHTML(tex) {
    let s = escapeHTML(String(tex || "").trim());
    s = s.replace(/\\(?:mathrm|mathbf|mathsf|mathcal|mathbb|operatorname|text)\{([^{}]*)\}/g, "$1");
    s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");
    for (const [k, v] of Object.entries(LATEX_SYMBOL_MAP)) {
      s = s.split(k).join(v);
    }
    s = s
      .replace(/\^\{([^{}]+)\}/g, "<sup>$1</sup>")
      .replace(/\^([A-Za-z0-9+-])/g, "<sup>$1</sup>")
      .replace(/_\{([^{}]+)\}/g, "<sub>$1</sub>")
      .replace(/_([A-Za-z0-9+-])/g, "<sub>$1</sub>")
      .replace(/\\([{}])/g, "$1")
      .replace(/[{}]/g, "");
    return `<span class="math-fallback">${s}</span>`;
  }

  function renderLatexToHTML(tex, displayMode = false) {
    const cleanTex = String(tex || "").trim();
    if (!cleanTex) return "";
    if (window.katex && typeof window.katex.renderToString === "function") {
      try {
        return window.katex.renderToString(cleanTex, {
          displayMode,
          throwOnError: false,
          strict: "ignore",
        });
      } catch (_) {
        // Fall through to clean HTML fallback
      }
    }
    const fb = fallbackLatexToHTML(cleanTex);
    return displayMode ? `<div class="md-math-block">${fb}</div>` : fb;
  }

  function renderMathInHtmlSnippet(htmlStr) {
    if (!htmlStr) return "";
    let out = String(htmlStr);
    out = out.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, m1, m2) =>
      renderLatexToHTML(m1 || m2, true)
    );
    out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_, m1) => renderLatexToHTML(m1, false));
    out = out.replace(/\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$/g, (full, inner) => {
      if (/^\d[\d,.]*\s+[A-Za-z]/.test(inner)) return full;
      return renderLatexToHTML(inner, false);
    });
    return out;
  }

  function renderEndnoteContentHTML(noteObj, extraCls = "") {
    if (noteObj && typeof noteObj.rawText === "string" && noteObj.rawText.trim()) {
      const raw = noteObj.rawText.trim();
      const isMultiBlock = /\n|^#{1,4}\s|^[-*•]\s|^\d+[.)]\s/.test(raw);
      if (isMultiBlock) {
        return `<div class="md-prose endnote-prose ${extraCls}">${formatAiTextToHTML(raw)}</div>`;
      }
      const singleHtml = formatAiTextToHTML(raw).replace(/^<p>([\s\S]*)<\/p>$/, "$1");
      return `<span class="endnote-inline">${singleHtml}</span>`;
    }
    return renderMathInHtmlSnippet(noteObj?.html || "");
  }

  function formatInlineMarkdown(escapedLine) {
    // Use underscore-free, asterisk-free %%...%% tokens so italic/bold regexes never collide with tokens!
    const linkTokens = [];
    let withTokens = escapedLine.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, label, url) => {
        const idx = linkTokens.length;
        linkTokens.push(
          `<a href="${url}" target="_blank" rel="noopener noreferrer" class="md-link">${label}</a>`
        );
        return `%%MDLINK${idx}%%`;
      }
    );

    // Auto-link bare https://... URLs (stripping trailing punctuation cleanly)
    withTokens = withTokens.replace(
      /(^|[\s(>])(https?:\/\/[^\s<)"']+)/g,
      (full, prefix, rawUrl) => {
        const trailMatch = rawUrl.match(/([.,;:!?)]+)$/);
        const cleanUrl = trailMatch ? rawUrl.slice(0, -trailMatch[1].length) : rawUrl;
        const trailing = trailMatch ? trailMatch[1] : "";
        const idx = linkTokens.length;
        linkTokens.push(
          `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="md-link">${cleanUrl}</a>`
        );
        return `${prefix}%%MDLINK${idx}%%${trailing}`;
      }
    );

    let formatted = withTokens
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/__(.+?)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1<em>$2</em>");

    linkTokens.forEach((anchorHtml, idx) => {
      formatted = formatted.split(`%%MDLINK${idx}%%`).join(anchorHtml);
    });
    return formatted;
  }

  function formatAiTextToHTML(raw) {
    const protectedTokens = [];
    const stashToken = (renderedHtml) => {
      const idx = protectedTokens.length;
      protectedTokens.push(renderedHtml);
      return `%%PROT${idx}%%`;
    };

    // 1. Protect inline `code` spans first so literal $VARS inside code are untouched
    let pre = String(raw || "")
      .replace(/\r\n/g, "\n")
      .replace(/`([^`\n]+)`/g, (_, codeBody) => stashToken(`<code>${escapeHTML(codeBody)}</code>`));

    // 2. Extract multi-line or single-line Display Math ($$...$$ and \[...\])
    pre = pre.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, m1, m2) => {
      const htmlMath = `<div class="md-math-block">${renderLatexToHTML(m1 || m2, true)}</div>`;
      return `\n${stashToken(htmlMath)}\n`;
    });

    // 3. Extract Inline Math (\(...\) and $...$) before Markdown escaping/emphasis
    pre = pre.replace(/\\\(([\s\S]+?)\\\)/g, (_, m1) => stashToken(renderLatexToHTML(m1, false)));
    pre = pre.replace(/\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$/g, (full, inner) => {
      // Skip accidental currency spans like "$100 and $200"
      if (/^\d[\d,.]*\s+[A-Za-z]/.test(inner)) return full;
      return stashToken(renderLatexToHTML(inner, false));
    });

    const lines = pre.split("\n");
    const htmlBlocks = [];
    let paraLines = [];
    let listType = null;
    let listItems = [];
    let quoteLines = [];

    function flushParagraph() {
      if (!paraLines.length) return;
      htmlBlocks.push(`<p>${paraLines.map(formatInlineMarkdown).join("<br/>")}</p>`);
      paraLines = [];
    }
    function flushList() {
      if (!listItems.length) return;
      const tag = listType === "ol" ? "ol" : "ul";
      htmlBlocks.push(
        `<${tag} class="md-list">${listItems.map((li) => `<li>${formatInlineMarkdown(li)}</li>`).join("")}</${tag}>`
      );
      listType = null;
      listItems = [];
    }
    function flushQuote() {
      if (!quoteLines.length) return;
      htmlBlocks.push(`<blockquote class="md-quote">${quoteLines.map(formatInlineMarkdown).join("<br/>")}</blockquote>`);
      quoteLines = [];
    }

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        flushParagraph();
        flushList();
        flushQuote();
        continue;
      }
      if (/^%%PROT\d+%%$/.test(trimmed)) {
        flushParagraph();
        flushList();
        flushQuote();
        htmlBlocks.push(trimmed);
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
        flushParagraph();
        flushList();
        flushQuote();
        htmlBlocks.push('<hr class="md-hr" />');
        continue;
      }
      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        flushParagraph();
        flushList();
        flushQuote();
        const level = headingMatch[1].length <= 2 ? "md-h3" : "md-h4";
        htmlBlocks.push(`<h4 class="${level}">${formatInlineMarkdown(escapeHTML(headingMatch[2]))}</h4>`);
        continue;
      }
      const quoteMatch = trimmed.match(/^>\s?(.*)$/);
      if (quoteMatch) {
        flushParagraph();
        flushList();
        quoteLines.push(escapeHTML(quoteMatch[1]));
        continue;
      }
      const ulMatch = trimmed.match(/^[-*•]\s+(.+)$/);
      if (ulMatch) {
        flushParagraph();
        flushQuote();
        if (listType && listType !== "ul") flushList();
        listType = "ul";
        listItems.push(escapeHTML(ulMatch[1]));
        continue;
      }
      const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
      if (olMatch) {
        flushParagraph();
        flushQuote();
        if (listType && listType !== "ol") flushList();
        listType = "ol";
        listItems.push(escapeHTML(olMatch[1]));
        continue;
      }
      flushList();
      flushQuote();
      paraLines.push(escapeHTML(trimmed));
    }

    flushParagraph();
    flushList();
    flushQuote();

    let finalHtml = htmlBlocks.join("");
    protectedTokens.forEach((renderedHtml, idx) => {
      finalHtml = finalHtml.split(`%%PROT${idx}%%`).join(renderedHtml);
    });
    return finalHtml;
  }

  /* ========================================================================
     3. Display Preferences (Paper / Sepia / Night, Size, Measure, Folios)
     ======================================================================== */
  const prefs = Object.assign(
    { theme: "paper", size: "md", width: "book", folios: "show" },
    loadJSON(PREFS_KEY, {})
  );

  function applyPrefs() {
    root.setAttribute("data-theme", prefs.theme);
    root.setAttribute("data-size", prefs.size);
    root.setAttribute("data-width", prefs.width);
    root.setAttribute("data-folios", prefs.folios);

    document.querySelectorAll("[data-set-theme]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.setTheme === prefs.theme);
    });
    document.querySelectorAll("[data-set-size]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.setSize === prefs.size);
    });
    document.querySelectorAll("[data-set-width]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.setWidth === prefs.width);
    });
    if (folioToggle) folioToggle.checked = prefs.folios === "show";
  }

  applyPrefs();

  document.querySelectorAll("[data-set-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      prefs.theme = btn.dataset.setTheme;
      applyPrefs();
      saveJSON(PREFS_KEY, prefs);
    });
  });
  document.querySelectorAll("[data-set-size]").forEach((btn) => {
    btn.addEventListener("click", () => {
      prefs.size = btn.dataset.setSize;
      applyPrefs();
      saveJSON(PREFS_KEY, prefs);
    });
  });
  document.querySelectorAll("[data-set-width]").forEach((btn) => {
    btn.addEventListener("click", () => {
      prefs.width = btn.dataset.setWidth;
      applyPrefs();
      saveJSON(PREFS_KEY, prefs);
    });
  });
  if (folioToggle) {
    folioToggle.addEventListener("change", () => {
      prefs.folios = folioToggle.checked ? "show" : "hide";
      applyPrefs();
      saveJSON(PREFS_KEY, prefs);
    });
  }

  /* ========================================================================
     4. Dropdowns, Mobile Drawers & Library Modal
     ======================================================================== */
  const dropdowns = [
    { toggle: searchToggle, panel: searchPanel },
    { toggle: prefsToggle, panel: prefsPanel },
    { toggle: topChMenuToggle, panel: topChMenuPanel },
    { toggle: stageChMenuToggle, panel: stageChMenuPanel },
  ];

  function closeAllDropdowns(exceptPanel) {
    dropdowns.forEach(({ toggle, panel }) => {
      if (panel && toggle && panel !== exceptPanel) {
        panel.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  dropdowns.forEach(({ toggle, panel }) => {
    if (!toggle || !panel) return;
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = panel.hidden;
      closeAllDropdowns(panel);
      panel.hidden = !willOpen;
      toggle.setAttribute("aria-expanded", String(willOpen));
      if (willOpen && panel === searchPanel) {
        document.getElementById("searchInput").focus();
      }
    });
    panel.addEventListener("click", (e) => e.stopPropagation());
  });

  function isDesktopRails() {
    return window.matchMedia("(min-width: 72rem)").matches;
  }

  function closeMobileDrawers() {
    leftRail.classList.remove("is-open");
    rightRail.classList.remove("is-open");
    leftRailToggle.setAttribute("aria-expanded", "false");
    rightRailToggle.setAttribute("aria-expanded", "false");
    drawerBackdrop.hidden = true;
  }

  function openLeftDrawer() {
    closeMobileDrawers();
    leftRail.classList.add("is-open");
    leftRailToggle.setAttribute("aria-expanded", "true");
    drawerBackdrop.hidden = false;
  }

  function openRightDrawer() {
    closeMobileDrawers();
    rightRail.classList.add("is-open");
    rightRailToggle.setAttribute("aria-expanded", "true");
    drawerBackdrop.hidden = false;
  }

  leftRailToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    leftRail.classList.contains("is-open") ? closeMobileDrawers() : openLeftDrawer();
  });
  rightRailToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    rightRail.classList.contains("is-open") ? closeMobileDrawers() : openRightDrawer();
  });
  leftRailClose.addEventListener("click", closeMobileDrawers);
  rightRailClose.addEventListener("click", closeMobileDrawers);
  drawerBackdrop.addEventListener("click", closeMobileDrawers);

  function switchRightTab(tabName, persistChoice = true) {
    const validName = ["notes", "ai", "endnotes"].includes(tabName) ? tabName : "notes";
    const tabs = [
      { name: "notes", btn: tabNotesBtn, pane: userNotesPane },
      { name: "ai", btn: tabAiBtn, pane: aiChatPane },
      { name: "endnotes", btn: tabEndnotesBtn, pane: bookEndnotesPane },
    ];
    tabs.forEach(({ name, btn, pane }) => {
      const active = name === validName;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
      pane.hidden = !active;
    });
    if (persistChoice) {
      saveJSON(RIGHT_TAB_KEY, validName);
    }
    if (validName === "ai" && aiMessagesList) {
      requestAnimationFrame(() => {
        aiMessagesList.scrollTop = aiMessagesList.scrollHeight;
      });
    }
  }

  // Restore last active right-sidebar tab across page refreshes
  switchRightTab(loadJSON(RIGHT_TAB_KEY, "notes"), false);

  tabNotesBtn.addEventListener("click", () => switchRightTab("notes"));
  tabAiBtn.addEventListener("click", () => switchRightTab("ai"));
  tabEndnotesBtn.addEventListener("click", () => switchRightTab("endnotes"));

  aiModelPillBtn.addEventListener("click", () => {
    switchRightTab("ai");
    if (!isDesktopRails()) openRightDrawer();
    requestAnimationFrame(() => aiPromptInput.focus());
  });

  function setAppView(viewName) {
    activeView = viewName === "reader" ? "reader" : "index";
    root.setAttribute("data-view", activeView);
    if (activeView === "index") {
      document.title = "Imprint | Library Index";
      closeAllDropdowns(null);
      closeNotePopover();
      hideSelectionToolbar();
    } else if (currentBook) {
      document.title = `${currentBook.title} | ${currentBook.author} — Imprint`;
      requestAnimationFrame(fitReceiptTitle);
    }
  }

  function showIndexPage(pushHash = true) {
    setAppView("index");
    renderShelfIcons();
    if (pushHash && window.location.hash !== "#index") {
      history.pushState(null, "", "#index");
    }
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  function openLibraryModal() {
    refreshLibraryList();
    libraryModal.hidden = false;
  }

  function closeLibraryModal() {
    libraryModal.hidden = true;
  }

  if (indexNavBtn) {
    indexNavBtn.addEventListener("click", () => showIndexPage(true));
  }
  if (shelfAddBtn) {
    shelfAddBtn.addEventListener("click", openLibraryModal);
  }
  libraryOpenBtn.addEventListener("click", openLibraryModal);
  receiptUploadCta.addEventListener("click", openLibraryModal);
  emptyStageUploadBtn.addEventListener("click", openLibraryModal);
  liveJobPill.addEventListener("click", openLibraryModal);
  libraryCloseBtn.addEventListener("click", closeLibraryModal);
  libraryModal.addEventListener("click", (e) => {
    if (e.target === libraryModal) closeLibraryModal();
  });

  /* ========================================================================
     5. SVG Diagram & Story Comic HTML Builders (Overflow-Proof Wrapping)
     ======================================================================== */
  function splitSvgLines(raw, maxCharsPerLine, maxLines = 2) {
    const clean = String(raw || "").replace(/\s+/g, " ").trim();
    if (!clean) return [""];
    const words = clean.split(" ");
    const lines = [];
    let current = "";

    for (const w of words) {
      const candidate = current ? `${current} ${w}` : w;
      if (candidate.length <= maxCharsPerLine || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = w;
      }
    }
    if (current) lines.push(current);

    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      const tail = lines.slice(maxLines - 1).join(" ");
      kept[maxLines - 1] =
        tail.length > maxCharsPerLine + 2
          ? tail.slice(0, Math.max(6, maxCharsPerLine - 1)).trimEnd() + "…"
          : tail;
      return kept;
    }
    return lines;
  }

  function renderSvgTextLines(lines, x, firstY, lineHeight, className, maxPxWidth) {
    return lines
      .map((ln, idx) => {
        const y = firstY + idx * lineHeight;
        // Clamp width gently if an individual word/line is unusually wide
        const approxCharPx = className.includes("sv-box-title") ? 7.2 : className.includes("sv-mono-label") ? 6.8 : 5.9;
        const clampAttr =
          maxPxWidth && ln.length * approxCharPx > maxPxWidth
            ? ` textLength="${maxPxWidth}" lengthAdjust="spacingAndGlyphs"`
            : "";
        return `<text x="${x}" y="${y}" text-anchor="middle" class="${className}"${clampAttr}>${escapeHTML(ln)}</text>`;
      })
      .join("");
  }

  function renderDiagramBox(box, x, width, boxClass, titleClass) {
    const cx = x + width / 2;
    const titleLines = splitSvgLines(box?.title || "CONCEPT", 15, 2);
    const subLines = splitSvgLines(box?.sub || "", 21, 2);
    const titleStartY = titleLines.length > 1 ? 66 : 73;
    const subStartY = titleLines.length > 1 ? 94 : 92;

    return `
      <rect x="${x}" y="48" width="${width}" height="66" rx="6" class="${boxClass}" />
      ${renderSvgTextLines(titleLines, cx, titleStartY, 13, titleClass, width - 14)}
      ${renderSvgTextLines(subLines, cx, subStartY, 12, "sv-sub-label", width - 14)}
    `;
  }

  function renderDiagramSVG(diagram) {
    const d = diagram || {};
    const headingLines = splitSvgLines(d.heading || "CONCEPT DIAGRAM", 52, 1);
    const footerLines = splitSvgLines(d.footer || "", 64, 2);
    const svgHeight = footerLines.length > 1 ? 192 : 180;

    return `<svg viewBox="0 0 640 ${svgHeight}" role="img" aria-label="${escapeHTML(d.heading || "Concept Diagram")}">
      ${renderSvgTextLines(headingLines, 320, 26, 13, "sv-mono-label", 548)}
      ${renderDiagramBox(d.box1 || { title: "PREMISE" }, 44, 144, "sv-card-box", "sv-box-title")}
      <line x1="194" y1="81" x2="242" y2="81" class="sv-flow-dots sv-flow-dots--indigo" />
      ${renderDiagramBox(d.box2 || { title: "MECHANISM" }, 248, 144, "sv-card-box sv-card-box--indigo", "sv-box-title sv-indigo-fill")}
      <line x1="398" y1="81" x2="446" y2="81" class="sv-flow-dots" />
      ${renderDiagramBox(d.box3 || { title: "OUTCOME" }, 452, 144, "sv-card-box sv-card-box--heavy", "sv-box-title sv-accent-fill")}
      <line x1="44" y1="130" x2="596" y2="130" class="sv-divider-dash" />
      ${renderSvgTextLines(footerLines, 320, 154, 15, "sv-box-title", 548)}
    </svg>`;
  }

  function renderComicPlayerInner(chSlug, sec) {
    const beats = Array.isArray(sec.beats) && sec.beats.length === 4
      ? sec.beats
      : ["1. Opening", "2. Core Claim", "3. Turning Point", "4. Outcome"];

    if (sec.comicUrl) {
      return `
        <div class="comic-stage" data-zoom="0" title="Click any corner vignette to zoom in, or click again for full scene">
          <img src="${escapeHTML(sec.comicUrl)}" alt="${escapeHTML(sec.title)} Story Comic" class="comic-img" loading="lazy" />
        </div>
        <div class="comic-beats" role="tablist" aria-label="Story comic tour">
          <button type="button" class="comic-beat is-active" data-beat="0" title="Full Scene">Full Scene</button>
          <button type="button" class="comic-beat" data-beat="1" title="${escapeHTML(beats[0])}">${escapeHTML(beats[0])}</button>
          <button type="button" class="comic-beat" data-beat="2" title="${escapeHTML(beats[1])}">${escapeHTML(beats[1])}</button>
          <button type="button" class="comic-beat" data-beat="3" title="${escapeHTML(beats[2])}">${escapeHTML(beats[2])}</button>
          <button type="button" class="comic-beat" data-beat="4" title="${escapeHTML(beats[3])}">${escapeHTML(beats[3])}</button>
        </div>
      `;
    }

    const isSkippedOrFailed = sec.comicStatus === "skipped" || sec.comicStatus === "failed";
    return `
      <div class="comic-placeholder">
        ${isSkippedOrFailed ? "" : '<div class="comic-placeholder__spinner" aria-hidden="true"></div>'}
        <p class="comic-placeholder__title">${
          isSkippedOrFailed
            ? "Story Comic Ready to Illustrate on Demand"
            : "Gemini is Illustrating This 16:9 Story Comic in the Background…"
        }</p>
        <p class="comic-placeholder__desc">${
          isSkippedOrFailed
            ? "Click below to generate a custom 16:9 pen-and-ink + watercolor Story Comic for this section."
            : "You can read the full chapter text and explore the animated SVG Diagram now; the comic will appear here automatically as soon as it finishes."
        }</p>
        <button type="button" class="studio-primary-btn" data-gen-comic-sec="${escapeHTML(
          sec.id
        )}" data-gen-comic-ch="${escapeHTML(chSlug)}">${
      isSkippedOrFailed ? "✨ Illustrate Story Comic" : "✨ Prioritize This Comic Now"
    }</button>
      </div>
    `;
  }

  function decorateOpeningParagraphHTML(rawHtml) {
    // Preserve leading folio-marker before dropcap
    let prefixFolio = "";
    let body = String(rawHtml || "").trim();
    const folioMatch = body.match(/^(<span class="folio-marker"[^>]*>.*?<\/span>)\s*/i);
    if (folioMatch) {
      prefixFolio = folioMatch[1];
      body = body.slice(folioMatch[0].length);
    }

    // Only apply dropcap if starts with a plain ASCII/Latin letter or quote + letter
    const leadMatch = body.match(/^([“"']?[A-Za-z])([^<]{1,40})/);
    if (!leadMatch) {
      return `${prefixFolio}${body}`;
    }
    const firstCluster = leadMatch[1];
    const restText = body.slice(firstCluster.length);
    const wordsMatch = restText.match(/^(\S*(?:\s+\S+){0,2})([\s\S]*)$/);
    if (!wordsMatch) {
      return `${prefixFolio}<span class="dropcap">${firstCluster}</span>${restText}`;
    }
    return `${prefixFolio}<span class="dropcap">${firstCluster}</span><span class="smallcaps-lead">${wordsMatch[1]}</span>${wordsMatch[2]}`;
  }

  /* ========================================================================
     6. Render Full Book into the 3-Column Editorial Workbench
     ======================================================================== */
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function destroyVisualControllers() {
    for (const ctrl of visualControllers.values()) {
      ctrl.destroy();
    }
    visualControllers.clear();
  }

  function bindSectionVisual(fig) {
    const secId = fig.dataset.sectionId;
    if (visualControllers.has(secId)) {
      visualControllers.get(secId).destroy();
    }

    const loc = fig.getAttribute("data-section-ref") || "Chapter";
    const toggleBtn = fig.querySelector("[data-toggle-anim]");
    const comicPlayer = fig.querySelector("[data-comic-player]");
    const svgPane = fig.querySelector("[data-svg-pane]");
    const hasComicImg = Boolean(comicPlayer && comicPlayer.querySelector(".comic-img"));

    let activeMode = hasComicImg ? "comic" : "diagram";
    let paused = prefersReducedMotion;
    let comicBeatIdx = 0;
    let timerId = null;
    let visObs = null;

    function syncModePanes() {
      fig.querySelectorAll("[data-view-mode]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.viewMode === activeMode);
      });
      if (comicPlayer) comicPlayer.hidden = activeMode !== "comic";
      if (svgPane) svgPane.hidden = activeMode !== "diagram";
    }

    function showComicBeat(beatIndex) {
      comicBeatIdx = beatIndex;
      const stage = comicPlayer ? comicPlayer.querySelector(".comic-stage") : null;
      const beats = comicPlayer ? Array.from(comicPlayer.querySelectorAll(".comic-beat")) : [];
      if (stage) stage.setAttribute("data-zoom", String(beatIndex));
      beats.forEach((btn, idx) => btn.classList.toggle("is-active", idx === beatIndex));
    }

    function restartLoopTimer() {
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
      if (paused) return;
      const beats = comicPlayer ? comicPlayer.querySelectorAll(".comic-beat") : [];
      if (activeMode === "comic" && beats.length > 1) {
        timerId = setInterval(() => {
          const parentArt = fig.closest(".chapter");
          if (parentArt && (parentArt.hidden || !parentArt.classList.contains("is-active"))) return;
          const next = (comicBeatIdx + 1) % beats.length;
          showComicBeat(next);
        }, 2800);
      }
    }

    function setPausedState(nextPaused) {
      paused = nextPaused;
      fig.classList.toggle("is-paused", paused);
      if (toggleBtn) {
        toggleBtn.textContent = paused ? "Play" : "Pause";
        toggleBtn.setAttribute("aria-pressed", String(paused));
      }
      restartLoopTimer();
    }

    function bindComicInteractions() {
      if (!comicPlayer) return;
      const stage = comicPlayer.querySelector(".comic-stage");
      const beats = Array.from(comicPlayer.querySelectorAll(".comic-beat"));

      beats.forEach((beatBtn) => {
        beatBtn.addEventListener("click", () => {
          const idx = Number(beatBtn.dataset.beat || 0);
          showComicBeat(idx);
          setPausedState(true);
        });
      });

      if (stage) {
        stage.addEventListener("click", (e) => {
          const currentZoom = Number(stage.getAttribute("data-zoom") || 0);
          if (currentZoom !== 0) {
            showComicBeat(0);
            setPausedState(true);
            return;
          }
          const rect = stage.getBoundingClientRect();
          const rx = (e.clientX - rect.left) / rect.width;
          const ry = (e.clientY - rect.top) / rect.height;
          let targetBeat = 2;
          if (rx < 0.34) targetBeat = 1;
          else if (rx > 0.66) targetBeat = ry < 0.54 ? 3 : 4;
          showComicBeat(targetBeat);
          setPausedState(true);
        });
      }

      const genBtn = comicPlayer.querySelector("[data-gen-comic-sec]");
      if (genBtn) {
        genBtn.addEventListener("click", async () => {
          if (!currentBook) return;
          genBtn.disabled = true;
          genBtn.textContent = "Illustrating Story Comic (~12s)…";
          try {
            const res = await fetch(`/api/books/${encodeURIComponent(currentBook.id)}/generate-comic`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chapter: genBtn.dataset.genComicCh,
                sectionId: genBtn.dataset.genComicSec,
              }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Comic generation failed");
            // Hot-inject new comic URL
            const chObj = (currentBook.chapters || []).find((c) => c.slug === genBtn.dataset.genComicCh);
            const secObj = (chObj?.sections || []).find((s) => s.id === genBtn.dataset.genComicSec);
            if (secObj) {
              secObj.comicUrl = data.comicUrl;
              secObj.comicStatus = "ready";
              comicPlayer.innerHTML = renderComicPlayerInner(chObj.slug, secObj);
              bindComicInteractions();
              activeMode = "comic";
              syncModePanes();
              restartLoopTimer();
              idbSaveBook(currentBook);
            }
          } catch (err) {
            genBtn.disabled = false;
            genBtn.textContent = `Retry Comic (${err.message.slice(0, 32)})`;
          }
        });
      }
    }

    syncModePanes();
    bindComicInteractions();

    if ("IntersectionObserver" in window) {
      visObs = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              if (!paused && !timerId) restartLoopTimer();
            } else if (timerId) {
              clearInterval(timerId);
              timerId = null;
            }
          });
        },
        { rootMargin: "200px 0px" }
      );
      visObs.observe(fig);
    } else if (!paused) {
      restartLoopTimer();
    }

    if (toggleBtn) {
      toggleBtn.textContent = paused ? "Play" : "Pause";
      toggleBtn.setAttribute("aria-pressed", String(paused));
      toggleBtn.addEventListener("click", () => setPausedState(!paused));
    }

    fig.querySelectorAll("[data-view-mode]").forEach((modeBtn) => {
      modeBtn.addEventListener("click", () => {
        activeMode = modeBtn.dataset.viewMode;
        syncModePanes();
        restartLoopTimer();
      });
    });

    const askBtn = fig.querySelector("[data-visual-ask]");
    if (askBtn) {
      askBtn.addEventListener("click", () => {
        stageHighlightForAi({
          id: null,
          quote: askBtn.getAttribute("data-visual-ask") || "",
          locLabel: `${loc} · Key Quote`,
          note: "",
        });
      });
    }

    visualControllers.set(secId, {
      hotInjectComic(chSlug, secObj) {
        if (!comicPlayer) return;
        comicPlayer.innerHTML = renderComicPlayerInner(chSlug, secObj);
        bindComicInteractions();
        activeMode = "comic";
        syncModePanes();
        restartLoopTimer();
      },
      destroy() {
        if (timerId) clearInterval(timerId);
        if (visObs) visObs.disconnect();
      },
    });
  }

  function computeTitleTier(titleStr) {
    const clean = String(titleStr || "").trim().toUpperCase();
    const totalLen = clean.length;
    const words = clean.split(/[\s—–-]+/).filter(Boolean);
    const maxWordLen = words.reduce((m, w) => Math.max(m, w.length), 0);

    if (totalLen <= 8 && maxWordLen <= 6) return "short";
    if (totalLen <= 16 && maxWordLen <= 9) return "medium";
    if (totalLen <= 34 && maxWordLen <= 13) return "long";
    return "xlong";
  }

  function fitReceiptTitle() {
    if (!receiptBookTitle) return;
    receiptBookTitle.style.fontSize = "";
    receiptBookTitle.style.letterSpacing = "";

    const containerWidth = receiptBookTitle.clientWidth;
    if (!containerWidth) return;

    // Guarantee zero horizontal overflow even for unusually long single words or narrow viewports
    let computed = parseFloat(window.getComputedStyle(receiptBookTitle).fontSize) || 24;
    let guard = 0;
    while (receiptBookTitle.scrollWidth > receiptBookTitle.clientWidth + 1 && computed > 13.5 && guard < 20) {
      computed -= 1.5;
      receiptBookTitle.style.fontSize = `${computed}px`;
      if (computed < 20) {
        receiptBookTitle.style.letterSpacing = "0.04em";
      }
      guard++;
    }
  }

  window.addEventListener("resize", () => {
    requestAnimationFrame(fitReceiptTitle);
  });

  function updateBookMasthead(book) {
    const cleanWords = (book.title || "BOOK")
      .replace(/^(the|a|an)\s+/i, "")
      .split(/\s+/)
      .filter(Boolean);
    let shortBrand = (cleanWords[0] || "BOOK").toUpperCase();
    if (cleanWords.length > 1 && `${shortBrand} ${cleanWords[1]}`.length <= 12) {
      shortBrand = `${shortBrand} ${cleanWords[1].toUpperCase()}`;
    }

    const titleUpper = (book.title || "UNTITLED").trim().toUpperCase();
    brandBookShort.textContent = shortBrand.slice(0, 14) || "BOOK";
    brandBookShort.title = book.title || "";
    receiptPublisher.textContent = (book.publisherMeta || "DIGITAL EDITION").toUpperCase();
    receiptPubDate.textContent = (book.pubDate || `${(book.chapters || []).length} CHAPTERS`).toUpperCase();
    receiptBookTitle.textContent = titleUpper;
    receiptBookTitle.setAttribute("data-title-tier", computeTitleTier(titleUpper));
    receiptBookSubtitle.textContent = (book.subtitle || `${(book.wordCount || 0).toLocaleString()} WORDS`).toUpperCase();
    receiptAuthor.textContent = (book.author || "").toUpperCase();
    receiptBalanceDue.textContent = (book.balanceDue || "OPEN EDITION").toUpperCase();
    if (book.tagline) receiptTagline.textContent = book.tagline;
    if (receiptSourceRow && receiptSourceLink) {
      if (book.sourceUrl) {
        receiptSourceRow.hidden = false;
        receiptSourceLink.href = book.sourceUrl;
        let shortHost = book.sourceUrl.replace(/^https?:\/\/(www\.)?/i, "");
        if (shortHost.length > 26) shortHost = shortHost.slice(0, 25) + "…";
        receiptSourceLink.textContent = `${shortHost.toUpperCase()} ↗`;
        receiptSourceLink.title = book.sourceUrl;
      } else {
        receiptSourceRow.hidden = true;
      }
    }

    requestAnimationFrame(fitReceiptTitle);

    colophonTitle.innerHTML = `<em>${escapeHTML(book.title)}${
      book.subtitle ? ": " + escapeHTML(book.subtitle) : ""
    }</em> &mdash; ${escapeHTML(book.author)}`;
    colophonPub.textContent = `${book.publisherMeta || "Digital Edition"}${
      book.pubDate ? " · " + book.pubDate : ""
    } · ${(book.chapters || []).length} chapters · ${(book.wordCount || 0).toLocaleString()} words · Imprint Edition`;
    document.title = `${book.title} | ${book.author} — Imprint`;
  }

  function formatChapterBadge(chLabel, fallbackNum) {
    const lbl = String(chLabel || "").trim();
    const mNum = lbl.match(/^chapter\s+(\d+|[ivxlcdm]+)$/i);
    if (mNum) return `Ch. ${mNum[1]}`;
    const mApp = lbl.match(/^appendix\s+([a-z0-9]+)$/i);
    if (mApp) return `App. ${mApp[1].toUpperCase()}`;
    if (/^preface$/i.test(lbl)) return "Pref.";
    if (/^introduction$/i.test(lbl)) return "Intro";
    if (/^acknowledg/i.test(lbl)) return "Ack.";
    return `Ch. ${fallbackNum}`;
  }

  function rebuildChapterMenus(book) {
    const chapters = book.chapters || [];
    const total = chapters.length;

    const itemsHtml = chapters
      .map((ch) => {
        const notesCnt = (ch.endnotes || []).length;
        const metaStr = notesCnt > 0
          ? `pp. ${ch.folioStart}–${ch.folioEnd} &middot; ${notesCnt} notes`
          : `pp. ${ch.folioStart}–${ch.folioEnd} &middot; ${(ch.wordCount || 0).toLocaleString()} words`;
        return `
          <button type="button" class="ch-menu-item ${ch.slug === activeChapter ? "is-active" : ""}" role="menuitemradio" aria-checked="${
          ch.slug === activeChapter
        }" data-switch-chapter="${escapeHTML(ch.slug)}">
            <span class="ch-menu-item__badge">${escapeHTML(formatChapterBadge(ch.chapterLabel, ch.num))}</span>
            <span class="ch-menu-item__body">
              <span class="ch-menu-item__title">${escapeHTML(ch.title)}</span>
              <span class="ch-menu-item__meta">${metaStr}</span>
            </span>
            <span class="ch-menu-item__check" aria-hidden="true">&#10003;</span>
          </button>
        `;
      })
      .join("");

    topChMenuPanel.innerHTML = `<div class="ch-menu-panel__head">Chapters (1–${total})</div>${itemsHtml}`;
    stageChMenuPanel.innerHTML = `<div class="ch-menu-panel__head">Jump to Chapter</div>${itemsHtml}`;

    document.querySelectorAll("#topChMenuPanel [data-switch-chapter], #stageChMenuPanel [data-switch-chapter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.switchChapter;
        closeAllDropdowns(null);
        if (target && target !== activeChapter) {
          applyChapterView(target, true);
        }
      });
    });
  }

  function rebuildLeftToc(book) {
    const chapters = book.chapters || [];
    leftTocNav.innerHTML = chapters
      .map((ch) => {
        const isChActive = ch.slug === activeChapter;
        const secsHtml = (ch.sections || [])
          .map(
            (sec, sIdx) => `
            <li>
              <a href="#${escapeHTML(sec.id)}" class="toc-link ${sIdx === 0 ? "is-active" : ""}" data-section="${escapeHTML(
              sec.id
            )}">
                <span class="toc-link__num">${escapeHTML(sec.roman)}</span>
                <span class="toc-link__body">
                  <span class="toc-link__title" data-toc-sec-title="${escapeHTML(sec.id)}">${escapeHTML(sec.title)}</span>
                  <span class="toc-link__sub" data-toc-sec-sub="${escapeHTML(sec.id)}">${escapeHTML(sec.subtitle || "")}</span>
                </span>
                <span class="toc-link__page">p. ${sec.pageStart || ch.folioStart}</span>
              </a>
            </li>
          `
          )
          .join("");

        const endnotesTocHtml =
          (ch.endnotes || []).length > 0
            ? `
            <li class="toc-list__divider">
              <a href="#ch${ch.num}-endnotes" class="toc-link" data-section="ch${ch.num}-endnotes">
                <span class="toc-link__num">※</span>
                <span class="toc-link__body">
                  <span class="toc-link__title">Notes to ${escapeHTML(ch.chapterLabel)}</span>
                  <span class="toc-link__sub">Endnotes 1–${ch.endnotes.length}</span>
                </span>
                <span class="toc-link__page">p. ${ch.folioEnd}</span>
              </a>
            </li>`
            : "";

        return `
          <div class="chapter-toc-group ${isChActive ? "is-active" : ""}" data-toc-group="${escapeHTML(ch.slug)}">
            <button type="button" class="chapter-toc-tab ${isChActive ? "is-active" : ""}" data-switch-chapter="${escapeHTML(
          ch.slug
        )}" aria-expanded="${isChActive}">
              <span class="chapter-toc-tab__badge">${escapeHTML(formatChapterBadge(ch.chapterLabel, ch.num))}</span>
              <span class="chapter-toc-tab__title" data-toc-ch-title="${escapeHTML(ch.slug)}">${escapeHTML(
          ch.shortTitle || ch.title
        )}</span>
              <span class="chapter-toc-tab__chevron" aria-hidden="true">&#9662;</span>
            </button>
            <ol class="toc-list" ${isChActive ? "" : "hidden"}>
              ${secsHtml}
              ${endnotesTocHtml}
            </ol>
          </div>
        `;
      })
      .join("");

    allTocGroups = Array.from(leftTocNav.querySelectorAll("[data-toc-group]"));

    leftTocNav.querySelectorAll("[data-switch-chapter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.switchChapter;
        if (target && target !== activeChapter) applyChapterView(target, true);
      });
    });

    leftTocNav.querySelectorAll(".toc-link").forEach((link) => {
      link.addEventListener("click", () => {
        const group = link.closest("[data-toc-group]");
        if (group && group.dataset.tocGroup && group.dataset.tocGroup !== activeChapter) {
          applyChapterView(group.dataset.tocGroup, false);
        }
        if (!isDesktopRails()) closeMobileDrawers();
      });
    });
  }

  function renderBookDOM(book) {
    destroyVisualControllers();
    const isSameBook = Boolean(currentBook && currentBook.id === book.id);
    if (!isSameBook) {
      clearTimeout(syncTimer);
      editingEndnoteNums.clear();
      expandedEndnoteNums.clear();
      editingNoteIds.clear();
      expandedNoteIds.clear();
      selectedAnnotationId = null;
      stagedAiHighlight = null;
      chapterData = {};
      annotations = [];
      chatMessages = [];
      if (aiContextBox) aiContextBox.hidden = true;
    }
    currentBook = book;
    saveJSON(ACTIVE_BOOK_KEY, book.id);
    idbSaveBook(book);

    const chapters = book.chapters || [];
    updateBookMasthead(book);

    if (chapters.length === 0) {
      emptyStageCard.hidden = false;
      emptyStageCard.querySelector(".empty-stage-card__title").textContent = `Extracting “${book.title}”…`;
      emptyStageCard.querySelector(".empty-stage-card__desc").textContent =
        book.job?.phase || "Extracting chapters, paragraphs, folios, and footnotes. Your book will open automatically in a moment.";
      topChPicker.hidden = true;
      topBarSep.hidden = true;
      stageChapterBar.hidden = true;
      chaptersContainer.innerHTML = "";
      leftTocNav.innerHTML = "";
      railEndnotesList.innerHTML = "";
      endnotesTabCount.textContent = "0";
      railEndnotesIntro.textContent = "No endnotes yet in this edition.";
      renderNotesList();
      renderChatMessages();
      return;
    }

    emptyStageCard.hidden = true;
    topChPicker.hidden = false;
    topBarSep.hidden = false;
    stageChapterBar.hidden = false;

    const savedCh = loadJSON(activeChapterKey(book.id), chapters[0].slug);
    activeChapter = chapters.some((c) => c.slug === savedCh) ? savedCh : chapters[0].slug;

    // Render all chapter <article> elements
    chaptersContainer.innerHTML = chapters
      .map((ch, chIdx) => {
        const paras = ch.paragraphs || [];
        const sections = ch.sections && ch.sections.length > 0 ? ch.sections : [];

        const sectionsHtml = sections
          .map((sec, sIdx) => {
            const pStartIdx = Math.max(0, Number(sec.startParagraphIndex || 0));
            const pEndIdx =
              sIdx + 1 < sections.length
                ? Math.max(pStartIdx, Number(sections[sIdx + 1].startParagraphIndex || paras.length) - 1)
                : paras.length - 1;

            const slice = paras.slice(pStartIdx, pEndIdx + 1);
            let firstProseSeenInSection = false;

            const proseHtml = slice
              .map((p, relIdx) => {
                const absParaIdx = pStartIdx + relIdx;
                if (p.type === "figure" && p.src) {
                  const capHtml = p.caption
                    ? `<figcaption class="pdf-figure__caption">${escapeHTML(p.caption)}</figcaption>`
                    : "";
                  return `<figure class="pdf-figure" data-para-idx="${absParaIdx}">
                    <a href="${escapeHTML(p.src)}" target="_blank" rel="noopener noreferrer" class="pdf-figure__link" title="Click to inspect full-resolution figure">
                      <img src="${escapeHTML(p.src)}" alt="${escapeHTML(
                    p.caption || `Figure on page ${p.page || 1}`
                  )}" class="pdf-figure__img" loading="lazy" />
                    </a>
                    ${capHtml}
                  </figure>`;
                }
                if (p.type === "table" && Array.isArray(p.rows)) {
                  const headRows = p.rows.filter((r) => r.header);
                  const bodyRows = p.rows.filter((r) => !r.header);
                  const theadHtml = headRows.length
                    ? `<thead>${headRows
                        .map(
                          (r) =>
                            `<tr>${(r.cells || []).map((c) => `<th scope="col">${c}</th>`).join("")}</tr>`
                        )
                        .join("")}</thead>`
                    : "";
                  const tbodyHtml = bodyRows.length
                    ? `<tbody>${bodyRows
                        .map((r) => `<tr>${(r.cells || []).map((c) => `<td>${c}</td>`).join("")}</tr>`)
                        .join("")}</tbody>`
                    : "";
                  return `<div class="prose-table-wrap" data-para-idx="${absParaIdx}">
                    <table class="prose-table">${theadHtml}${tbodyHtml}</table>
                  </div>`;
                }
                if ((p.type === "ul" || p.type === "ol") && Array.isArray(p.items)) {
                  const listTag = p.type === "ol" ? "ol" : "ul";
                  const cls = p.type === "ol" ? "prose-list prose-list--ordered" : "prose-list";
                  return `<${listTag} class="${cls}" data-para-idx="${absParaIdx}">${p.items
                    .map((it) => `<li>${it}</li>`)
                    .join("")}</${listTag}>`;
                }
                if (p.type === "code") {
                  return `<pre class="prose-pre" data-para-idx="${absParaIdx}"><code>${p.html}</code></pre>`;
                }
                if (p.type === "subhead") {
                  return `<h2 class="section-subhead" data-para-idx="${absParaIdx}">${p.html}</h2>`;
                }
                if (p.type === "subhead3") {
                  return `<h3 class="section-subhead3" data-para-idx="${absParaIdx}">${p.html}</h3>`;
                }
                if (p.type === "blockquote") {
                  return `<blockquote class="prose-quote" data-para-idx="${absParaIdx}"><p>${p.html}</p></blockquote>`;
                }
                if (!firstProseSeenInSection) {
                  firstProseSeenInSection = true;
                  if (sIdx === 0) {
                    return `<p class="lead-paragraph" data-para-idx="${absParaIdx}">${decorateOpeningParagraphHTML(
                      p.html
                    )}</p>`;
                  }
                  return `<p class="section-open" data-para-idx="${absParaIdx}">${p.html}</p>`;
                }
                return `<p data-para-idx="${absParaIdx}">${p.html}</p>`;
              })
              .join("\n");

            const ornament =
              sIdx > 0
                ? `<div class="section-ornament" role="separator" aria-label="Section break"><span></span><span></span><span></span><span></span><span></span></div>`
                : "";

            const chBadge = formatChapterBadge(ch.chapterLabel, ch.num);
            const refLabel = `${chBadge} · ${sec.roman} · pp. ${sec.pageStart || ch.folioStart}–${
              sec.pageEnd || ch.folioEnd
            }`;

            return `
              ${ornament}
              <section class="chapter-section" id="${escapeHTML(sec.id)}" data-section-label="${escapeHTML(
              sec.roman
            )} · ${escapeHTML(sec.title)}">
                <figure class="section-visual" id="vis-${escapeHTML(sec.id)}" data-section-id="${escapeHTML(
              sec.id
            )}" data-chapter-slug="${escapeHTML(ch.slug)}" data-section-ref="${escapeHTML(refLabel)}">
                  <div class="section-visual__bar">
                    <span class="section-visual__tag">${escapeHTML(chBadge)} · Section ${escapeHTML(sec.roman)} &middot; Visual Guide</span>
                    <div class="section-visual__controls">
                      <div class="sv-mode-switch" role="group" aria-label="Visual mode">
                        <button type="button" class="sv-mode-btn ${sec.comicUrl ? "is-active" : ""}" data-view-mode="comic">Story Comic</button>
                        <button type="button" class="sv-mode-btn ${sec.comicUrl ? "" : "is-active"}" data-view-mode="diagram">Diagram</button>
                      </div>
                      <button type="button" class="section-visual__btn" data-visual-ask="${escapeHTML(
                        sec.quote || sec.takeaway || sec.title
                      )}">&#10024; Ask AI</button>
                      <button type="button" class="section-visual__btn" data-toggle-anim aria-pressed="false">Pause</button>
                    </div>
                  </div>
                  <div class="comic-player" data-comic-player ${sec.comicUrl ? "" : "hidden"}>
                    ${renderComicPlayerInner(ch.slug, sec)}
                  </div>
                  <div class="section-visual__canvas" data-svg-pane ${sec.comicUrl ? "hidden" : ""}>
                    ${renderDiagramSVG(sec.diagram)}
                  </div>
                  <figcaption class="section-visual__caption">
                    <p class="section-visual__takeaway"><strong>${escapeHTML(
                      sec.takeawayLead || "Key Takeaway"
                    )}:</strong> ${escapeHTML(sec.takeaway || "")}</p>
                    ${
                      sec.quote
                        ? `<blockquote class="section-visual__quote">“${escapeHTML(sec.quote)}”</blockquote>`
                        : ""
                    }
                  </figcaption>
                </figure>
                ${proseHtml}
              </section>
            `;
          })
          .join("\n");

        const nextCh = chIdx + 1 < chapters.length ? chapters[chIdx + 1] : null;
        const prevCh = chIdx > 0 ? chapters[chIdx - 1] : null;
        const pagerTarget = nextCh || prevCh;
        const pagerHtml = pagerTarget
          ? `
            <nav class="chapter-pager" aria-label="Chapter navigation">
              <button type="button" class="chapter-pager__btn ${nextCh ? "chapter-pager__btn--next" : ""}" data-switch-chapter="${escapeHTML(
              pagerTarget.slug
            )}">
                <span class="chapter-pager__eyebrow">${
                  nextCh
                    ? `Continue Reading &middot; pp. ${pagerTarget.folioStart}–${pagerTarget.folioEnd}`
                    : `Previous Chapter &middot; pp. ${pagerTarget.folioStart}–${pagerTarget.folioEnd}`
                }</span>
                <span class="chapter-pager__title">${
                  nextCh
                    ? `${escapeHTML(pagerTarget.chapterLabel)}: ${escapeHTML(pagerTarget.title)} &rarr;`
                    : `&larr; ${escapeHTML(pagerTarget.chapterLabel)}: ${escapeHTML(pagerTarget.title)}`
                }</span>
              </button>
            </nav>`
          : "";

        const notesListHtml =
          (ch.endnotes || []).length > 0
            ? `
            <div class="chapter-finis" aria-hidden="true">
              <span class="chapter-finis__rule"></span>
              <span class="chapter-finis__label">End of ${escapeHTML(ch.chapterLabel)}</span>
              <span class="chapter-finis__rule"></span>
            </div>
            <section class="endnotes" id="ch${ch.num}-endnotes" data-section-label="Notes to ${escapeHTML(
                ch.chapterLabel
              )}" aria-labelledby="ch${ch.num}-endnotes-heading">
              <header class="endnotes__header">
                <p class="endnotes__eyebrow">Reference Apparatus</p>
                <h2 class="endnotes__title" id="ch${ch.num}-endnotes-heading">Notes to ${escapeHTML(
                ch.chapterLabel
              )}</h2>
                <p class="endnotes__hint">Click any superscript note number in the text to highlight it in the right sidebar.</p>
              </header>
              <ol class="endnotes__list">
                ${ch.endnotes
                  .map(
                    (n) => {
                      const backHtml =
                        n.anchored === false
                          ? `<span class="endnotes__back">p. ${n.page || ch.folioStart}</span>`
                          : `<a href="#ch${ch.num}-ref-${n.num}" class="endnotes__back">&crarr; p. ${
                              n.page || ch.folioStart
                            }</a>`;
                      return `<li id="ch${ch.num}-note-${n.num}" data-note-uid="${escapeHTML(
                        n.uid || ""
                      )}"><span class="endnotes__body">${
                        renderEndnoteContentHTML(n) || "<em>(Empty endnote)</em>"
                      }</span> ${backHtml}</li>`;
                    }
                  )
                  .join("")}
              </ol>
            </section>`
            : "";

        const chBadge = formatChapterBadge(ch.chapterLabel, ch.num);
        return `
          <article class="chapter ${ch.slug === activeChapter ? "is-active" : ""}" ${
          ch.slug === activeChapter ? "" : "hidden"
        } role="tabpanel"
            data-chapter="${escapeHTML(ch.slug)}"
            data-badge="${escapeHTML(chBadge)}"
            data-chapter-label="${escapeHTML(ch.chapterLabel || `Chapter ${ch.num}`)}"
            data-short-label="${escapeHTML(chBadge)} · ${escapeHTML(ch.shortTitle || ch.title)}"
            data-menu-title="${escapeHTML(ch.shortTitle || ch.title)}"
            data-full-title="${escapeHTML(ch.chapterLabel)}: ${escapeHTML(ch.title)}"
            data-receipt-item="${escapeHTML(ch.receiptItem || `CHAPTER ${ch.num}`)}"
            data-receipt-folio="${escapeHTML(ch.receiptFolio || `PP. ${ch.folioStart}–${ch.folioEnd}`)}"
            data-receipt-notes="${escapeHTML(ch.receiptNotes || "INLINE EDITION")}"
            data-receipt-tagline="${escapeHTML(ch.receiptTagline || book.tagline || "")}"
            data-ref-prefix="ch${ch.num}-ref-"
            data-note-prefix="ch${ch.num}-note-">
            <header class="chapter-header">
              <span class="folio-marker" data-page="${ch.folioStart}" title="Page ${ch.folioStart}">p. ${ch.folioStart}</span>
              <p class="chapter-number">${escapeHTML(ch.chapterLabel)}</p>
              <h1 class="chapter-title">${escapeHTML(ch.title)}</h1>
              ${
                book.sourceUrl
                  ? `<div class="chapter-source-ref">
                      <span class="chapter-source-ref__label">Source</span>
                      <a href="${escapeHTML(book.sourceUrl)}" target="_blank" rel="noopener noreferrer" class="chapter-source-ref__link" title="${escapeHTML(
                      book.sourceUrl
                    )}">${escapeHTML(book.sourceUrl)} &nearr;</a>
                    </div>`
                  : ""
              }
            </header>
            ${sectionsHtml}
            ${pagerHtml}
            ${notesListHtml}
          </article>
        `;
      })
      .join("\n");

    // Register chapters & bind interactive widgets
    allChapterArticles = Array.from(chaptersContainer.querySelectorAll(".chapter[data-chapter]"));
    CHAPTER_META = {};
    CHAPTER_ORDER = allChapterArticles.map((a) => a.dataset.chapter);

    const prevChapterData = isSameBook ? chapterData : {};
    chapterData = {};
    allChapterArticles.forEach((art, idx) => {
      const slug = art.dataset.chapter;
      const endnotesItems = art.querySelectorAll(".endnotes__list > li");
      const headingEl = art.querySelector(".chapter-title");
      CHAPTER_META[slug] = {
        slug,
        index: idx,
        num: idx + 1,
        badge: art.dataset.badge || `Ch. ${idx + 1}`,
        chapterLabel: art.dataset.chapterLabel || `Chapter ${idx + 1}`,
        article: art,
        endnotesItems,
        endnotesCount: endnotesItems.length,
        refPrefix: art.dataset.refPrefix,
        notePrefix: art.dataset.notePrefix,
        endnotesIntro:
          endnotesItems.length > 0
            ? `Click any superscript number in ${art.dataset.fullTitle} to highlight its note here.`
            : "This chapter has no separate endnotes.",
        receiptItem: art.dataset.receiptItem,
        receiptFolio: art.dataset.receiptFolio,
        receiptNotes: art.dataset.receiptNotes,
        receiptTagline: art.dataset.receiptTagline,
        defaultLabel: art.dataset.shortLabel,
        menuTitle: art.dataset.menuTitle,
        headingTitle: headingEl ? headingEl.textContent.trim() : slug,
        fullTitle: art.dataset.fullTitle,
        exportName: `${book.id}-${slug}-notes.md`,
      };

      const mem = prevChapterData[slug];
      chapterData[slug] = {
        annotations: mem?.annotations || loadJSON(annStorageKey(book.id, slug), []),
        chatMessages: mem?.chatMessages || loadJSON(chatStorageKey(book.id, slug), []),
      };

      art.addEventListener("click", (e) => {
        const mark = e.target.closest("mark.user-highlight");
        if (!mark) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        const id = mark.dataset.hlId;
        selectedAnnotationId = id;
        switchRightTab("notes");
        if (!isDesktopRails()) openRightDrawer();
        renderNotesList();
        const card = notesList.querySelector(`.note-card[data-id="${id}"]`);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });

    rebuildChapterMenus(book);
    rebuildLeftToc(book);

    // Link toc reference into CHAPTER_META
    Object.keys(CHAPTER_META).forEach((slug) => {
      const grp = leftTocNav.querySelector(`[data-toc-group="${slug}"]`);
      CHAPTER_META[slug].tocGroup = grp;
      CHAPTER_META[slug].toc = grp ? grp.querySelector(".toc-list") : null;
    });

    // Bind pager buttons & note superscripts & section visuals
    chaptersContainer.querySelectorAll("[data-switch-chapter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.switchChapter;
        if (target && target !== activeChapter) applyChapterView(target, true);
      });
    });

    bindNoteRefLinks();
    chaptersContainer.querySelectorAll(".section-visual").forEach((fig) => bindSectionVisual(fig));

    applyChapterView(activeChapter, false);
    hydrateBookAnnotationsFromServer(book.id);
  }

  /* ========================================================================
     7. Endnotes (View, Create, Edit & Delete), Chapter Switching & Scroll-Spy
     ======================================================================== */
  async function mutateEndnoteOnServer(payload, opts = {}) {
    if (!currentBook) return null;
    const prevScrollY = window.scrollY;
    const res = await fetch(`/api/books/${encodeURIComponent(currentBook.id)}/endnotes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapter: activeChapter, ...payload }),
    });
    const data = await res.json();
    if (!res.ok) {
      window.alert(data.error || "Failed to update endnotes.");
      return null;
    }

    const chIdx = (currentBook.chapters || []).findIndex((c) => c.slug === activeChapter);
    if (chIdx >= 0 && data.chapter) {
      currentBook.chapters[chIdx] = data.chapter;
    }

    if (opts.openEditNum) {
      editingEndnoteNums.add(opts.openEditNum);
    }

    renderBookDOM(currentBook);
    window.scrollTo({ top: prevScrollY, behavior: "instant" in window ? "instant" : "auto" });

    const focusNum = opts.highlightNum || data.createdNum || data.updatedNum || null;
    if (focusNum) {
      switchRightTab("endnotes");
      if (!isDesktopRails()) openRightDrawer();
      if (opts.startEditingCreated && data.createdNum) {
        editingEndnoteNums.add(data.createdNum);
        populateRailEndnotes();
      }
      requestAnimationFrame(() => {
        const railItem = document.getElementById(`rail-note-${focusNum}`);
        if (railItem) {
          railItem.classList.add("is-highlighted");
          railItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
          const ta = railItem.querySelector(".rail-endnote-editor__input");
          if (ta) ta.focus();
        }
      });
    }
    return data;
  }

  function populateRailEndnotes() {
    const meta = CHAPTER_META[activeChapter];
    if (!meta || !currentBook) return;
    const chObj = (currentBook.chapters || []).find((c) => c.slug === activeChapter);
    const notesArr = chObj?.endnotes || [];

    railEndnotesList.innerHTML = "";
    endnotesTabCount.textContent = String(notesArr.length);
    railEndnotesIntro.textContent =
      notesArr.length > 0
        ? `Click any superscript number in ${meta.fullTitle} to highlight its note here.`
        : "No endnotes yet in this chapter. Select text and click “+ Endnote”, or click “+ Add Endnote” above.";

    notesArr.forEach((n, idx) => {
      const num = n.num || idx + 1;
      const isEditing = editingEndnoteNums.has(num);
      const cloneLi = document.createElement("li");
      cloneLi.id = `rail-note-${num}`;
      cloneLi.dataset.noteNum = String(num);

      if (isEditing) {
        const seedText =
          typeof n.rawText === "string" && n.rawText.length > 0
            ? n.rawText
            : String(n.html || "")
                .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, "[$2]($1)")
                .replace(/<[^>]+>/g, "")
                .trim();

        cloneLi.innerHTML = `
          <div class="rail-endnote-editor">
            <textarea class="rail-endnote-editor__input" rows="3" placeholder="Write endnote citation, commentary, or [Link](https://…)…">${escapeHTML(
              seedText
            )}</textarea>
            <div class="rail-endnote-editor__actions">
              <button type="button" class="notes-action-btn" data-cancel-endnote="${num}">Cancel</button>
              <button type="button" class="notes-action-btn notes-action-btn--primary" data-save-endnote="${num}">Save</button>
            </div>
          </div>
        `;

        const ta = cloneLi.querySelector(".rail-endnote-editor__input");
        const saveBtn = cloneLi.querySelector("[data-save-endnote]");
        const cancelBtn = cloneLi.querySelector("[data-cancel-endnote]");

        const commitSave = async () => {
          const val = ta.value.trim();
          editingEndnoteNums.delete(num);
          if (!val && !n.html) {
            await mutateEndnoteOnServer({ action: "delete", uid: n.uid, num });
          } else {
            await mutateEndnoteOnServer(
              { action: "update", uid: n.uid, num, text: val },
              { highlightNum: num }
            );
          }
        };

        saveBtn.addEventListener("click", commitSave);
        cancelBtn.addEventListener("click", async () => {
          editingEndnoteNums.delete(num);
          if (!n.html && n.userAdded) {
            await mutateEndnoteOnServer({ action: "delete", uid: n.uid, num });
          } else {
            populateRailEndnotes();
          }
        });
        ta.addEventListener("keydown", (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            commitSave();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            cancelBtn.click();
          }
        });
      } else {
        const rawStr = String(n.rawText || "");
        const isLongMulti = rawStr.length > 560 && /\n/.test(rawStr);
        const isExpanded = expandedEndnoteNums.has(num);
        const backLinkHtml =
          n.anchored === false
            ? `<span class="endnotes__back">p. ${n.page || chObj.folioStart || 1}</span>`
            : `<a href="#${meta.refPrefix}${num}" class="endnotes__back" data-return-ref="${
                meta.refPrefix
              }${num}">&crarr; p. ${n.page || chObj.folioStart || 1}</a>`;

        const renderedBody =
          renderEndnoteContentHTML(n, isLongMulti && !isExpanded ? "is-collapsed" : "") ||
          "<em>(Empty endnote)</em>";

        cloneLi.innerHTML = `
          <div class="rail-endnotes-item__row">
            <div class="rail-endnotes-item__body">
              ${renderedBody}
              <div class="rail-endnotes-item__footer">
                <div>
                  ${backLinkHtml}
                  ${
                    isLongMulti
                      ? `<button type="button" class="note-card__ghost-btn" data-expand-endnote="${num}">${
                          isExpanded ? "Collapse &uarr;" : "Show full endnote &darr;"
                        }</button>`
                      : ""
                  }
                </div>
                <div class="rail-endnotes-item__tools">
                  <button type="button" class="note-card__ghost-btn" data-edit-endnote="${num}" title="Edit endnote">Edit</button>
                  <button type="button" class="note-card__delete" data-delete-endnote="${num}" title="Delete endnote" aria-label="Delete endnote ${num}">&times;</button>
                </div>
              </div>
            </div>
          </div>
        `;

        const expandBtn = cloneLi.querySelector("[data-expand-endnote]");
        if (expandBtn) {
          expandBtn.addEventListener("click", () => {
            if (expandedEndnoteNums.has(num)) expandedEndnoteNums.delete(num);
            else expandedEndnoteNums.add(num);
            populateRailEndnotes();
          });
        }

        cloneLi.querySelector("[data-edit-endnote]").addEventListener("click", () => {
          editingEndnoteNums.add(num);
          populateRailEndnotes();
          requestAnimationFrame(() => {
            const ta = document.querySelector(`#rail-note-${num} .rail-endnote-editor__input`);
            if (ta) ta.focus();
          });
        });

        cloneLi.querySelector("[data-delete-endnote]").addEventListener("click", async () => {
          if (!window.confirm(`Delete Endnote ${num} (and remove its superscript from the text)?`)) return;
          editingEndnoteNums.delete(num);
          await mutateEndnoteOnServer({ action: "delete", uid: n.uid, num });
        });
      }

      railEndnotesList.appendChild(cloneLi);
    });

    railEndnotesList.querySelectorAll("[data-return-ref]").forEach((a) => {
      a.addEventListener("click", () => {
        if (!isDesktopRails()) closeMobileDrawers();
      });
    });
  }

  function closeNotePopover() {
    if (notePopover.hidden) return;
    notePopover.hidden = true;
    if (activeNoteLink) {
      activeNoteLink.classList.remove("is-open");
      activeNoteLink = null;
    }
  }

  function positionNotePopover(anchor) {
    const rect = anchor.getBoundingClientRect();
    const popWidth = Math.min(400, window.innerWidth - 24);
    let left = rect.left + rect.width / 2 - popWidth / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - popWidth - 12));
    notePopover.style.left = `${left}px`;
    notePopover.style.top = "0px";
    const popHeight = notePopover.offsetHeight || 180;
    let top = rect.bottom + 10;
    if (top + popHeight > window.innerHeight - 16 && rect.top > popHeight + 24) {
      top = rect.top - popHeight - 10;
    }
    notePopover.style.top = `${Math.max(60, top)}px`;
  }

  function bindNoteRefLinks() {
    chaptersContainer.querySelectorAll(".note-ref a").forEach((link) => {
      link.addEventListener("click", (e) => {
        const noteNum = link.dataset.note;
        e.preventDefault();
        e.stopPropagation();

        if (isDesktopRails()) {
          switchRightTab("endnotes");
          railEndnotesList.querySelectorAll("li").forEach((li) => li.classList.remove("is-highlighted"));
          const railItem = document.getElementById(`rail-note-${noteNum}`);
          if (railItem) {
            railItem.classList.add("is-highlighted");
            railItem.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
          return;
        }

        const meta = CHAPTER_META[activeChapter];
        const targetLi = document.getElementById(`${meta.notePrefix}${noteNum}`);
        if (!targetLi) return;
        if (activeNoteLink === link && !notePopover.hidden) {
          closeNotePopover();
          return;
        }
        if (activeNoteLink) activeNoteLink.classList.remove("is-open");
        activeNoteLink = link;
        link.classList.add("is-open");

        const bodySpan = targetLi.querySelector(".endnotes__body");
        notePopoverTitle.textContent = `Endnote ${noteNum}`;
        notePopoverJump.href = `#${meta.notePrefix}${noteNum}`;
        notePopoverContent.innerHTML = bodySpan ? bodySpan.innerHTML : targetLi.innerHTML;
        notePopover.hidden = false;
        positionNotePopover(link);
      });
    });
  }

  notePopoverClose.addEventListener("click", closeNotePopover);
  notePopoverJump.addEventListener("click", closeNotePopover);
  notePopover.addEventListener("click", (e) => e.stopPropagation());

  let totalMinutes = 10;
  function recalcChapterReadingTime() {
    if (!chapterEl) {
      readingStat.textContent = "";
      return;
    }
    const words = chapterEl.innerText.trim().split(/\s+/).length;
    totalMinutes = Math.max(1, Math.round(words / 245));
    updateReadingProgress();
  }

  function updateReadingProgress() {
    if (!chapterEl) return;
    const scrollTop = window.scrollY || root.scrollTop;
    const docHeight = root.scrollHeight - window.innerHeight;
    const ratio = docHeight > 0 ? Math.min(1, Math.max(0, scrollTop / docHeight)) : 0;
    const pct = Math.round(ratio * 100);
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (readingStat) {
      if (pct < 3) readingStat.textContent = `~${totalMinutes} min read`;
      else if (pct >= 98) readingStat.textContent = "Completed · 100%";
      else readingStat.textContent = `${pct}% · ${Math.max(1, Math.ceil(totalMinutes * (1 - ratio)))}m left`;
    }
  }

  window.addEventListener("scroll", updateReadingProgress, { passive: true });
  window.addEventListener("resize", updateReadingProgress);

  let sectionObserver = null;
  function setupScrollSpy() {
    if (sectionObserver) sectionObserver.disconnect();
    if (!("IntersectionObserver" in window) || !chapterEl || !CHAPTER_META[activeChapter]) return;

    const trackedSections = Array.from(chapterEl.querySelectorAll("[data-section-label]"));
    const activeToc = CHAPTER_META[activeChapter].toc;
    const tocLinks = activeToc ? Array.from(activeToc.querySelectorAll(".toc-link")) : [];

    sectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            const label = entry.target.getAttribute("data-section-label");
            if (label && currentSectionLabel) currentSectionLabel.textContent = label;
            tocLinks.forEach((link) => link.classList.toggle("is-active", link.dataset.section === id));
          }
        });
      },
      { rootMargin: "-16% 0px -70% 0px", threshold: 0 }
    );
    trackedSections.forEach((sec) => sectionObserver.observe(sec));
  }

  function applyChapterView(slug, shouldScroll) {
    if (!CHAPTER_META[slug] || !currentBook) return;
    activeChapter = slug;
    saveJSON(activeChapterKey(currentBook.id), activeChapter);

    const meta = CHAPTER_META[activeChapter];
    chapterEl = meta.article;

    allChapterArticles.forEach((art) => {
      const isSelected = art.dataset.chapter === activeChapter;
      art.classList.toggle("is-active", isSelected);
      art.hidden = !isSelected;
    });

    allTocGroups.forEach((grp) => {
      const isSelected = grp.dataset.tocGroup === activeChapter;
      grp.classList.toggle("is-active", isSelected);
      const list = grp.querySelector(".toc-list");
      if (list) list.hidden = !isSelected;
      const tabBtn = grp.querySelector(".chapter-toc-tab");
      if (tabBtn) tabBtn.setAttribute("aria-expanded", String(isSelected));
    });

    document.querySelectorAll("[data-switch-chapter]").forEach((btn) => {
      const isSelected = btn.dataset.switchChapter === activeChapter;
      btn.classList.toggle("is-active", isSelected);
      if (btn.getAttribute("role") === "menuitemradio") {
        btn.setAttribute("aria-checked", String(isSelected));
      }
    });

    const totalCh = CHAPTER_ORDER.length;
    const folioText = meta.receiptFolio ? meta.receiptFolio.toLowerCase() : "";
    topChBadge.textContent = meta.badge || `Ch. ${meta.num}`;
    topChLabel.textContent = meta.menuTitle;
    stageChEyebrow.textContent = folioText
      ? `${meta.chapterLabel} (${meta.num} of ${totalCh}) · ${folioText}`
      : `${meta.chapterLabel} (${meta.num} of ${totalCh})`;
    stageChTitle.textContent = meta.headingTitle;
    stageChPrev.disabled = meta.index <= 0;
    stageChNext.disabled = meta.index >= totalCh - 1;

    receiptItem.textContent = meta.receiptItem;
    receiptFolio.textContent = meta.receiptFolio;
    receiptNotes.textContent = meta.receiptNotes;
    if (meta.receiptTagline) receiptTagline.textContent = meta.receiptTagline;
    currentSectionLabel.textContent = meta.defaultLabel;
    document.getElementById("searchInput").placeholder = `Search text in ${meta.defaultLabel}…`;

    annotations = chapterData[activeChapter].annotations;
    chatMessages = chapterData[activeChapter].chatMessages;
    selectedAnnotationId = null;
    stagedAiHighlight = null;
    aiContextBox.hidden = true;
    closeNotePopover();
    clearSearchHighlights();

    populateRailEndnotes();
    renderTextHighlights();
    renderNotesList();
    renderChatMessages();
    recalcChapterReadingTime();
    setupScrollSpy();

    if (shouldScroll) {
      const stageEl = document.getElementById("chapter-text");
      if (stageEl) stageEl.scrollIntoView({ behavior: "smooth", block: "start" });
      if (!isDesktopRails()) closeMobileDrawers();
    }
  }

  stageChPrev.addEventListener("click", () => {
    const idx = CHAPTER_META[activeChapter]?.index ?? 0;
    if (idx > 0) applyChapterView(CHAPTER_ORDER[idx - 1], true);
  });
  stageChNext.addEventListener("click", () => {
    const idx = CHAPTER_META[activeChapter]?.index ?? 0;
    if (idx < CHAPTER_ORDER.length - 1) applyChapterView(CHAPTER_ORDER[idx + 1], true);
  });

  /* ========================================================================
     8. Highlights, Margin Notes & Gemini 4 Neon AI Chat
     ======================================================================== */
  function updateModelStatusUI(connected = true) {
    aiModelPillBtn.classList.toggle("is-connected", connected);
    syncStatusBar.classList.toggle("is-neon", connected);
    aiStatusText.textContent = activeModelLabel;
    aiPromptInput.placeholder = `Ask ${activeModelLabel} about the highlighted passage & your notes…`;
    syncFooterText.textContent = connected
      ? `Connected · ${activeModelLabel} · Stored in website`
      : "Gemini API offline · Saved in browser";
  }

  function scheduleServerAnnotationSync() {
    if (!currentBook || !CHAPTER_META[activeChapter]) return;
    const ch = activeChapter;
    const chAnns = chapterData[ch].annotations;
    saveJSON(annStorageKey(currentBook.id, ch), chAnns);
    idbSaveChapterState(currentBook.id, ch, {
      annotations: chAnns,
      chatMessages: chapterData[ch].chatMessages || [],
    });
    if (!serverAvailable) return;
    clearTimeout(syncTimer);
    const bookId = currentBook.id;
    syncTimer = setTimeout(async () => {
      try {
        await fetch(`/api/books/${encodeURIComponent(bookId)}/annotations/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chapter: ch, annotations: chAnns }),
        });
      } catch (_) {}
    }, 300);
  }

  async function hydrateBookAnnotationsFromServer(bookId) {
    if (!bookId) return;
    let remoteChapters = {};
    try {
      const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/state`);
      if (res.ok) {
        serverAvailable = true;
        const remote = await res.json();
        remoteChapters = remote.chapters || {};
      }
    } catch (_) {}

    // Guard against stale async fetch if user switched books while request was in flight
    if (!currentBook || currentBook.id !== bookId) return;

    for (const ch of Object.keys(CHAPTER_META)) {
      const rc = remoteChapters[ch] || {};
      const idbState = await idbGetChapterState(bookId, ch);
      if (!currentBook || currentBook.id !== bookId) return;
      const localAnns = chapterData[ch]?.annotations || loadJSON(annStorageKey(bookId, ch), []);
      const localChat = chapterData[ch]?.chatMessages || loadJSON(chatStorageKey(bookId, ch), []);
      const clearedAt = Number(loadJSON(chatClearedKey(bookId, ch), 0)) || 0;
      const annClearedAt = Number(loadJSON(annClearedKey(bookId, ch), 0)) || 0;
      const deletedAnnIds = new Set(loadJSON(annDeletedKey(bookId, ch), []));

      // Annotations (Highlights & Notes): strictly scoped to bookId!
      const rAnns = Array.isArray(rc.annotations) ? rc.annotations : [];
      const iAnns = Array.isArray(idbState?.annotations) ? idbState.annotations : [];
      const mergedAnns = mergeAnnotationListsClient([rAnns, iAnns, localAnns], deletedAnnIds, annClearedAt, bookId);
      chapterData[ch].annotations = mergedAnns;

      // Chat Messages: strictly scoped to bookId!
      const rChat = Array.isArray(rc.chatMessages) ? rc.chatMessages : [];
      const iChat = Array.isArray(idbState?.chatMessages) ? idbState.chatMessages : [];
      const mergedChat = mergeChatMessageLists([rChat, iChat, localChat], clearedAt, bookId);
      chapterData[ch].chatMessages = mergedChat;

      saveJSON(annStorageKey(bookId, ch), mergedAnns);
      persistChatLocally(bookId, ch, mergedChat);

      // Push any client-only local highlights/notes back up to server/website state.json!
      const remoteAnnIds = new Set(rAnns.map((a) => a && a.id).filter(Boolean));
      const hasUnsyncedLocalAnns = mergedAnns.some((a) => !remoteAnnIds.has(a.id));
      if (serverAvailable && (hasUnsyncedLocalAnns || mergedAnns.length > rAnns.length)) {
        fetch(`/api/books/${encodeURIComponent(bookId)}/annotations/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chapter: ch, annotations: mergedAnns, mode: "merge" }),
        }).catch(() => {});
      }

      // Push any client-only chat messages back to server so state.json stays complete
      if (serverAvailable && mergedChat.length > rChat.length) {
        fetch(`/api/books/${encodeURIComponent(bookId)}/chat/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chapter: ch, chatMessages: mergedChat }),
        }).catch(() => {});
      }
    }

    if (currentBook && currentBook.id === bookId && CHAPTER_META[activeChapter]) {
      annotations = chapterData[activeChapter].annotations;
      chatMessages = chapterData[activeChapter].chatMessages;
      renderTextHighlights();
      renderNotesList();
      renderChatMessages();
    }
  }

  aiModelSelect.addEventListener("change", async () => {
    activeModel = aiModelSelect.value;
    activeModelLabel = aiModelSelect.options[aiModelSelect.selectedIndex].text;
    updateModelStatusUI(serverAvailable);
    if (serverAvailable) {
      await fetch("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: activeModel }),
      }).catch(() => {});
    }
  });

  function isIgnoredTextNode(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    return Boolean(
      parent.closest(".folio-marker, .note-ref, .chapter-source-ref, .endnotes__back, .section-visual, .book-figure, .stage-ch-bar, .chapter-pager, script, style")
    );
  }

  function getAcceptedTextNodes(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return isIgnoredTextNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const list = [];
    let n;
    while ((n = walker.nextNode())) list.push(n);
    return list;
  }

  function rangeToChapterOffsets(range) {
    if (!chapterEl || !chapterEl.contains(range.commonAncestorContainer)) return null;
    const nodes = getAcceptedTextNodes(chapterEl);
    let cum = 0;
    let minStart = Infinity;
    let maxEnd = -1;
    const parts = [];
    let firstMatchedNode = null;
    let lastMatchedNode = null;
    let lastMatchedOffset = 0;

    for (let i = 0; i < nodes.length; i++) {
      const tn = nodes[i];
      const len = tn.nodeValue.length;
      if (len === 0) continue;
      if (range.comparePoint(tn, len) < 0 || range.comparePoint(tn, 0) > 0) {
        cum += len;
        continue;
      }
      const s = tn === range.startContainer ? range.startOffset : range.comparePoint(tn, 0) < 0 ? len : 0;
      const e = tn === range.endContainer ? range.endOffset : range.comparePoint(tn, len) > 0 ? 0 : len;
      if (e > s) {
        if (!firstMatchedNode) firstMatchedNode = tn;
        lastMatchedNode = tn;
        lastMatchedOffset = e;
        minStart = Math.min(minStart, cum + s);
        maxEnd = Math.max(maxEnd, cum + e);
        parts.push(tn.nodeValue.slice(s, e));
      }
      cum += len;
    }

    const quote = parts.join("").replace(/\s+/g, " ").trim();
    if (!quote || maxEnd <= minStart) return null;

    let locLabel = CHAPTER_META[activeChapter]?.defaultLabel?.split("·")[0]?.trim() || "Chapter";
    let pageNum = 1;
    if (firstMatchedNode && firstMatchedNode.parentElement) {
      const sec = firstMatchedNode.parentElement.closest("[data-section-label]");
      if (sec) {
        const raw = sec.getAttribute("data-section-label") || "";
        locLabel = raw.split("·")[0].trim() || raw;
      }
      const allFolios = Array.from(chapterEl.querySelectorAll(".folio-marker"));
      pageNum = Number(allFolios[0]?.dataset.page || 1);
      for (const f of allFolios) {
        const rel = f.compareDocumentPosition(firstMatchedNode);
        if (rel & Node.DOCUMENT_POSITION_FOLLOWING) pageNum = Number(f.dataset.page || pageNum);
        else break;
      }
      locLabel = `${locLabel} · p. ${pageNum}`;
    }

    // Compute exact paragraph index & plain-text character offset for superscript endnote insertion
    let paraIndex = null;
    let paraEndOffset = null;
    if (lastMatchedNode && lastMatchedNode.parentElement) {
      const paraEl = lastMatchedNode.parentElement.closest("[data-para-idx]");
      if (paraEl) {
        paraIndex = Number(paraEl.dataset.paraIdx);
        const pNodes = getAcceptedTextNodes(paraEl);
        let pCum = 0;
        for (const ptn of pNodes) {
          if (ptn === lastMatchedNode) {
            paraEndOffset = pCum + lastMatchedOffset;
            break;
          }
          pCum += ptn.nodeValue.length;
        }
      }
    }

    return { start: minStart, end: maxEnd, quote, locLabel, paraIndex, paraEndOffset, pageNum };
  }

  function unwrapMarks(container, selector) {
    if (!container) return;
    container.querySelectorAll(selector).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  function renderTextHighlights() {
    if (!chapterEl) return;
    const activeSearch = document.getElementById("searchInput").value;
    unwrapMarks(chapterEl, "mark.find-hit");
    unwrapMarks(chapterEl, "mark.user-highlight");

    const nodes = getAcceptedTextNodes(chapterEl);
    const fullText = nodes.map((tn) => tn.nodeValue || "").join("");

    // Resolve inline highlight spans for both offset-based highlights AND quote-based pinned notes
    const textHighlights = annotations
      .map((a) => {
        if (typeof a.start === "number" && typeof a.end === "number" && a.end > a.start) {
          return a;
        }
        const q = String(a.quote || "").trim();
        if (q.length >= 2 && fullText) {
          const idx = fullText.indexOf(q);
          if (idx >= 0) {
            return { ...a, start: idx, end: idx + q.length };
          }
        }
        return null;
      })
      .filter(Boolean);

    if (textHighlights.length > 0) {
      let cum = 0;
      nodes.forEach((tn) => {
        const text = tn.nodeValue;
        const len = text.length;
        const nodeStart = cum;
        const nodeEnd = cum + len;
        cum += len;
        if (len === 0) return;

        const overlapping = textHighlights.filter((h) => h.start < nodeEnd && h.end > nodeStart);
        if (!overlapping.length) return;

        const pointsSet = new Set([0, len]);
        overlapping.forEach((h) => {
          pointsSet.add(Math.max(0, h.start - nodeStart));
          pointsSet.add(Math.min(len, h.end - nodeStart));
        });
        const points = Array.from(pointsSet).sort((a, b) => a - b);

        const frag = document.createDocumentFragment();
        for (let i = 0; i < points.length - 1; i++) {
          const segStart = points[i];
          const segEnd = points[i + 1];
          if (segEnd <= segStart) continue;
          const slice = text.slice(segStart, segEnd);
          const absMid = nodeStart + (segStart + segEnd) / 2;

          let winner = null;
          for (let j = overlapping.length - 1; j >= 0; j--) {
            if (overlapping[j].start <= absMid && overlapping[j].end >= absMid) {
              winner = overlapping[j];
              break;
            }
          }

          if (winner) {
            const mark = document.createElement("mark");
            mark.className = "user-highlight";
            if (winner.note && winner.note.trim()) mark.classList.add("has-note");
            mark.dataset.hlId = winner.id;
            mark.dataset.hlColor = winner.color || "amber";
            mark.textContent = slice;
            frag.appendChild(mark);
          } else {
            frag.appendChild(document.createTextNode(slice));
          }
        }
        tn.parentNode.replaceChild(frag, tn);
      });
    }

    if (activeSearch && activeSearch.trim().length >= 2) {
      highlightQuery(activeSearch, false);
    }
  }

  function updateAiNotesCountLabel() {
    aiNotesAttachedCount.textContent = String(annotations.length);
  }

  function stageHighlightForAi(item) {
    stagedAiHighlight = item
      ? {
          id: item.id || null,
          quote: item.quote || "",
          locLabel: item.locLabel || CHAPTER_META[activeChapter]?.defaultLabel || "Passage",
          note: item.note || "",
        }
      : null;

    if (stagedAiHighlight && stagedAiHighlight.quote) {
      aiContextBox.hidden = false;
      aiContextLoc.textContent = stagedAiHighlight.locLabel;
      aiContextQuote.textContent = `“${stagedAiHighlight.quote}”`;
    } else {
      aiContextBox.hidden = true;
      aiContextQuote.textContent = "";
    }

    updateAiNotesCountLabel();
    switchRightTab("ai");
    if (!isDesktopRails()) openRightDrawer();
    requestAnimationFrame(() => aiPromptInput.focus());
  }

  aiContextClearBtn.addEventListener("click", () => {
    stagedAiHighlight = null;
    aiContextBox.hidden = true;
  });

  function isPinnedAiNote(item) {
    return item.source === "ai" || String(item.locLabel || "").toLowerCase().includes("insight");
  }

  function renderNotesList(focusNoteId) {
    if (focusNoteId) {
      const target = annotations.find((a) => a.id === focusNoteId);
      if (target && (!target.note || !target.note.trim())) editingNoteIds.add(focusNoteId);
      else if (target && isPinnedAiNote(target)) expandedNoteIds.add(focusNoteId);
    }

    const count = annotations.length;
    notesTabCount.textContent = String(count);
    notesCountBadge.textContent = String(count);
    notesEmptyState.hidden = count > 0;
    exportNotesBtn.disabled = count === 0;
    clearAllNotesBtn.hidden = count === 0;
    updateAiNotesCountLabel();

    const sorted = [...annotations].sort((a, b) => {
      const posA = typeof a.start === "number" ? a.start : a.createdAt;
      const posB = typeof b.start === "number" ? b.start : b.createdAt;
      return posA - posB;
    });

    notesList.innerHTML = "";
    const colors = ["amber", "coral", "sage", "sky"];

    sorted.forEach((item) => {
      const aiNote = isPinnedAiNote(item);
      const isEditing = editingNoteIds.has(item.id);
      const hasNoteText = Boolean(item.note && item.note.trim());
      const isLong = (item.note || "").length > 420;
      const isExpanded = expandedNoteIds.has(item.id);

      const card = document.createElement("div");
      card.className = "note-card" + (aiNote ? " note-card--ai" : "");
      if (item.id === selectedAnnotationId) card.classList.add("is-selected");
      card.dataset.id = item.id;
      card.dataset.color = item.color || (aiNote ? "sky" : "amber");

      const hasQuote = Boolean(item.quote);
      const canJumpToHighlight = Boolean(
        (typeof item.start === "number" && typeof item.end === "number") || item.linkedHighlightId
      );

      const leftHeaderHTML = aiNote
        ? `<span class="note-card__ai-badge">&#128204; ${escapeHTML(item.modelLabel || "Pinned from Ask AI")}</span>`
        : `<div class="note-card__swatches">${colors
            .map(
              (c) =>
                `<button type="button" class="card-swatch card-swatch--${c} ${
                  (item.color || "amber") === c ? "is-active" : ""
                }" data-set-color="${c}" title="Color ${c}" aria-label="Color ${c}"></button>`
            )
            .join("")}</div>`;

      const promptHTML =
        aiNote && item.promptQuestion
          ? `<div class="note-card__prompt"><span class="note-card__prompt-label">Asked:</span>${escapeHTML(
              item.promptQuestion
            )}</div>`
          : "";

      let bodyHTML = "";
      if (isEditing) {
        bodyHTML = `
          <textarea class="note-card__input" rows="${Math.min(
            10,
            Math.max(3, (item.note || "").split("\n").length + 1)
          )}" placeholder="Write a note (Markdown supported)…">${escapeHTML(item.note || "")}</textarea>
          <div class="note-card__edit-actions">
            <button type="button" class="notes-action-btn notes-action-btn--primary" data-done-edit="${item.id}">Done</button>
          </div>
        `;
      } else if (hasNoteText) {
        bodyHTML = `
          <div class="note-card__rendered md-prose ${isLong && !isExpanded ? "is-collapsed" : ""}">${formatAiTextToHTML(
          item.note
        )}</div>
          <div class="note-card__footer">
            <div>
              ${
                isLong
                  ? `<button type="button" class="note-card__ghost-btn" data-toggle-expand="${item.id}">${
                      isExpanded ? "Collapse &uarr;" : "Show full note &darr;"
                    }</button>`
                  : ""
              }
            </div>
            <button type="button" class="note-card__ghost-btn" data-start-edit="${item.id}">Edit</button>
          </div>
        `;
      } else {
        bodyHTML = `<button type="button" class="note-card__add-note-trigger" data-start-edit="${item.id}">+ Write a note…</button>`;
      }

      card.innerHTML = `
        <div class="note-card__meta">
          ${leftHeaderHTML}
          <div class="note-card__actions">
            <span class="note-card__loc">${escapeHTML(item.locLabel || "Note")}</span>
            ${!aiNote ? `<button type="button" class="note-card__ask" data-ask-ai="${item.id}">&#10024; Ask AI</button>` : ""}
            ${canJumpToHighlight ? `<button type="button" class="note-card__jump" data-jump="${item.id}">&nearr;</button>` : ""}
            <button type="button" class="note-card__delete" data-delete="${item.id}" aria-label="Delete note">&times;</button>
          </div>
        </div>
        ${hasQuote ? `<blockquote class="note-card__quote" ${canJumpToHighlight ? `data-jump="${item.id}"` : ""}>“${escapeHTML(item.quote)}”</blockquote>` : ""}
        ${promptHTML}
        ${bodyHTML}
      `;

      card.querySelectorAll("[data-set-color]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          item.color = btn.dataset.setColor;
          renderTextHighlights();
          renderNotesList();
          scheduleServerAnnotationSync();
        });
      });

      const askBtn = card.querySelector("[data-ask-ai]");
      if (askBtn) {
        askBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          stageHighlightForAi(item);
        });
      }

      card.querySelectorAll("[data-jump]").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          selectedAnnotationId = item.id;
          renderNotesList();
          if (!isDesktopRails()) closeMobileDrawers();
          const targetHlId = item.linkedHighlightId || item.id;
          const mark = chapterEl && chapterEl.querySelector(`mark.user-highlight[data-hl-id="${targetHlId}"]`);
          if (mark) {
            mark.scrollIntoView({ behavior: "smooth", block: "center" });
            mark.classList.add("is-pulse");
            setTimeout(() => mark.classList.remove("is-pulse"), 1400);
          }
        });
      });

      card.querySelector("[data-delete]").addEventListener("click", (e) => {
        e.stopPropagation();
        editingNoteIds.delete(item.id);
        expandedNoteIds.delete(item.id);
        if (currentBook) {
          const delArr = loadJSON(annDeletedKey(currentBook.id, activeChapter), []);
          if (!delArr.includes(item.id)) {
            delArr.push(item.id);
            saveJSON(annDeletedKey(currentBook.id, activeChapter), delArr);
          }
        }
        chapterData[activeChapter].annotations = annotations.filter((a) => a.id !== item.id);
        annotations = chapterData[activeChapter].annotations;
        if (selectedAnnotationId === item.id) selectedAnnotationId = null;
        renderTextHighlights();
        renderNotesList();
        scheduleServerAnnotationSync();
      });

      const startEditBtn = card.querySelector("[data-start-edit]");
      if (startEditBtn) {
        startEditBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          editingNoteIds.add(item.id);
          selectedAnnotationId = item.id;
          renderNotesList();
          const newCard = notesList.querySelector(`.note-card[data-id="${item.id}"]`);
          const ta = newCard && newCard.querySelector(".note-card__input");
          if (ta) ta.focus();
        });
      }

      const expandBtn = card.querySelector("[data-toggle-expand]");
      if (expandBtn) {
        expandBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (expandedNoteIds.has(item.id)) expandedNoteIds.delete(item.id);
          else expandedNoteIds.add(item.id);
          renderNotesList();
        });
      }

      const textarea = card.querySelector(".note-card__input");
      if (textarea) {
        textarea.addEventListener("input", () => {
          item.note = textarea.value;
          if (chapterEl) {
            chapterEl
              .querySelectorAll(`mark.user-highlight[data-hl-id="${item.id}"]`)
              .forEach((m) => m.classList.toggle("has-note", Boolean(item.note && item.note.trim())));
          }
          scheduleServerAnnotationSync();
        });
        textarea.addEventListener("keydown", (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            editingNoteIds.delete(item.id);
            renderNotesList();
          }
        });
      }

      const doneEditBtn = card.querySelector("[data-done-edit]");
      if (doneEditBtn) {
        doneEditBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          editingNoteIds.delete(item.id);
          renderNotesList();
        });
      }

      notesList.appendChild(card);

      if (focusNoteId && item.id === focusNoteId) {
        requestAnimationFrame(() => {
          card.scrollIntoView({ behavior: "smooth", block: "nearest" });
          if (textarea) textarea.focus();
        });
      }
    });
  }

  function createOrFindAnnotation({
    start,
    end,
    quote,
    locLabel,
    color,
    initialNote,
    source,
    modelLabel,
    promptQuestion,
    linkedHighlightId,
  }) {
    if (!currentBook || !CHAPTER_META[activeChapter]) return null;
    if (source !== "ai" && typeof start === "number" && typeof end === "number") {
      const existing = annotations.find((a) => a.source !== "ai" && a.start === start && a.end === end);
      if (existing) {
        selectedAnnotationId = existing.id;
        return existing;
      }
    }
    const id = "hl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    const entry = {
      id,
      bookId: currentBook.id,
      start,
      end,
      quote: quote || "",
      locLabel: locLabel || "General Note",
      color: color || "amber",
      note: initialNote || "",
      source: source || "user",
      modelLabel: modelLabel || "",
      promptQuestion: promptQuestion || "",
      linkedHighlightId: linkedHighlightId || null,
      createdAt: Date.now(),
    };
    annotations.push(entry);
    selectedAnnotationId = id;
    renderTextHighlights();
    renderNotesList();
    scheduleServerAnnotationSync();
    return entry;
  }

  function hideSelectionToolbar() {
    selectionToolbar.hidden = true;
    pendingSelection = null;
  }

  function handleSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      hideSelectionToolbar();
      return;
    }
    const range = sel.getRangeAt(0);
    const info = rangeToChapterOffsets(range);
    if (!info) {
      hideSelectionToolbar();
      return;
    }

    pendingSelection = info;
    const rect = range.getBoundingClientRect();
    selectionToolbar.hidden = false;

    const tbWidth = selectionToolbar.offsetWidth || 275;
    const tbHeight = selectionToolbar.offsetHeight || 38;
    let left = rect.left + rect.width / 2 - tbWidth / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - tbWidth - 10));
    let top = rect.top - tbHeight - 10;
    if (top < 58) top = rect.bottom + 10;

    selectionToolbar.style.left = `${left}px`;
    selectionToolbar.style.top = `${top}px`;
  }

  document.addEventListener("mouseup", (e) => {
    if (selectionToolbar.contains(e.target)) return;
    setTimeout(handleSelectionChange, 15);
  });
  document.addEventListener("keyup", (e) => {
    if (e.key.startsWith("Arrow") || e.key === "Shift") setTimeout(handleSelectionChange, 15);
  });
  selectionToolbar.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  selectionToolbar.querySelectorAll("[data-hl-create]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!pendingSelection) return;
      const color = btn.dataset.hlCreate;
      const selInfo = pendingSelection;
      window.getSelection().removeAllRanges();
      hideSelectionToolbar();
      createOrFindAnnotation({ ...selInfo, color });
      switchRightTab("notes");
    });
  });

  selectionAddNoteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pendingSelection) return;
    const selInfo = pendingSelection;
    window.getSelection().removeAllRanges();
    hideSelectionToolbar();
    const entry = createOrFindAnnotation({ ...selInfo, color: "amber" });
    switchRightTab("notes");
    if (!isDesktopRails()) openRightDrawer();
    if (entry) renderNotesList(entry.id);
  });

  if (selectionAddEndnoteBtn) {
    selectionAddEndnoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!pendingSelection) return;
      const selInfo = pendingSelection;
      window.getSelection().removeAllRanges();
      hideSelectionToolbar();
      await mutateEndnoteOnServer(
        {
          action: "add",
          text: "",
          paraIndex: selInfo.paraIndex,
          paraEndOffset: selInfo.paraEndOffset,
          anchorQuote: selInfo.quote,
          page: selInfo.pageNum || 1,
        },
        { startEditingCreated: true }
      );
    });
  }

  if (addEndnoteBtn) {
    addEndnoteBtn.addEventListener("click", async () => {
      if (!currentBook || !CHAPTER_META[activeChapter]) return;
      // If user currently has text selected in the chapter, anchor to that selection; else add standalone chapter endnote
      const sel = window.getSelection();
      const rangeInfo =
        sel && !sel.isCollapsed && sel.rangeCount > 0 ? rangeToChapterOffsets(sel.getRangeAt(0)) : null;
      if (rangeInfo) {
        sel.removeAllRanges();
        hideSelectionToolbar();
      }
      await mutateEndnoteOnServer(
        {
          action: "add",
          text: "",
          paraIndex: rangeInfo ? rangeInfo.paraIndex : null,
          paraEndOffset: rangeInfo ? rangeInfo.paraEndOffset : null,
          anchorQuote: rangeInfo ? rangeInfo.quote : "",
        },
        { startEditingCreated: true }
      );
    });
  }

  selectionAskAiBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pendingSelection) return;
    const selInfo = pendingSelection;
    window.getSelection().removeAllRanges();
    hideSelectionToolbar();
    const entry = createOrFindAnnotation({ ...selInfo, color: "coral" });
    stageHighlightForAi(entry);
  });

  askAiWithAllNotesBtn.addEventListener("click", () => {
    aiIncludeNotesCheck.checked = true;
    stageHighlightForAi(null);
  });

  addStandaloneNoteBtn.addEventListener("click", () => {
    if (!currentBook || !CHAPTER_META[activeChapter]) return;
    const loc = currentSectionLabel
      ? currentSectionLabel.textContent.split("·")[0].trim()
      : CHAPTER_META[activeChapter].defaultLabel;
    const entry = createOrFindAnnotation({
      start: null,
      end: null,
      quote: "",
      locLabel: `${loc} · Note`,
      color: "coral",
    });
    switchRightTab("notes");
    if (entry) renderNotesList(entry.id);
  });

  exportNotesBtn.addEventListener("click", () => {
    if (!annotations.length || !currentBook) return;
    const meta = CHAPTER_META[activeChapter];
    const lines = [`# Notes & Highlights — ${currentBook.title} (${meta.fullTitle})`, ""];
    annotations.forEach((item, i) => {
      lines.push(`## ${i + 1}. ${item.locLabel || "Note"} [${item.color || "amber"}]`);
      if (item.quote) lines.push(`> "${item.quote}"`, "");
      if (item.note && item.note.trim()) lines.push(item.note.trim(), "");
    });
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = meta.exportName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  clearAllNotesBtn.addEventListener("click", () => {
    if (!annotations.length) return;
    if (!window.confirm("Remove all saved highlights and notes for this chapter?")) return;
    if (currentBook) {
      saveJSON(annClearedKey(currentBook.id, activeChapter), Date.now());
    }
    chapterData[activeChapter].annotations = [];
    annotations = [];
    selectedAnnotationId = null;
    renderTextHighlights();
    renderNotesList();
    scheduleServerAnnotationSync();
  });

  /* AI Chat */
  function renderChatMessages() {
    clearChatBtn.hidden = chatMessages.length === 0;
    if (aiChatTabCount) {
      const assistantReplies = chatMessages.filter((m) => m.role === "assistant").length;
      aiChatTabCount.textContent = String(assistantReplies || chatMessages.length);
    }
    aiMessagesList.querySelectorAll(".ai-msg").forEach((el) => el.remove());
    aiEmptyState.hidden = chatMessages.length > 0;

    chatMessages.forEach((msg, idx) => {
      const div = document.createElement("div");
      div.className = `ai-msg ai-msg--${msg.role === "assistant" ? "assistant" : "user"}`;

      if (msg.role === "user") {
        const ctxHTML = msg.highlightQuote
          ? `<div class="ai-msg__context"><strong>${escapeHTML(msg.highlightLoc || "Passage")}:</strong> “${escapeHTML(
              msg.highlightQuote
            )}”</div>`
          : "";
        const notesMeta =
          msg.notesCount > 0
            ? `<div class="ai-msg__meta"><span>Sent with ${msg.notesCount} note${msg.notesCount === 1 ? "" : "s"}</span></div>`
            : "";
        div.innerHTML = `${ctxHTML}<div class="ai-msg__body md-prose">${formatAiTextToHTML(msg.content)}</div>${notesMeta}`;
      } else {
        const prevUser = idx > 0 && chatMessages[idx - 1]?.role === "user" ? chatMessages[idx - 1] : null;
        const sources = Array.isArray(msg.sources) ? msg.sources : [];
        const searchedWeb = sources.length > 0 || (Array.isArray(msg.searchQueries) && msg.searchQueries.length > 0);
        const sourcesHTML =
          sources.length > 0
            ? `<div class="ai-msg__sources">
                <span class="ai-msg__sources-label">&#128269; Web Sources:</span>
                ${sources
                  .map(
                    (s) =>
                      `<a href="${escapeHTML(s.uri)}" target="_blank" rel="noopener noreferrer" class="ai-source-pill">${escapeHTML(
                        s.title || "Source"
                      )} &nearr;</a>`
                  )
                  .join("")}
              </div>`
            : "";

        div.innerHTML = `
          <div class="ai-msg__body md-prose">${formatAiTextToHTML(msg.content)}</div>
          ${sourcesHTML}
          <div class="ai-msg__meta">
            <span>${escapeHTML(msg.highlightLoc || activeModelLabel)}${searchedWeb ? " · Google Search" : ""}</span>
            <div class="ai-msg__actions">
              <button type="button" class="ai-msg__save-btn" data-save-endnote-ai title="Attach this response as a numbered Endnote">+ Endnote</button>
              <button type="button" class="ai-msg__save-btn" data-save-insight>&#128204; Pin to Notes</button>
            </div>
          </div>
        `;
        const endnoteAiBtn = div.querySelector("[data-save-endnote-ai]");
        if (endnoteAiBtn) {
          endnoteAiBtn.addEventListener("click", async () => {
            const quoteText = (prevUser && prevUser.highlightQuote) || "";
            endnoteAiBtn.disabled = true;
            endnoteAiBtn.textContent = "Adding…";
            const fullMarkdownText = String(msg.content || "").trim();
            const res = await mutateEndnoteOnServer({
              action: "add",
              text: fullMarkdownText,
              anchorQuote: quoteText,
            });
            if (res && res.createdNum) {
              expandedEndnoteNums.add(res.createdNum);
              populateRailEndnotes();
            }
            endnoteAiBtn.textContent = "✓ Endnote";
          });
        }
        const pinBtn = div.querySelector("[data-save-insight]");
        pinBtn.addEventListener("click", () => {
          const quoteText = (prevUser && prevUser.highlightQuote) || "";
          const matchingHl = quoteText ? annotations.find((a) => a.source !== "ai" && a.quote === quoteText) : null;
          const entry = createOrFindAnnotation({
            start: null,
            end: null,
            quote: quoteText,
            locLabel: (prevUser && prevUser.highlightLoc) || CHAPTER_META[activeChapter]?.defaultLabel || "Note",
            color: "sky",
            initialNote: msg.content,
            source: "ai",
            modelLabel: msg.highlightLoc || activeModelLabel,
            promptQuestion: (prevUser && prevUser.content) || "",
            linkedHighlightId: matchingHl ? matchingHl.id : null,
          });
          pinBtn.textContent = "✓ Pinned";
          setTimeout(() => {
            switchRightTab("notes");
            if (entry) renderNotesList(entry.id);
          }, 180);
        });
      }
      aiMessagesList.appendChild(div);
    });
    aiMessagesList.scrollTop = aiMessagesList.scrollHeight;
  }

  async function submitAiQuestion(customQuestion) {
    if (!currentBook) {
      openLibraryModal();
      return;
    }
    const question = String(customQuestion || aiPromptInput.value || "").trim();
    if (!question) return;

    const bookId = currentBook.id;
    const ch = activeChapter;
    let activeHighlight = stagedAiHighlight;
    if (activeHighlight && activeHighlight.id) {
      const latest = annotations.find((a) => a.id === activeHighlight.id);
      if (latest) activeHighlight = latest;
    }
    const notesPayload = aiIncludeNotesCheck.checked ? annotations : [];

    aiPromptInput.value = "";
    aiSendBtn.disabled = true;
    aiSendBtn.textContent = "Thinking…";
    aiEmptyState.hidden = true;

    const pendingBubble = document.createElement("div");
    pendingBubble.className = "ai-msg ai-msg--assistant";
    pendingBubble.innerHTML = `<div class="ai-msg__body"><p><em>${escapeHTML(
      activeModelLabel
    )} is analyzing the passage and ${notesPayload.length} note(s)…</em></p></div>`;
    aiMessagesList.appendChild(pendingBubble);
    aiMessagesList.scrollTop = aiMessagesList.scrollHeight;

    try {
      const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chapter: ch,
          question,
          model: activeModel,
          selectedHighlight: activeHighlight,
          notes: notesPayload,
        }),
      });
      const data = await res.json();
      pendingBubble.remove();
      if (!res.ok) throw new Error(data.error || "Gemini request failed.");

      const updatedList = mergeChatMessageLists(
        [
          currentBook && currentBook.id === bookId ? chapterData[ch]?.chatMessages : loadJSON(chatStorageKey(bookId, ch), []),
          [data.userMessage, data.assistantMessage],
        ],
        0,
        bookId
      );
      saveJSON(chatStorageKey(bookId, ch), updatedList);
      idbSaveChapterState(bookId, ch, {
        annotations:
          currentBook && currentBook.id === bookId
            ? chapterData[ch]?.annotations || []
            : loadJSON(annStorageKey(bookId, ch), []),
        chatMessages: updatedList,
      });
      if (currentBook && currentBook.id === bookId) {
        if (chapterData[ch]) chapterData[ch].chatMessages = updatedList;
        if (activeChapter === ch) {
          chatMessages = updatedList;
          renderChatMessages();
        }
      }
    } catch (err) {
      pendingBubble.innerHTML = `<div class="ai-msg__body"><p><strong>Error:</strong> ${escapeHTML(err.message)}</p></div>`;
    } finally {
      aiSendBtn.disabled = false;
      aiSendBtn.textContent = "Ask AI ↑";
    }
  }

  aiSendBtn.addEventListener("click", () => submitAiQuestion());
  aiPromptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitAiQuestion();
    }
  });
  aiQuickPrompts.querySelectorAll("[data-prompt]").forEach((chip) => {
    chip.addEventListener("click", () => submitAiQuestion(chip.dataset.prompt));
  });

  clearChatBtn.addEventListener("click", async () => {
    if (!chatMessages.length || !currentBook) return;
    if (!window.confirm("Clear AI chat thread for this chapter?")) return;
    const ch = activeChapter;
    saveJSON(chatClearedKey(currentBook.id, ch), Date.now());
    chapterData[ch].chatMessages = [];
    chatMessages = [];
    persistChatLocally(currentBook.id, ch, []);
    renderChatMessages();
    await fetch(`/api/books/${encodeURIComponent(currentBook.id)}/chat?chapter=${encodeURIComponent(ch)}`, {
      method: "DELETE",
    }).catch(() => {});
  });

  /* ========================================================================
     9. In-Chapter Text Search
     ======================================================================== */
  const searchInput = document.getElementById("searchInput");
  const searchCount = document.getElementById("searchCount");
  const searchPrev = document.getElementById("searchPrev");
  const searchNext = document.getElementById("searchNext");
  const searchClear = document.getElementById("searchClear");
  let hits = [];
  let hitIndex = -1;

  function clearSearchHighlights() {
    allChapterArticles.forEach((art) => unwrapMarks(art, "mark.find-hit"));
    hits = [];
    hitIndex = -1;
    searchCount.textContent = "0 / 0";
    searchPrev.disabled = true;
    searchNext.disabled = true;
  }

  function highlightQuery(query, scrollFirst = true) {
    clearSearchHighlights();
    const term = query.trim();
    if (term.length < 2 || !chapterEl) return;

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    const textNodes = getAcceptedTextNodes(chapterEl).filter((n) => {
      regex.lastIndex = 0;
      return regex.test(n.nodeValue);
    });

    textNodes.forEach((node) => {
      const text = node.nodeValue;
      regex.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
        const mark = document.createElement("mark");
        mark.className = "find-hit";
        mark.textContent = match[0];
        frag.appendChild(mark);
        hits.push(mark);
        lastIdx = match.index + match[0].length;
      }
      if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
      node.parentNode.replaceChild(frag, node);
    });

    if (hits.length > 0) {
      hitIndex = 0;
      searchPrev.disabled = hits.length < 2;
      searchNext.disabled = hits.length < 2;
      if (scrollFirst) focusHit(0);
      else {
        hits[0].classList.add("is-current");
        searchCount.textContent = `1 / ${hits.length}`;
      }
    }
  }

  function focusHit(index) {
    if (!hits.length) return;
    hits.forEach((h) => h.classList.remove("is-current"));
    hitIndex = (index + hits.length) % hits.length;
    const active = hits[hitIndex];
    active.classList.add("is-current");
    searchCount.textContent = `${hitIndex + 1} / ${hits.length}`;
    active.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  searchInput.addEventListener("input", () => highlightQuery(searchInput.value, true));
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && hits.length) {
      e.preventDefault();
      focusHit(e.shiftKey ? hitIndex - 1 : hitIndex + 1);
    }
  });
  searchPrev.addEventListener("click", () => focusHit(hitIndex - 1));
  searchNext.addEventListener("click", () => focusHit(hitIndex + 1));
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    clearSearchHighlights();
    closeAllDropdowns(null);
  });

  /* ========================================================================
     10. Index Page Icon Shelf, Upload / Link Import & Live Background Polling
     ======================================================================== */
  function hashPaletteIndex(idStr) {
    let h = 0;
    const s = String(idStr || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 5;
  }

  function isWebPageItem(item) {
    return String(item.sourceFormat || "").toLowerCase() === "web";
  }

  function makeInitialsMonogram(title) {
    const words = String(title || "B")
      .replace(/[^A-Za-z0-9\s]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => !/^(the|a|an|on|of|in|to|and)$/i.test(w));
    const pick = words.length ? words : String(title || "B").trim().split(/\s+/);
    return pick
      .slice(0, 2)
      .map((w) => (w[0] || "").toUpperCase())
      .join("");
  }

  async function deleteBookById(id) {
    if (!window.confirm("Remove this item and its generated visuals from your library?")) return;
    await fetch(`/api/books/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    await idbDeleteBook(id);
    await refreshLibraryList();
    if (currentBook && currentBook.id === id) {
      currentBook = null;
      liveJobPill.hidden = true;
      showIndexPage(true);
    }
  }

  function renderShelfIcons() {
    if (!shelfIconsGrid) return;

    const booksOnlyCount = libraryBooks.filter((b) => !isWebPageItem(b)).length;
    const pagesOnlyCount = libraryBooks.filter((b) => isWebPageItem(b)).length;
    if (shelfCountAll) shelfCountAll.textContent = String(libraryBooks.length);
    if (shelfCountBooks) shelfCountBooks.textContent = String(booksOnlyCount);
    if (shelfCountPages) shelfCountPages.textContent = String(pagesOnlyCount);

    const q = shelfQuery.trim().toLowerCase();
    const filtered = libraryBooks.filter((b) => {
      if (shelfFilter === "books" && isWebPageItem(b)) return false;
      if (shelfFilter === "pages" && !isWebPageItem(b)) return false;
      if (q) {
        const hay = `${b.title || ""} ${b.subtitle || ""} ${b.author || ""} ${b.publisherMeta || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const tilesHtml = filtered
      .map((b) => {
        const isPage = isWebPageItem(b);
        const palette = hashPaletteIndex(b.id);
        const fmtBadge = isPage ? "PAGE" : (b.sourceFormat || "BOOK").toUpperCase();
        const pubShort = (b.publisherMeta || b.pubDate || "").replace(/\s*EDITION$/i, "").slice(0, 14);
        const mins = Math.max(1, Math.round((b.wordCount || 250) / 245));
        const metaLine = isPage
          ? `~${mins}m read · ${b.totalPages || 1}p`
          : `${b.chapterCount || 1} ch · ~${mins}m`;
        const job = b.job || { status: "ready", percent: 100 };
        const isProcessing = job.status === "processing";
        const pct = Math.max(5, Math.min(99, Number(job.percent || 12)));

        const artInner = b.previewComicUrl
          ? `<img src="${escapeHTML(b.previewComicUrl)}" alt="" loading="lazy" />`
          : `<span class="shelf-icon__monogram">${escapeHTML(makeInitialsMonogram(b.title))}</span>`;

        return `
          <div class="shelf-tile" role="listitem">
            <button type="button" class="shelf-tile__delete" data-shelf-delete="${escapeHTML(
              b.id
            )}" title="Remove from library" aria-label="Remove ${escapeHTML(b.title)}">&times;</button>
            <button type="button" class="shelf-tile__open" data-shelf-open="${escapeHTML(
              b.id
            )}" title="Open ${escapeHTML(b.title)}">
              <div class="shelf-icon ${isPage ? "shelf-icon--page" : "shelf-icon--book"}" data-palette="${palette}">
                <div class="shelf-icon__top">
                  <span class="shelf-icon__badge">${escapeHTML(fmtBadge)}</span>
                  <span class="shelf-icon__pub">${escapeHTML(pubShort)}</span>
                </div>
                <div class="shelf-icon__art">${artInner}</div>
                <div class="shelf-icon__cover-title">${escapeHTML(b.title || "Untitled")}</div>
                ${
                  isProcessing
                    ? `<div class="shelf-icon__progress"><span class="job-live-pill__spinner" style="border-top-color:#fff;border-color:rgba(255,255,255,0.3);width:8px;height:8px;"></span><span>${pct}%</span></div>`
                    : ""
                }
              </div>
              <div class="shelf-label">
                <p class="shelf-label__title">${escapeHTML(b.title || "Untitled")}</p>
                <p class="shelf-label__author">${escapeHTML(b.author || "")}</p>
                <span class="shelf-label__meta">${escapeHTML(metaLine)}</span>
              </div>
            </button>
          </div>
        `;
      })
      .join("");

    const addTileHtml = `
      <div class="shelf-tile" role="listitem">
        <button type="button" class="shelf-tile__open" id="shelfAddTileBtn" title="Upload an EPUB/PDF or paste a web link">
          <div class="shelf-icon shelf-icon--add">
            <span class="shelf-icon__plus" aria-hidden="true">+</span>
            <span class="shelf-icon__add-hint">Add Book / Link</span>
          </div>
          <div class="shelf-label">
            <p class="shelf-label__title">New Edition</p>
            <p class="shelf-label__author">EPUB, PDF, or URL</p>
          </div>
        </button>
      </div>
    `;

    shelfIconsGrid.innerHTML = tilesHtml + addTileHtml;

    shelfIconsGrid.querySelectorAll("[data-shelf-open]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.shelfOpen;
        loadAndOpenBook(id, true);
      });
    });

    shelfIconsGrid.querySelectorAll("[data-shelf-delete]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteBookById(btn.dataset.shelfDelete);
      });
    });

    const addTileBtn = document.getElementById("shelfAddTileBtn");
    if (addTileBtn) addTileBtn.addEventListener("click", openLibraryModal);
  }

  document.querySelectorAll("[data-shelf-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      shelfFilter = btn.dataset.shelfFilter || "all";
      document.querySelectorAll("[data-shelf-filter]").forEach((b) => {
        b.classList.toggle("is-active", b === btn);
      });
      renderShelfIcons();
    });
  });

  if (shelfSearchInput) {
    shelfSearchInput.addEventListener("input", () => {
      shelfQuery = shelfSearchInput.value || "";
      renderShelfIcons();
    });
  }

  if (indexPage) {
    indexPage.addEventListener("dragover", (e) => {
      e.preventDefault();
      indexPage.classList.add("is-dragover");
    });
    indexPage.addEventListener("dragleave", () => {
      indexPage.classList.remove("is-dragover");
    });
    indexPage.addEventListener("drop", (e) => {
      e.preventDefault();
      indexPage.classList.remove("is-dragover");
      if (e.dataTransfer?.files?.[0]) {
        openLibraryModal();
        handleFileUpload(e.dataTransfer.files[0]);
      }
    });
  }

  function renderLibraryCards() {
    libraryBookCount.textContent = String(libraryBooks.length);
    renderShelfIcons();
    if (libraryBooks.length === 0) {
      libraryGrid.innerHTML = `<div class="library-empty">No items yet. Drop an <strong>.epub</strong> / <strong>.pdf</strong> or paste a link above!</div>`;
      return;
    }

    libraryGrid.innerHTML = libraryBooks
      .map((b) => {
        const isCurrent = currentBook && currentBook.id === b.id;
        const job = b.job || { status: "ready", percent: 100 };
        const isProcessing = job.status === "processing";
        const isErr = job.status === "error";
        const pct = Math.max(4, Math.min(100, Number(job.percent || (isProcessing ? 10 : 100))));

        return `
          <div class="book-card ${isCurrent ? "is-current" : ""}" data-book-card="${escapeHTML(b.id)}">
            <div class="book-card__top">
              <div class="book-card__badges">
                <span class="book-card__format">${escapeHTML(b.sourceFormat || "book")}</span>
                <span class="book-card__meta">${b.chapterCount || 0} ch &middot; ${(b.wordCount || 0).toLocaleString()} words</span>
              </div>
              <h4 class="book-card__title">${escapeHTML(b.title)}</h4>
              <p class="book-card__author">${escapeHTML(b.author || "")}</p>
            </div>

            <div class="book-card__job">
              <div class="job-progress-track">
                <div class="job-progress-fill ${!isProcessing && !isErr ? "is-done" : ""}" style="width: ${pct}%"></div>
              </div>
              <span class="book-card__job-phase">${escapeHTML(
                job.phase || (isProcessing ? `Processing (${pct}%)…` : "Ready to read")
              )}</span>
            </div>

            <div class="book-card__actions">
              <button type="button" class="studio-primary-btn" data-open-book="${escapeHTML(b.id)}">${
          isCurrent ? "Reading Now" : "Open Book"
        }</button>
              <div style="display:flex;gap:0.3rem;">
                ${
                  isErr
                    ? `<button type="button" class="notes-action-btn" data-retry-book="${escapeHTML(b.id)}">Retry</button>`
                    : ""
                }
                <button type="button" class="notes-action-btn notes-action-btn--danger" data-delete-book="${escapeHTML(
                  b.id
                )}" title="Delete book">&times;</button>
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    libraryGrid.querySelectorAll("[data-open-book]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.openBook;
        await loadAndOpenBook(id, true);
        closeLibraryModal();
      });
    });

    libraryGrid.querySelectorAll("[data-retry-book]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.retryBook;
        await fetch(`/api/books/${encodeURIComponent(id)}/retry`, { method: "POST" }).catch(() => {});
        refreshLibraryList();
        startLivePolling();
      });
    });

    libraryGrid.querySelectorAll("[data-delete-book]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await deleteBookById(btn.dataset.deleteBook);
      });
    });
  }

  async function refreshLibraryList() {
    try {
      const res = await fetch("/api/books");
      if (!res.ok) throw new Error("Offline");
      const data = await res.json();
      libraryBooks = Array.isArray(data.books) ? data.books : [];
    } catch (_) {
      const cached = await idbGetAllBooks();
      libraryBooks = cached.map((b) => ({
        id: b.id,
        title: b.title,
        author: b.author,
        sourceFormat: b.sourceFormat,
        chapterCount: (b.chapters || []).length,
        wordCount: b.wordCount || 0,
        job: b.job || { status: "ready", percent: 100 },
      }));
    }
    renderLibraryCards();
  }

  async function loadAndOpenBook(bookId, pushHash = false) {
    let book = null;
    try {
      const res = await fetch(`/api/books/${encodeURIComponent(bookId)}`);
      if (res.ok) book = await res.json();
    } catch (_) {}

    if (!book) {
      book = await idbGetBook(bookId);
    }
    if (!book) return;

    setAppView("reader");
    if (pushHash) {
      const targetHash = `#book/${book.id}`;
      if (window.location.hash !== targetHash) {
        history.pushState(null, "", targetHash);
      }
      window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    }

    renderBookDOM(book);
    updateLiveJobPillFromBook(book);
    if (book.job?.status === "processing") {
      startLivePolling();
    }
  }

  function updateLiveJobPillFromBook(book) {
    const job = book?.job;
    if (!job || job.status !== "processing") {
      liveJobPill.hidden = true;
      return;
    }
    liveJobPill.hidden = false;
    const pct = Number(job.percent || 10);
    const comicsInfo =
      typeof job.comicsTotal === "number" && job.comicsTotal > 0
        ? ` · ${job.comicsDone || 0}/${job.comicsTotal} comics`
        : "";
    liveJobPillText.textContent = `Gemini ${pct}%${comicsInfo}`;
    liveJobPill.title = job.phase || "Gemini processing book in background";
  }

  function applyLiveVisualDiffs(progress) {
    if (!currentBook || currentBook.id !== progress.id) return;

    // If chapters just finished extracting for an empty book, load the full book immediately!
    if ((currentBook.chapters || []).length === 0 && progress.chapterCount > 0) {
      loadAndOpenBook(currentBook.id);
      return;
    }

    currentBook.title = progress.title || currentBook.title;
    currentBook.subtitle = progress.subtitle ?? currentBook.subtitle;
    currentBook.author = progress.author || currentBook.author;
    currentBook.publisherMeta = progress.publisherMeta || currentBook.publisherMeta;
    currentBook.pubDate = progress.pubDate || currentBook.pubDate;
    currentBook.balanceDue = progress.balanceDue || currentBook.balanceDue;
    currentBook.tagline = progress.tagline || currentBook.tagline;
    currentBook.job = progress.job;

    updateBookMasthead(currentBook);
    updateLiveJobPillFromBook(currentBook);

    // Hot-patch newly enriched section titles, diagrams, quotes & Story Comics without touching prose DOM!
    let updatedAny = false;
    (progress.chapterVisuals || []).forEach((cv) => {
      const localCh = (currentBook.chapters || []).find((c) => c.slug === cv.slug);
      if (!localCh) return;

      if (cv.shortTitle && cv.shortTitle !== localCh.shortTitle) {
        localCh.shortTitle = cv.shortTitle;
        const tocChEl = leftTocNav.querySelector(`[data-toc-ch-title="${cv.slug}"]`);
        if (tocChEl) tocChEl.textContent = cv.shortTitle;
        updatedAny = true;
      }

      (cv.sections || []).forEach((sv) => {
        const localSec = (localCh.sections || []).find((s) => s.id === sv.id);
        if (!localSec) return;

        const fig = document.getElementById(`vis-${sv.id}`);
        // Check if Gemini newly structured this section
        if (sv.enriched && !localSec.enriched) {
          Object.assign(localSec, sv);
          updatedAny = true;

          const tocTitleEl = leftTocNav.querySelector(`[data-toc-sec-title="${sv.id}"]`);
          const tocSubEl = leftTocNav.querySelector(`[data-toc-sec-sub="${sv.id}"]`);
          if (tocTitleEl) tocTitleEl.textContent = sv.title;
          if (tocSubEl) tocSubEl.textContent = sv.subtitle || "";

          const secEl = document.getElementById(sv.id);
          if (secEl) secEl.setAttribute("data-section-label", `${localSec.roman} · ${sv.title}`);

          if (fig) {
            const svgPane = fig.querySelector("[data-svg-pane]");
            if (svgPane) svgPane.innerHTML = renderDiagramSVG(sv.diagram);
            const cap = fig.querySelector(".section-visual__caption");
            if (cap) {
              cap.innerHTML = `
                <p class="section-visual__takeaway"><strong>${escapeHTML(
                  sv.takeawayLead || "Key Takeaway"
                )}:</strong> ${escapeHTML(sv.takeaway || "")}</p>
                ${sv.quote ? `<blockquote class="section-visual__quote">“${escapeHTML(sv.quote)}”</blockquote>` : ""}
              `;
            }
            const askBtn = fig.querySelector("[data-visual-ask]");
            if (askBtn) askBtn.setAttribute("data-visual-ask", sv.quote || sv.takeaway || sv.title);
          }
        }

        // Check if Story Comic just finished generating!
        if (sv.comicUrl && sv.comicUrl !== localSec.comicUrl) {
          localSec.comicUrl = sv.comicUrl;
          localSec.comicStatus = "ready";
          localSec.beats = sv.beats || localSec.beats;
          updatedAny = true;

          const ctrl = visualControllers.get(sv.id);
          if (ctrl) ctrl.hotInjectComic(localCh.slug, localSec);
        }
      });
    });

    if (updatedAny) {
      idbSaveBook(currentBook);
    }
  }

  function startLivePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      await refreshLibraryList();
      const anyProcessing = libraryBooks.some((b) => b.job?.status === "processing");

      if (currentBook) {
        try {
          const res = await fetch(`/api/books/${encodeURIComponent(currentBook.id)}/progress`);
          if (res.ok) {
            const prog = await res.json();
            applyLiveVisualDiffs(prog);
          }
        } catch (_) {}
      }

      if (!anyProcessing && (!currentBook || currentBook.job?.status !== "processing")) {
        clearInterval(pollTimer);
        pollTimer = null;
        liveJobPill.hidden = true;
      }
    }, 2400);
  }

  async function handleFileUpload(file) {
    if (!file) return;
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    if (ext !== ".epub" && ext !== ".pdf") {
      window.alert("Please select an .epub or .pdf book file.");
      return;
    }

    uploadStatusBar.hidden = false;
    uploadStatusText.textContent = `Uploading "${file.name}"…`;
    uploadStatusPct.textContent = "25%";
    uploadProgressFill.style.width = "25%";

    try {
      const res = await fetch("/api/books/upload", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name),
          "X-Comic-Mode": comicModeSelect.value || "all",
        },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");

      uploadStatusText.textContent = "Extracting full chapters & launching Gemini background worker…";
      uploadStatusPct.textContent = "65%";
      uploadProgressFill.style.width = "65%";

      // Poll briefly until initial text extraction finishes (~1-3 seconds), then open the book right away!
      const newId = data.bookId;
      for (let wait = 0; wait < 12; wait++) {
        await new Promise((r) => setTimeout(r, 700));
        const pRes = await fetch(`/api/books/${encodeURIComponent(newId)}/progress`);
        if (pRes.ok) {
          const pData = await pRes.json();
          if (pData.chapterCount > 0 || pData.job?.status === "error") break;
        }
      }

      uploadStatusBar.hidden = true;
      bookFileInput.value = "";
      await refreshLibraryList();
      await loadAndOpenBook(newId, true);
      closeLibraryModal();
      startLivePolling();
    } catch (err) {
      uploadStatusText.textContent = `Upload error: ${err.message}`;
      uploadStatusPct.textContent = "Error";
    }
  }

  uploadBrowseBtn.addEventListener("click", () => bookFileInput.click());
  bookFileInput.addEventListener("change", () => {
    if (bookFileInput.files && bookFileInput.files[0]) {
      handleFileUpload(bookFileInput.files[0]);
    }
  });

  async function handleUrlImport(rawUrl) {
    const url = String(rawUrl || "").trim();
    if (!url) return;

    uploadStatusBar.hidden = false;
    uploadStatusText.textContent = `Fetching book from link…`;
    uploadStatusPct.textContent = "20%";
    uploadProgressFill.style.width = "20%";
    if (bookUrlSubmitBtn) bookUrlSubmitBtn.disabled = true;

    try {
      const res = await fetch("/api/books/import-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          comicMode: comicModeSelect.value || "all",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Link import failed");

      uploadStatusText.textContent = "Extracting full chapters & launching Gemini background worker…";
      uploadStatusPct.textContent = "65%";
      uploadProgressFill.style.width = "65%";

      const newId = data.bookId;
      for (let wait = 0; wait < 14; wait++) {
        await new Promise((r) => setTimeout(r, 700));
        const pRes = await fetch(`/api/books/${encodeURIComponent(newId)}/progress`);
        if (pRes.ok) {
          const pData = await pRes.json();
          if (pData.chapterCount > 0 || pData.job?.status === "error") break;
        }
      }

      uploadStatusBar.hidden = true;
      if (bookUrlInput) bookUrlInput.value = "";
      await refreshLibraryList();
      await loadAndOpenBook(newId, true);
      closeLibraryModal();
      startLivePolling();
    } catch (err) {
      uploadStatusText.textContent = `Link error: ${err.message}`;
      uploadStatusPct.textContent = "Error";
    } finally {
      if (bookUrlSubmitBtn) bookUrlSubmitBtn.disabled = false;
    }
  }

  if (bookUrlForm) {
    bookUrlForm.addEventListener("submit", (e) => {
      e.preventDefault();
      handleUrlImport(bookUrlInput.value);
    });
  }

  uploadDropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadDropzone.classList.add("is-dragover");
  });
  uploadDropzone.addEventListener("dragleave", () => {
    uploadDropzone.classList.remove("is-dragover");
  });
  uploadDropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadDropzone.classList.remove("is-dragover");
    if (e.dataTransfer?.files?.[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  });

  /* ========================================================================
     11. Global Keyboard Shortcuts & App Initialization
     ======================================================================== */
  document.addEventListener("click", () => {
    closeAllDropdowns(null);
    closeNotePopover();
  });

  window.addEventListener(
    "scroll",
    () => {
      if (activeNoteLink && !notePopover.hidden) positionNotePopover(activeNoteLink);
      if (!selectionToolbar.hidden) hideSelectionToolbar();
    },
    { passive: true }
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAllDropdowns(null);
      closeNotePopover();
      hideSelectionToolbar();
      closeMobileDrawers();
      closeLibraryModal();
    } else if (
      (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) ||
      ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")
    ) {
      e.preventDefault();
      closeAllDropdowns(searchPanel);
      searchPanel.hidden = false;
      searchToggle.setAttribute("aria-expanded", "true");
      searchInput.focus();
      searchInput.select();
    }
  });

  window.addEventListener("popstate", () => {
    const hash = window.location.hash || "";
    const bookMatch = hash.match(/^#book\/(book_[a-z0-9_]+)/i);
    if (bookMatch) {
      const id = bookMatch[1];
      if (!currentBook || currentBook.id !== id || activeView !== "reader") {
        loadAndOpenBook(id, false);
      }
    } else if (hash === "" || hash === "#" || hash === "#index") {
      showIndexPage(false);
    }
  });

  function injectLocalPublishButton() {
    const actions = document.querySelector(".reader-bar__actions");
    if (!actions || document.getElementById("localPublishWebBtn") || document.getElementById("staticSaveSyncBtn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bar-btn";
    btn.id = "localPublishWebBtn";
    btn.title = "Upload all local books, notes, highlights, endnotes & chats from localhost to raila.io/imprint";
    btn.innerHTML = `<span aria-hidden="true">☁️</span><span class="bar-btn__label">Publish</span>`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const orig = btn.innerHTML;
      btn.innerHTML = `<span aria-hidden="true">⏳</span><span class="bar-btn__label">Uploading…</span>`;
      try {
        if (currentBook) {
          for (const ch of Object.keys(chapterData)) {
            await fetch(`/api/books/${encodeURIComponent(currentBook.id)}/annotations/sync`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chapter: ch, annotations: chapterData[ch].annotations || [], mode: "merge" }),
            });
            await fetch(`/api/books/${encodeURIComponent(currentBook.id)}/chat/sync`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chapter: ch, chatMessages: chapterData[ch].chatMessages || [] }),
            });
          }
        }
        const r = await fetch("/api/publish-github", { method: "POST" });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Publish failed");
        btn.innerHTML = `<span aria-hidden="true">✓</span><span class="bar-btn__label">Uploaded</span>`;
        setTimeout(() => {
          btn.innerHTML = orig;
          btn.disabled = false;
        }, 2400);
      } catch (err) {
        alert("Upload error: " + err.message);
        btn.innerHTML = orig;
        btn.disabled = false;
      }
    });
    actions.insertBefore(btn, actions.firstChild);
  }

  async function bootApp() {
    try {
      const stRes = await fetch("/api/status");
      if (stRes.ok) {
        const st = await stRes.json();
        serverAvailable = true;
        activeModel = st.activeModel || "gemini-4-neon";
        activeModelLabel = st.activeModelLabel || "Gemini 4 Neon";
        aiModelSelect.value = activeModel;
        updateModelStatusUI(Boolean(st.aiConnected));
        if (!st.staticPagesMode) injectLocalPublishButton();
      }
    } catch (_) {
      serverAvailable = false;
      updateModelStatusUI(false);
    }

    await refreshLibraryList();
    if (libraryBooks.some((b) => b.job?.status === "processing")) {
      startLivePolling();
    }

    // Route based on URL hash: `#book/<id>` (or in-book section hash on reload) opens reader; `/` or `#index` opens Icon Index Page
    const hash = window.location.hash || "";
    const bookMatch = hash.match(/^#book\/(book_[a-z0-9_]+)/i);
    const savedBookId = loadJSON(ACTIVE_BOOK_KEY, null);
    if (bookMatch && libraryBooks.some((b) => b.id === bookMatch[1])) {
      await loadAndOpenBook(bookMatch[1], false);
    } else if (hash && hash !== "#" && hash !== "#index" && savedBookId && libraryBooks.some((b) => b.id === savedBookId)) {
      await loadAndOpenBook(savedBookId, false);
    } else {
      showIndexPage(false);
    }
  }

  bootApp();
})();
