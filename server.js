/**
 * Imprint — Zero-Dependency Node Server + Background Gemini Book Pipeline
 *
 * Anyone can upload an .epub or .pdf book:
 *  1. Extracts the book's actual full chapter prose, folios, blockquotes & endnotes immediately.
 *  2. Runs Gemini in the background to enrich book receipt metadata, partition chapters into
 *     sections, build 3-step animated SVG concept diagrams, extract verbatim pull-quotes,
 *     and illustrate 16:9 widescreen Story Comics (`gemini-3.1-flash-image`).
 *  3. Persists all books, comics, highlights, margin notes, and Gemini 4 Neon AI chat threads
 *     directly in `data/books/<bookId>/` (and serves them to the website & IndexedDB cache).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const BOOKS_DIR = path.join(DATA_DIR, "books");
const LIBRARY_PATH = path.join(DATA_DIR, "library.json");
const EXTRACT_SCRIPT = path.join(ROOT_DIR, "scripts", "extract_book.py");
const ENV_FILE_PATH = path.join(ROOT_DIR, ".env");

const PYTHON_BIN = fs.existsSync("/usr/local/bin/python3")
  ? "/usr/local/bin/python3"
  : "python3";

const DEFAULT_CHAT_MODEL = "gemini-4-neon";
const ENRICH_TEXT_MODELS = ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-4-neon"];
const ENRICH_IMAGE_MODELS = ["gemini-3.1-flash-image", "gemini-nano-banana-2.1"];

const ALLOWED_MODELS = [
  { id: "gemini-4-neon", label: "Gemini 4 Neon" },
  { id: "gemini-4-carbon", label: "Gemini 4 Carbon" },
  { id: "gemini-4-argon", label: "Gemini 4 Argon" },
  { id: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
];

const ROMAN = [
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII",
];

function loadDotEnv() {
  const candidates = [
    ENV_FILE_PATH,
    process.env.HOME ? path.join(process.env.HOME, ".env") : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const lines = fs.readFileSync(candidate, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

loadDotEnv();

let activeModel = process.env.GEMINI_MODEL || DEFAULT_CHAT_MODEL;

function ensureDirs() {
  fs.mkdirSync(BOOKS_DIR, { recursive: true });
  if (!fs.existsSync(LIBRARY_PATH)) {
    fs.writeFileSync(LIBRARY_PATH, JSON.stringify({ books: [] }, null, 2), "utf8");
  }
}

ensureDirs();

function getModelLabel(modelId) {
  const found = ALLOWED_MODELS.find((m) => m.id === modelId);
  return found ? found.label : modelId;
}

function sanitizeBookId(id) {
  const s = String(id || "").trim().toLowerCase();
  return /^book_[a-z0-9_]+$/.test(s) ? s : null;
}

function normalizeChapterSlug(slug) {
  const s = String(slug || "").trim().toLowerCase();
  return /^chapter-\d+$/.test(s) ? s : "chapter-1";
}

function bookDir(bookId) {
  return path.join(BOOKS_DIR, bookId);
}

function bookJsonPath(bookId) {
  return path.join(bookDir(bookId), "book.json");
}

function bookStatePath(bookId) {
  return path.join(bookDir(bookId), "state.json");
}

function readLibrary() {
  ensureDirs();
  try {
    const data = JSON.parse(fs.readFileSync(LIBRARY_PATH, "utf8"));
    return Array.isArray(data.books) ? data : { books: [] };
  } catch (_) {
    return { books: [] };
  }
}

function writeLibrary(lib) {
  ensureDirs();
  const tmp = `${LIBRARY_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lib, null, 2), "utf8");
  fs.renameSync(tmp, LIBRARY_PATH);
}

function readBook(bookId) {
  const p = bookJsonPath(bookId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    return null;
  }
}

function writeBook(book) {
  const dir = bookDir(book.id);
  fs.mkdirSync(dir, { recursive: true });
  book.updatedAt = Date.now();
  const target = bookJsonPath(book.id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(book, null, 2), "utf8");
  fs.renameSync(tmp, target);
  upsertLibraryEntry(book);
}

function upsertLibraryEntry(book) {
  const lib = readLibrary();
  const summary = {
    id: book.id,
    title: book.title || "Untitled Book",
    subtitle: book.subtitle || "",
    author: book.author || "Unknown Author",
    publisherMeta: book.publisherMeta || "DIGITAL EDITION",
    pubDate: book.pubDate || "",
    tagline: book.tagline || "",
    sourceFormat: book.sourceFormat || "epub",
    sourceUrl: book.sourceUrl || "",
    originalFilename: book.originalFilename || "",
    chapterCount: Array.isArray(book.chapters) ? book.chapters.length : 0,
    wordCount: book.wordCount || 0,
    totalPages: book.totalPages || 0,
    createdAt: book.createdAt || Date.now(),
    updatedAt: book.updatedAt || Date.now(),
    job: book.job || { status: "ready", percent: 100 },
    previewComicUrl: findFirstComicUrl(book),
  };

  const idx = lib.books.findIndex((b) => b.id === book.id);
  if (idx >= 0) lib.books[idx] = summary;
  else lib.books.unshift(summary);
  writeLibrary(lib);
}

function findFirstComicUrl(book) {
  for (const ch of book.chapters || []) {
    for (const sec of ch.sections || []) {
      if (sec.comicUrl) return sec.comicUrl;
    }
  }
  return "";
}

function readBookState(bookId) {
  const p = bookStatePath(bookId);
  if (!fs.existsSync(p)) return { chapters: {} };
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    return d && typeof d.chapters === "object" ? d : { chapters: {} };
  } catch (_) {
    return { chapters: {} };
  }
}

function writeBookState(bookId, state) {
  const dir = bookDir(bookId);
  fs.mkdirSync(dir, { recursive: true });
  const target = bookStatePath(bookId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, target);
}

function decodeHtmlEntitiesBasic(str) {
  return String(str || "")
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(Number(d));
      } catch (_) {
        return _;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch (_) {
        return _;
      }
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTags(htmlStr) {
  return decodeHtmlEntitiesBasic(
    String(htmlStr || "")
      .replace(/<span class="folio-marker"[^>]*>.*?<\/span>/gi, " ")
      .replace(/<sup class="note-ref"[^>]*>.*?<\/sup>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function stripTagsKeepUrls(htmlStr) {
  return String(htmlStr || "")
    .replace(/<span class="folio-marker"[^>]*>.*?<\/span>/gi, " ")
    .replace(/<sup class="note-ref">.*?<\/sup>/gi, " ")
    .replace(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtmlServer(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInlineNoteServer(escapedLine) {
  const linkTokens = [];
  let out = escapedLine.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, label, url) => {
      const idx = linkTokens.length;
      linkTokens.push(
        `<a href="${url}" target="_blank" rel="noopener noreferrer" class="prose-link">${label}</a>`
      );
      return `%%ENLNK${idx}%%`;
    }
  );
  out = out.replace(/(^|[\s(>])(https?:\/\/[^\s<)"']+)/g, (_, prefix, rawUrl) => {
    const trail = rawUrl.match(/([.,;:!?)]+)$/);
    const cleanUrl = trail ? rawUrl.slice(0, -trail[1].length) : rawUrl;
    const suffix = trail ? trail[1] : "";
    const idx = linkTokens.length;
    linkTokens.push(
      `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="prose-link">${cleanUrl}</a>`
    );
    return `${prefix}%%ENLNK${idx}%%${suffix}`;
  });
  out = out
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  linkTokens.forEach((htmlLink, idx) => {
    out = out.split(`%%ENLNK${idx}%%`).join(htmlLink);
  });
  return out;
}

function markdownToEndnoteHtml(rawText) {
  // Protect inline math $...$ before emphasis rules so LaTeX underscores/asterisks stay intact
  const mathTokens = [];
  const pre = String(rawText || "")
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\s)(?:\\.|[^$\\\n])+?(?<!\s)\$/g, (m) => {
      const idx = mathTokens.length;
      mathTokens.push(escapeHtmlServer(m));
      return `%%ENMTH${idx}%%`;
    });

  const lines = pre.split("\n");
  const blocks = [];
  let para = [];
  let listType = null;
  let listItems = [];

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(`<p>${para.map(formatInlineNoteServer).join("<br/>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    blocks.push(
      `<${tag} class="md-list">${listItems.map((li) => `<li>${formatInlineNoteServer(li)}</li>`).join("")}</${tag}>`
    );
    listType = null;
    listItems = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushPara();
      flushList();
      blocks.push('<hr class="md-hr" />');
      continue;
    }
    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      flushPara();
      flushList();
      blocks.push(`<h4 class="md-h4">${formatInlineNoteServer(escapeHtmlServer(hMatch[2]))}</h4>`);
      continue;
    }
    const ulMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (ulMatch) {
      flushPara();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(escapeHtmlServer(ulMatch[1]));
      continue;
    }
    const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (olMatch) {
      flushPara();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(escapeHtmlServer(olMatch[1]));
      continue;
    }
    flushList();
    para.push(escapeHtmlServer(trimmed));
  }
  flushPara();
  flushList();

  let htmlOut = blocks.length === 1 && blocks[0].startsWith("<p>")
    ? blocks[0].slice(3, -4)
    : blocks.join("");

  mathTokens.forEach((m, idx) => {
    htmlOut = htmlOut.split(`%%ENMTH${idx}%%`).join(m);
  });
  return htmlOut;
}

function decodeEntityUtf16Len(entity) {
  const dec = entity.match(/^&#(\d+);$/);
  if (dec) {
    try {
      return String.fromCodePoint(Number(dec[1])).length;
    } catch (_) {
      return 1;
    }
  }
  const hex = entity.match(/^&#x([0-9a-fA-F]+);$/);
  if (hex) {
    try {
      return String.fromCodePoint(parseInt(hex[1], 16)).length;
    } catch (_) {
      return 1;
    }
  }
  return 1;
}

function ensureChapterEndnoteUids(ch) {
  const endnotes = Array.isArray(ch.endnotes) ? ch.endnotes : [];
  const numToUid = new Map();
  endnotes.forEach((n, idx) => {
    const num = n.num || idx + 1;
    if (!n.uid) n.uid = `en_${ch.num}_${num}`;
    numToUid.set(String(num), n.uid);
  });

  (ch.paragraphs || []).forEach((p) => {
    p.html = String(p.html || "").replace(
      /<sup class="note-ref"(?:\s+data-note-uid="([^"]+)")?[^>]*>([\s\S]*?)<\/sup>/gi,
      (full, existingUid, inner) => {
        if (existingUid) return full;
        const mNum = inner.match(/data-note="(\d+)"/i) || inner.match(/>(\d+)<\/a>/i);
        const numStr = mNum ? mNum[1] : "";
        const uid = numToUid.get(numStr) || `en_auto_${Math.random().toString(36).slice(2, 7)}`;
        return `<sup class="note-ref" data-note-uid="${uid}">${inner}</sup>`;
      }
    );
  });
}

function insertSuperscriptInParagraphHtml(paraHtml, targetOffset, uid, chNum) {
  const htmlStr = String(paraHtml || "");
  const tokenRe =
    /<span class="folio-marker"[^>]*>[\s\S]*?<\/span>|<sup class="note-ref"[^>]*>[\s\S]*?<\/sup>|<[^>]+>|&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z0-9]+);|[\s\S]/gi;

  let visCount = 0;
  let insertPos = htmlStr.length;
  let reached = false;
  let match;

  while ((match = tokenRe.exec(htmlStr)) !== null) {
    const tok = match[0];
    const tokStart = match.index;
    const tokEnd = tokStart + tok.length;

    if (tok.startsWith("<")) {
      if (reached) {
        // Step cleanly past closing inline tags right at the end of the selection
        if (/^<\/(?:a|em|i|strong|b|code|sub|sup)>$/i.test(tok)) {
          insertPos = tokEnd;
          continue;
        }
        break;
      }
      continue;
    }

    if (reached) break;

    const charLen = tok.startsWith("&") && tok.endsWith(";") ? decodeEntityUtf16Len(tok) : tok.length;
    visCount += charLen;
    if (visCount >= targetOffset) {
      insertPos = tokEnd;
      reached = true;
    }
  }

  const supTag = `<sup class="note-ref" data-note-uid="${uid}"><a href="#ch${chNum}-note-1" id="ch${chNum}-ref-1" data-note="1" aria-label="Note 1">1</a></sup>`;
  return htmlStr.slice(0, insertPos) + supTag + htmlStr.slice(insertPos);
}

function renumberChapterEndnotes(ch) {
  ensureChapterEndnoteUids(ch);
  const byUid = new Map();
  (ch.endnotes || []).forEach((n) => {
    byUid.set(n.uid, n);
  });

  const ordered = [];
  const seenUids = new Set();

  (ch.paragraphs || []).forEach((p) => {
    p.html = String(p.html || "").replace(
      /<sup class="note-ref"\s+data-note-uid="([^"]+)"[^>]*>[\s\S]*?<\/sup>/gi,
      (_, uid) => {
        const noteObj = byUid.get(uid);
        if (!noteObj) return "";
        let assignedNum;
        if (!seenUids.has(uid)) {
          seenUids.add(uid);
          assignedNum = ordered.length + 1;
          ordered.push({
            ...noteObj,
            uid,
            num: assignedNum,
            page: p.page || noteObj.page || ch.folioStart || 1,
            anchored: true,
          });
        } else {
          assignedNum = ordered.find((x) => x.uid === uid)?.num || 1;
        }
        return `<sup class="note-ref" data-note-uid="${uid}"><a href="#ch${ch.num}-note-${assignedNum}" id="ch${ch.num}-ref-${assignedNum}" data-note="${assignedNum}" aria-label="Note ${assignedNum}">${assignedNum}</a></sup>`;
      }
    );
  });

  // Append any unanchored chapter-end notes in order
  for (const n of ch.endnotes || []) {
    if (!seenUids.has(n.uid)) {
      seenUids.add(n.uid);
      ordered.push({
        ...n,
        num: ordered.length + 1,
        page: n.page || ch.folioEnd || ch.folioStart || 1,
        anchored: false,
      });
    }
  }

  ch.endnotes = ordered;
  ch.receiptNotes =
    ordered.length > 0
      ? `NOS. 01–${String(ordered.length).padStart(2, "0")}`
      : "INLINE EDITION";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function execFilePromise(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

/* ==========================================================================
   Heuristic Immediate Section Builder (So Book is Readable in 2 Seconds!)
   ========================================================================== */

function desiredSectionCount(paragraphCount, wordCount) {
  if (paragraphCount <= 5 || wordCount < 550) return 1;
  if (paragraphCount <= 12 || wordCount < 1500) return 2;
  if (paragraphCount <= 24 || wordCount < 3200) return 3;
  return 4;
}

function buildInitialSections(ch) {
  const paras = ch.paragraphs || [];
  const total = paras.length;
  const count = desiredSectionCount(total, ch.wordCount || 0);
  const sections = [];

  for (let i = 0; i < count; i++) {
    const startIdx = Math.floor((i * total) / count);
    const endIdx = i + 1 < count ? Math.floor(((i + 1) * total) / count) - 1 : Math.max(0, total - 1);
    const slice = paras.slice(startIdx, endIdx + 1);
    const startPage = slice[0]?.page || ch.folioStart || 1;
    const endPage = slice[slice.length - 1]?.page || ch.folioEnd || startPage;

    // Find a clean verbatim quote from the actual prose
    let sampleQuote = "";
    for (const p of slice) {
      const txt = stripTags(p.html);
      const sentences = txt.match(/[^.!?]+[.!?]+/g) || [txt];
      const good = sentences.find((s) => s.trim().length >= 48 && s.trim().length <= 210);
      if (good) {
        sampleQuote = good.trim();
        break;
      }
    }
    if (!sampleQuote && slice[0]) {
      sampleQuote = stripTags(slice[0].html).slice(0, 160);
    }

    const subheadInSlice = slice.find((p) => p.type === "subhead");
    const secTitle = subheadInSlice
      ? stripTags(subheadInSlice.html).slice(0, 52)
      : count === 1
      ? ch.shortTitle || ch.title
      : `Movement ${ROMAN[i]}`;

    sections.push({
      id: `ch${ch.num}-section-${i + 1}`,
      num: i + 1,
      roman: ROMAN[i] || String(i + 1),
      startParagraphIndex: startIdx,
      pageStart: startPage,
      pageEnd: endPage,
      title: secTitle,
      subtitle: `pp. ${startPage}–${endPage}`,
      takeawayLead: "Reading Guide",
      takeaway: "Gemini is analyzing this section in the background to generate its concept diagram and Story Comic.",
      quote: sampleQuote,
      diagram: {
        heading: `${(ch.shortTitle || ch.title).toUpperCase().slice(0, 34)} · ${ROMAN[i]}`,
        box1: { title: "OPENING PREMISE", sub: `Section ${ROMAN[i]} context` },
        box2: { title: "CORE DEVELOPMENT", sub: "Key tension & evidence" },
        box3: { title: "IMPLICATION", sub: `pp. ${startPage}–${endPage}` },
        footer: `${ch.title} — Section ${ROMAN[i]}`,
      },
      beats: ["1. Opening", "2. Core Idea", "3. Turning Point", "4. Outcome"],
      comicUrl: "",
      comicStatus: "pending",
      enriched: false,
    });
  }
  return sections;
}

/* ==========================================================================
   Gemini JSON & Image Calls with Automatic Retry / Model Fallback
   ========================================================================== */

function extractJsonObject(rawText) {
  const cleaned = String(rawText || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1));
    }
    throw new Error("Could not parse JSON from Gemini output");
  }
}

async function callGeminiJSON(promptText, systemText = "") {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");

  let lastErr = null;
  for (const model of ENRICH_TEXT_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const payload = {
          contents: [{ role: "user", parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: 0.35,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
          },
        };
        if (systemText) {
          payload.systemInstruction = { parts: [{ text: systemText }] };
        }

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model
          )}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }
        );

        if (res.status === 429) {
          await sleep(2600 * (attempt + 1));
          continue;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error?.message || `HTTP ${res.status}`);
        }
        const parts = data.candidates?.[0]?.content?.parts || [];
        const text = parts
          .filter((p) => !p.thought && typeof p.text === "string")
          .map((p) => p.text)
          .join("")
          .trim();
        if (!text) throw new Error("Empty JSON response");
        return extractJsonObject(text);
      } catch (err) {
        lastErr = err;
        await sleep(800);
      }
    }
  }
  throw lastErr || new Error("Gemini JSON enrichment failed");
}

async function generateComicImageToFile(promptText, outputFilePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");

  let lastErr = null;
  for (const model of ENRICH_IMAGE_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model
          )}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: promptText }] }],
              generationConfig: {
                responseModalities: ["IMAGE"],
                imageConfig: { aspectRatio: "16:9" },
              },
            }),
          }
        );

        if (res.status === 429) {
          await sleep(3500 * (attempt + 1));
          continue;
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error?.message || `Image HTTP ${res.status}`);
        }

        const parts = data.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find((p) => p.inlineData && p.inlineData.data);
        if (!imgPart) {
          throw new Error("No inlineData image returned by Gemini image model");
        }

        const buf = Buffer.from(imgPart.inlineData.data, "base64");
        fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
        const rawTmp = `${outputFilePath}.raw`;
        fs.writeFileSync(rawTmp, buf);

        // Optimize image dimensions & JPEG size via macOS sips when available
        if (fs.existsSync("/usr/bin/sips")) {
          try {
            await execFilePromise("/usr/bin/sips", [
              "-Z",
              "1440",
              "-s",
              "format",
              "jpeg",
              "-s",
              "formatOptions",
              "82",
              rawTmp,
              "--out",
              outputFilePath,
            ]);
            fs.unlinkSync(rawTmp);
            return outputFilePath;
          } catch (_) {
            // Fall through to direct rename
          }
        }
        fs.renameSync(rawTmp, outputFilePath);
        return outputFilePath;
      } catch (err) {
        lastErr = err;
        await sleep(1800 * (attempt + 1));
      }
    }
  }
  throw lastErr || new Error("Story Comic generation failed");
}

function buildStoryComicPrompt({ bookTitle, author, chapterTitle, sectionTitle, comicSpec, takeaway }) {
  const spec = comicSpec || {};
  const centerScene = spec.centerScene || `Key narrative moment illustrating "${sectionTitle}" from "${bookTitle}"`;
  const centerBubble = spec.centerBubble || sectionTitle;
  const tlScene = spec.topLeftScene || "Opening context vignette with period-accurate characters and setting";
  const tlLabel = spec.topLeftLabel || "1. Context";
  const trScene = spec.topRightScene || "Rising tension or institutional contrast vignette";
  const trLabel = spec.topRightLabel || "3. Turning Point";
  const brScene = spec.bottomRightScene || "Human consequence or resolution vignette";
  const brLabel = spec.bottomRightLabel || "4. Consequence";

  return [
    `16:9 widescreen editorial pen-and-ink and warm watercolor Story Comic illustration on cream archival book paper (#f5efe2) with subtle vermilion (#e12b1d) and deep indigo (#27328c) ink accents, in the style of a New Yorker / Melville House literary nonfiction graphic narrative.`,
    `Book: "${bookTitle}" by ${author} — ${chapterTitle} (${sectionTitle}).`,
    `LAYOUT (strictly compose these 5 focal zones so guided camera zoom works seamlessly):`,
    `- CENTER (50% x, 38% y): ${centerScene}. Include one crisp hand-lettered speech or thought banner reading: "${String(centerBubble).slice(0, 68)}".`,
    `- TOP-LEFT CLOUD VIGNETTE (15% x, 22% y): ${tlScene}, with small hand-lettered ribbon caption "${String(tlLabel).slice(0, 28)}".`,
    `- TOP-RIGHT CLOUD VIGNETTE (85% x, 22% y): ${trScene}, with small hand-lettered ribbon caption "${String(trLabel).slice(0, 28)}".`,
    `- BOTTOM-RIGHT CLOUD VIGNETTE (85% x, 80% y): ${brScene}, with small hand-lettered ribbon caption "${String(brLabel).slice(0, 28)}".`,
    `Core idea: ${takeaway || sectionTitle}. Crisp ink linework, expressive faces, warm editorial wash, legible hand-lettered short labels only, no watermarks.`,
  ].join("\n");
}

/* ==========================================================================
   Asynchronous Background Processing Queue
   ========================================================================== */

const activeBookJobs = new Set();

async function processBookInBackground(bookId, options = {}) {
  if (activeBookJobs.has(bookId)) return;
  activeBookJobs.add(bookId);

  const comicMode = options.comicMode || "all"; // "all" | "first" | "diagrams_only"

  try {
    let book = readBook(bookId);
    if (!book) return;

    const dir = bookDir(bookId);
    const extractedPath = path.join(dir, "extracted.json");

    // PHASE 1: Extract full actual text from EPUB / PDF if not already extracted
    if (!book.chapters || book.chapters.length === 0) {
      book.job = {
        ...book.job,
        status: "processing",
        phase: `Extracting full chapters & text from ${book.sourceFormat.toUpperCase()}…`,
        percent: 5,
      };
      writeBook(book);

      await execFilePromise(PYTHON_BIN, [EXTRACT_SCRIPT, book.sourcePath, extractedPath]);
      const extracted = JSON.parse(fs.readFileSync(extractedPath, "utf8"));

      book.title = extracted.title || book.title;
      book.subtitle = extracted.subtitle || "";
      book.author = extracted.author || "Unknown Author";
      book.publisherMeta = extracted.publisherMeta || "DIGITAL EDITION";
      book.pubDate = extracted.pubDate || "";
      book.totalPages = extracted.totalPages || 1;
      book.wordCount = extracted.wordCount || 0;
      book.balanceDue = "OPEN EDITION";
      book.tagline = `“${book.title.toUpperCase()}”`;

      book.chapters = (extracted.chapters || []).map((ch) => {
        const sections = buildInitialSections(ch);
        const notesCount = (ch.endnotes || []).length;
        return {
          slug: ch.slug,
          num: ch.num,
          chapterLabel: ch.chapterLabel || `Chapter ${ch.num}`,
          title: ch.title,
          shortTitle: ch.shortTitle || ch.title,
          subtitle: "",
          folioStart: ch.folioStart,
          folioEnd: ch.folioEnd,
          wordCount: ch.wordCount,
          receiptItem: (ch.chapterLabel || `CHAPTER ${ch.num}`).toUpperCase(),
          receiptFolio: `PP. ${String(ch.folioStart).padStart(2, "0")}–${String(ch.folioEnd).padStart(2, "0")}`,
          receiptNotes: notesCount > 0 ? `NOS. 01–${String(notesCount).padStart(2, "0")}` : "INLINE EDITION",
          receiptTagline: sections[0]?.quote ? `“${sections[0].quote.slice(0, 72).toUpperCase()}”` : `“${ch.title.toUpperCase()}”`,
          aiThemes: `${ch.chapterLabel}: ${ch.title} from ${book.title} by ${book.author}.`,
          epigraphs: [],
          sections,
          paragraphs: ch.paragraphs,
          endnotes: ch.endnotes || [],
          enriched: false,
        };
      });

      book.job.chaptersExtracted = book.chapters.length;
      book.job.readable = true;
      book.job.percent = 14;
      book.job.phase = `Extracted ${book.chapters.length} chapter(s) (${book.wordCount.toLocaleString()} words). Starting Gemini enrichment…`;
      writeBook(book);
    }

    if (!process.env.GEMINI_API_KEY) {
      book.job = {
        ...book.job,
        status: "ready",
        readable: true,
        percent: 100,
        phase: "Full book extracted (set GEMINI_API_KEY in .env for Story Comics & AI diagrams).",
      };
      writeBook(book);
      return;
    }

    // Compute total steps = 1 (book masthead) + N chapter analyses + M section comics
    const chapters = book.chapters || [];
    const plannedComics = [];
    chapters.forEach((ch, cIdx) => {
      (ch.sections || []).forEach((sec, sIdx) => {
        if (comicMode === "diagrams_only") return;
        if (comicMode === "first" && sIdx > 0) return;
        plannedComics.push({ cIdx, sIdx });
      });
    });

    const totalSteps = 1 + chapters.length + plannedComics.length;
    let completedSteps = 0;

    const updateJob = (phase) => {
      const pct = Math.min(99, Math.max(15, Math.round((completedSteps / Math.max(1, totalSteps)) * 85) + 14));
      book.job = {
        ...book.job,
        status: "processing",
        readable: true,
        comicMode,
        completedSteps,
        totalSteps,
        comicsDone: book.chapters.reduce(
          (acc, c) => acc + (c.sections || []).filter((s) => Boolean(s.comicUrl)).length,
          0
        ),
        comicsTotal: plannedComics.length,
        percent: pct,
        phase,
      };
      writeBook(book);
    };

    // PHASE 2: Enrich Book-Level Receipt Masthead Metadata
    if (!book.mastheadEnriched) {
      updateJob("Gemini analyzing book metadata & receipt masthead…");
      try {
        const openingSample = (chapters[0]?.paragraphs || [])
          .slice(0, 8)
          .map((p) => stripTags(p.html))
          .join("\n")
          .slice(0, 1800);
        const tocSummary = chapters
          .slice(0, 16)
          .map((c) => `${c.chapterLabel}: ${c.title}`)
          .join("; ");

        const metaJson = await callGeminiJSON(
          [
            `Analyze this uploaded book and return clean editorial masthead metadata as JSON.`,
            `Detected Title: ${book.title}`,
            `Detected Subtitle: ${book.subtitle}`,
            `Detected Author: ${book.author}`,
            `Detected Publisher/Date: ${book.publisherMeta} / ${book.pubDate}`,
            `Chapters: ${tocSummary}`,
            `Opening prose sample:\n${openingSample}`,
            ``,
            `Return JSON with exact keys:`,
            `{`,
            `  "title": "Clean main book title (without subtitle)",`,
            `  "subtitle": "Clean subtitle if the book has one, else empty string",`,
            `  "author": "Clean author full name",`,
            `  "publisherMeta": "SHORT PUBLISHER OR EDITION LINE IN CAPS (max 28 chars)",`,
            `  "pubDate": "YEAR OR MONTH YEAR IN CAPS (max 12 chars)",`,
            `  "balanceDue": "2-WORD THEMATIC RECEIPT STATUS IN CAPS (e.g. INDEFINITE, UNSETTLED, TIMELESS, OPEN LEDGER)",`,
            `  "tagline": "A short iconic verbatim line or crisp epigram from the book (max 75 chars)"`,
            `}`,
          ].join("\n")
        );

        if (metaJson.title) book.title = String(metaJson.title).trim();
        if (typeof metaJson.subtitle === "string") book.subtitle = metaJson.subtitle.trim();
        if (metaJson.author) book.author = String(metaJson.author).trim();
        if (metaJson.publisherMeta) book.publisherMeta = String(metaJson.publisherMeta).toUpperCase().slice(0, 34);
        if (metaJson.pubDate) book.pubDate = String(metaJson.pubDate).toUpperCase().slice(0, 16);
        if (metaJson.balanceDue) book.balanceDue = String(metaJson.balanceDue).toUpperCase().slice(0, 20);
        if (metaJson.tagline) {
          const cleanTag = String(metaJson.tagline).replace(/^[“"']+|[”"']+$/g, "").trim();
          book.tagline = `“${cleanTag.toUpperCase()}”`;
        }
        book.mastheadEnriched = true;
      } catch (err) {
        console.warn(`[Book ${bookId}] Masthead enrichment warning:`, err.message);
      }
    }
    completedSteps += 1;
    updateJob("Book masthead ready. Structuring chapters & concept diagrams…");

    // PHASE 3: Per-Chapter Section Structure + SVG Concept Diagrams + AI Context
    for (let cIdx = 0; cIdx < chapters.length; cIdx++) {
      const ch = chapters[cIdx];
      if (!ch.enriched) {
        updateJob(`Structuring ${ch.chapterLabel} (${cIdx + 1}/${chapters.length}): sections & SVG diagrams…`);
        try {
          const paras = ch.paragraphs || [];
          const targetSecCount = (ch.sections || []).length || desiredSectionCount(paras.length, ch.wordCount);

          // Sample indexed paragraphs across the entire chapter so Gemini places accurate boundaries & quotes
          const step = Math.max(1, Math.ceil(paras.length / 48));
          const indexedPreview = [];
          for (let pIdx = 0; pIdx < paras.length; pIdx += step) {
            const txt = stripTags(paras[pIdx].html);
            if (!txt) continue;
            indexedPreview.push(`[P${pIdx} | p.${paras[pIdx].page}] ${txt.slice(0, 280)}`);
          }

          const chPrompt = [
            `Book: "${book.title}" by ${book.author}`,
            `Chapter ${ch.num}: "${ch.title}" (Total paragraphs: ${paras.length}, pages ${ch.folioStart}–${ch.folioEnd})`,
            ``,
            `Indexed excerpts from the actual chapter text:`,
            indexedPreview.join("\n"),
            ``,
            `Partition this chapter into EXACTLY ${targetSecCount} thematic section(s) covering paragraphs 0 through ${Math.max(0, paras.length - 1)}.`,
            `IMPORTANT: Do NOT rewrite the chapter prose—only provide section start indices, titles, verbatim pull-quotes, 3-step SVG concept diagrams, and Story Comic scene specs.`,
            ``,
            `Return valid JSON matching this exact schema:`,
            `{`,
            `  "cleanChapterTitle": "Clean chapter title",`,
            `  "shortTitle": "2-4 word compact menu label",`,
            `  "receiptTagline": "Short striking verbatim quote from this chapter (max 70 chars)",`,
            `  "aiThemes": "Dense 90-130 word scholarly summary of key arguments, examples, names, and concepts in this chapter for the study AI",`,
            `  "sections": [`,
            `    {`,
            `      "startParagraphIndex": 0,`,
            `      "title": "3-6 word section title",`,
            `      "subtitle": "5-10 word TOC subtitle",`,
            `      "takeawayLead": "2-3 word bold lead",`,
            `      "takeaway": "One crisp analytical sentence capturing this section's core argument (max 190 chars)",`,
            `      "quote": "Exact verbatim quote from this section of the text (max 200 chars)",`,
            `      "diagram": {`,
            `        "heading": "SHORT CAPS DIAGRAM HEADER (max 34 chars)",`,
            `        "box1": { "title": "STEP 1 CAPS (max 18 chars)", "sub": "3-5 word sublabel" },`,
            `        "box2": { "title": "STEP 2 CAPS (max 18 chars)", "sub": "3-5 word sublabel" },`,
            `        "box3": { "title": "STEP 3 CAPS (max 18 chars)", "sub": "3-5 word sublabel" },`,
            `        "footer": "Concise synthesis takeaway line (max 66 chars)"`,
            `      },`,
            `      "comicSpec": {`,
            `        "centerBubble": "Short dramatic speech/banner quote (max 52 chars)",`,
            `        "centerScene": "Concrete visual description of the central scene & characters",`,
            `        "topLeftScene": "Visual scene for beat 1 (top-left cloud)",`,
            `        "topLeftLabel": "1. Short Beat (max 18 chars)",`,
            `        "topRightScene": "Visual scene for beat 3 (top-right cloud)",`,
            `        "topRightLabel": "3. Short Beat (max 18 chars)",`,
            `        "bottomRightScene": "Visual scene for beat 4 (bottom-right cloud)",`,
            `        "bottomRightLabel": "4. Short Beat (max 18 chars)",`,
            `        "centerBeatLabel": "2. Short Beat (max 18 chars)"`,
            `      }`,
            `    }`,
            `  ]`,
            `}`,
          ].join("\n");

          const chJson = await callGeminiJSON(chPrompt);

          if (chJson.cleanChapterTitle) ch.title = String(chJson.cleanChapterTitle).trim();
          if (chJson.shortTitle) ch.shortTitle = String(chJson.shortTitle).trim().slice(0, 38);
          if (chJson.receiptTagline) {
            const qt = String(chJson.receiptTagline).replace(/^[“"']+|[”"']+$/g, "").trim();
            ch.receiptTagline = `“${qt.toUpperCase().slice(0, 78)}”`;
          }
          if (chJson.aiThemes) ch.aiThemes = String(chJson.aiThemes).trim();

          if (Array.isArray(chJson.sections) && chJson.sections.length > 0) {
            const rawSecs = chJson.sections.slice(0, targetSecCount);
            let lastStart = 0;
            ch.sections = rawSecs.map((s, idx) => {
              const prevSec = ch.sections[idx] || {};
              let startIdx = idx === 0 ? 0 : Number(s.startParagraphIndex ?? prevSec.startParagraphIndex ?? idx);
              if (!Number.isFinite(startIdx) || startIdx <= lastStart) {
                startIdx = idx === 0 ? 0 : Math.min(Math.max(lastStart + 1, Math.floor((idx * paras.length) / rawSecs.length)), Math.max(0, paras.length - 1));
              }
              if (startIdx >= paras.length) startIdx = Math.max(0, paras.length - 1);
              lastStart = startIdx;

              const nextStart = idx + 1 < rawSecs.length
                ? Math.min(paras.length - 1, Math.max(startIdx, Number(rawSecs[idx + 1]?.startParagraphIndex || paras.length - 1) - 1))
                : Math.max(0, paras.length - 1);
              const pStart = paras[startIdx]?.page || ch.folioStart || 1;
              const pEnd = paras[nextStart]?.page || ch.folioEnd || pStart;

              const cSpec = s.comicSpec || {};
              const b1 = String(cSpec.topLeftLabel || "1. Opening").replace(/^[1-4]\.\s*/, "");
              const b2 = String(cSpec.centerBeatLabel || "2. Core Claim").replace(/^[1-4]\.\s*/, "");
              const b3 = String(cSpec.topRightLabel || "3. Turning Point").replace(/^[1-4]\.\s*/, "");
              const b4 = String(cSpec.bottomRightLabel || "4. Outcome").replace(/^[1-4]\.\s*/, "");

              return {
                id: `ch${ch.num}-section-${idx + 1}`,
                num: idx + 1,
                roman: ROMAN[idx] || String(idx + 1),
                startParagraphIndex: startIdx,
                pageStart: pStart,
                pageEnd: pEnd,
                title: String(s.title || prevSec.title || `Section ${ROMAN[idx]}`).trim(),
                subtitle: String(s.subtitle || prevSec.subtitle || `pp. ${pStart}–${pEnd}`).trim(),
                takeawayLead: String(s.takeawayLead || "Key Takeaway").replace(/:$/, "").trim(),
                takeaway: String(s.takeaway || prevSec.takeaway || "").trim(),
                quote: String(s.quote || prevSec.quote || "").replace(/^[“"']+|[”"']+$/g, "").trim(),
                diagram: {
                  heading: String(s.diagram?.heading || `${ch.shortTitle.toUpperCase()} · ${ROMAN[idx]}`).slice(0, 42),
                  box1: {
                    title: String(s.diagram?.box1?.title || "PREMISE").slice(0, 22),
                    sub: String(s.diagram?.box1?.sub || "").slice(0, 32),
                  },
                  box2: {
                    title: String(s.diagram?.box2?.title || "MECHANISM").slice(0, 22),
                    sub: String(s.diagram?.box2?.sub || "").slice(0, 32),
                  },
                  box3: {
                    title: String(s.diagram?.box3?.title || "OUTCOME").slice(0, 22),
                    sub: String(s.diagram?.box3?.sub || "").slice(0, 32),
                  },
                  footer: String(s.diagram?.footer || "").slice(0, 74),
                },
                comicSpec: cSpec,
                beats: [
                  `1. ${b1.slice(0, 20)}`,
                  `2. ${b2.slice(0, 20)}`,
                  `3. ${b3.slice(0, 20)}`,
                  `4. ${b4.slice(0, 20)}`,
                ],
                comicUrl: prevSec.comicUrl || "",
                comicStatus: prevSec.comicUrl
                  ? "ready"
                  : comicMode === "diagrams_only" || (comicMode === "first" && idx > 0)
                  ? "skipped"
                  : "pending",
                enriched: true,
              };
            });
          }
          ch.enriched = true;
        } catch (err) {
          console.warn(`[Book ${bookId}] Ch ${ch.num} enrichment error:`, err.message);
        }
      }
      completedSteps += 1;
      updateJob(`Structured ${cIdx + 1}/${chapters.length} chapters. Preparing Story Comics…`);
    }

    // PHASE 4: Generate 16:9 Widescreen Story Comics Sequentially
    for (let i = 0; i < plannedComics.length; i++) {
      // Reload latest book metadata in case annotations/other fields changed, keeping chapters reference synced
      const { cIdx, sIdx } = plannedComics[i];
      const ch = book.chapters[cIdx];
      const sec = ch?.sections?.[sIdx];
      if (!ch || !sec) {
        completedSteps += 1;
        continue;
      }

      if (sec.comicUrl && fs.existsSync(path.join(dir, "comics", `ch${ch.num}_sec${sec.num}.jpg`))) {
        sec.comicStatus = "ready";
        completedSteps += 1;
        continue;
      }

      sec.comicStatus = "generating";
      updateJob(
        `Illustrating Story Comic ${i + 1}/${plannedComics.length}: Ch. ${ch.num} · ${sec.roman} (${sec.title})…`
      );

      try {
        const outImg = path.join(dir, "comics", `ch${ch.num}_sec${sec.num}.jpg`);
        const prompt = buildStoryComicPrompt({
          bookTitle: book.title,
          author: book.author,
          chapterTitle: `${ch.chapterLabel}: ${ch.title}`,
          sectionTitle: sec.title,
          comicSpec: sec.comicSpec,
          takeaway: sec.takeaway,
        });

        await generateComicImageToFile(prompt, outImg);
        sec.comicUrl = `/api/books/${bookId}/comics/ch${ch.num}_sec${sec.num}.jpg?v=${Date.now()}`;
        sec.comicStatus = "ready";
      } catch (imgErr) {
        console.warn(`[Book ${bookId}] Comic ch${ch.num}_sec${sec.num} failed:`, imgErr.message);
        sec.comicStatus = "failed";
      }

      completedSteps += 1;
      updateJob(
        `Illustrated ${i + 1}/${plannedComics.length} Story Comics (${ch.chapterLabel} · Section ${sec.roman})`
      );
      if (i + 1 < plannedComics.length) {
        await sleep(1100);
      }
    }

    book.job = {
      ...book.job,
      status: "ready",
      readable: true,
      completedSteps: totalSteps,
      totalSteps,
      comicsDone: book.chapters.reduce(
        (acc, c) => acc + (c.sections || []).filter((s) => Boolean(s.comicUrl)).length,
        0
      ),
      comicsTotal: plannedComics.length,
      percent: 100,
      phase: "Complete — Full text, SVG concept diagrams & Story Comics ready.",
    };
    writeBook(book);
  } catch (err) {
    console.error(`[Book ${bookId}] Background job failed:`, err);
    const book = readBook(bookId);
    if (book) {
      book.job = {
        ...(book.job || {}),
        status: "error",
        phase: `Error: ${err.message || "Processing failed"}`,
      };
      writeBook(book);
    }
  } finally {
    activeBookJobs.delete(bookId);
  }
}

// Resume any interrupted jobs on server startup
setTimeout(() => {
  const lib = readLibrary();
  for (const item of lib.books) {
    if (item.job && item.job.status === "processing") {
      processBookInBackground(item.id, { comicMode: item.job.comicMode || "all" });
    }
  }
}, 800);

/* ==========================================================================
   Gemini 4 Neon Book-Aware Study Chat
   ========================================================================== */

async function generateBookStudyAnswer({
  book,
  chapterSlug,
  question,
  selectedHighlight,
  notes,
  history,
  modelOverride,
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in .env.");
  }

  const ch = (book.chapters || []).find((c) => c.slug === chapterSlug) || book.chapters?.[0];
  const chTitle = ch ? `${ch.chapterLabel} ("${ch.title}", pp. ${ch.folioStart}–${ch.folioEnd})` : chapterSlug;
  const chThemes = ch?.aiThemes || "";

  // Include relevant excerpt from the chapter prose (preserving inline https:// URLs) so Gemini 4 Neon has direct textual & link grounding
  const proseSample = (ch?.paragraphs || [])
    .slice(0, 32)
    .map((p) => stripTagsKeepUrls(p.html))
    .join("\n")
    .slice(0, 6500);

  const notesBlock =
    Array.isArray(notes) && notes.length > 0
      ? notes
          .map((n, idx) => {
            const parts = [`[${idx + 1}] (${n.locLabel || chTitle})`];
            if (n.quote) parts.push(`Highlighted text: "${n.quote}"`);
            if (n.note && n.note.trim()) parts.push(`Reader's note: ${n.note.trim()}`);
            return parts.join("\n");
          })
          .join("\n\n")
      : "No saved reader notes yet.";

  const activeHighlightBlock =
    selectedHighlight && selectedHighlight.quote
      ? `ACTIVE HIGHLIGHTED PASSAGE (${selectedHighlight.locLabel || chTitle}):\n"${selectedHighlight.quote}"${
          selectedHighlight.note && selectedHighlight.note.trim()
            ? `\nReader's note on this passage: "${selectedHighlight.note.trim()}"`
            : ""
        }`
      : `No single active passage selected (general question on ${chTitle}).`;

  const systemText = [
    `You are an insightful scholarly reading companion for ${chTitle} of "${book.title}${book.subtitle ? ": " + book.subtitle : ""}" by ${book.author}${book.sourceUrl ? ` (Source URL: ${book.sourceUrl})` : ""}.`,
    chThemes ? `Key chapter themes: ${chThemes}` : "",
    `You have live Google Search grounding enabled. Whenever the reader asks to find links, papers, proofs, repositories, citations, recent news, or external context beyond the chapter text, actively use Google Search to look them up and include direct clickable Markdown links ([Title](https://...)).`,
    `Engage directly with BOTH the active highlighted passage AND the reader's own margin notes below. Be clear, rigorous, and concise (2–4 short paragraphs or crisp bullet points as appropriate).`,
    `---`,
    activeHighlightBlock,
    `---`,
    `READER'S SAVED NOTES & HIGHLIGHTS IN THIS CHAPTER:\n${notesBlock}`,
    `---`,
    `CHAPTER TEXT REFERENCE EXCERPT (WITH INLINE LINKS):\n${proseSample}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const model = modelOverride || activeModel || DEFAULT_CHAT_MODEL;
  const contents = [];
  for (const h of (history || []).slice(-8)) {
    contents.push({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }],
    });
  }
  contents.push({ role: "user", parts: [{ text: question }] });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // Call with Google Search grounding enabled; fall back cleanly if a model ever rejects tools
  let res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemText }] },
      contents,
      tools: [{ googleSearch: {} }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 4096,
      },
    }),
  });

  if (!res.ok && res.status === 400) {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents,
        generationConfig: {
          temperature: 0.45,
          maxOutputTokens: 4096,
        },
      }),
    });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || `Gemini API error (HTTP ${res.status})`);
  }

  const candidate = data.candidates?.[0] || {};
  const parts = candidate.content?.parts || [];
  const text = parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();

  if (!text) throw new Error("Gemini returned an empty response.");

  // Extract deduplicated Google Search grounding sources & queries if used
  const gMeta = candidate.groundingMetadata || {};
  const searchQueries = Array.isArray(gMeta.webSearchQueries)
    ? gMeta.webSearchQueries.filter(Boolean).slice(0, 5)
    : [];
  const seenUris = new Set();
  const sources = [];
  for (const chObj of gMeta.groundingChunks || []) {
    const uri = chObj?.web?.uri;
    const title = chObj?.web?.title || uri;
    if (uri && !seenUris.has(uri)) {
      seenUris.add(uri);
      sources.push({ title: String(title).slice(0, 60), uri: String(uri) });
      if (sources.length >= 6) break;
    }
  }

  return {
    answer: text,
    modelId: data.modelVersion || model,
    modelLabel: getModelLabel(model),
    sources,
    searchQueries,
  };
}

/* ==========================================================================
   HTTP Server & REST Endpoints
   ========================================================================== */

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error("JSON payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function streamUploadToFile(req, destPath, maxBytes = 150 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const out = fs.createWriteStream(destPath);
    let bytes = 0;

    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        out.destroy();
        fs.unlink(destPath, () => {});
        reject(new Error("Uploaded file exceeds 150 MB limit."));
        req.destroy();
      }
    });

    req.pipe(out);
    out.on("finish", () => resolve(bytes));
    out.on("error", reject);
    req.on("error", reject);
  });
}

function normalizeBookSourceUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http:// and https:// links are supported.");
  }

  const host = parsed.hostname.toLowerCase();
  // 1. arXiv abstract -> direct PDF
  const arxivMatch = parsed.pathname.match(/^\/abs\/([0-9]+\.[0-9]+(?:v\d+)?|[a-z-]+\/[0-9]+)$/i);
  if ((host === "arxiv.org" || host.endsWith(".arxiv.org")) && arxivMatch) {
    return `https://arxiv.org/pdf/${arxivMatch[1]}.pdf`;
  }

  // 2. Project Gutenberg book landing page -> EPUB3 download
  const gutenbergMatch = parsed.pathname.match(/^\/ebooks\/(\d+)\/?$/i);
  if ((host === "gutenberg.org" || host === "www.gutenberg.org") && gutenbergMatch) {
    return `https://www.gutenberg.org/ebooks/${gutenbergMatch[1]}.epub3.images`;
  }

  // 3. Google Drive share link -> direct download
  const driveMatch = parsed.pathname.match(/^\/file\/d\/([^/]+)/);
  if (host === "drive.google.com" && driveMatch) {
    return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
  }

  // 4. Dropbox share link -> direct download
  if (host.endsWith("dropbox.com") && parsed.searchParams.get("dl") === "0") {
    parsed.searchParams.set("dl", "1");
    return parsed.toString();
  }

  return parsed.toString();
}

async function downloadRemoteBook(rawUrl, destDir, maxBytes = 150 * 1024 * 1024) {
  const fetchUrl = normalizeBookSourceUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const resp = await fetch(fetchUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) BookVizStudio/1.0",
        Accept:
          "application/epub+zip,application/pdf,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8",
      },
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`Remote link returned HTTP ${resp.status}`);
    }

    fs.mkdirSync(destDir, { recursive: true });
    const tmpPath = path.join(destDir, "download.tmp");
    const out = fs.createWriteStream(tmpPath);

    let totalBytes = 0;
    let headBuf = Buffer.alloc(0);

    for await (const chunk of resp.body) {
      const buf = Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        out.destroy();
        fs.unlink(tmpPath, () => {});
        throw new Error("Remote file exceeds 150 MB limit.");
      }
      if (headBuf.length < 512) {
        headBuf = Buffer.concat([headBuf, buf.subarray(0, 512 - headBuf.length)]);
      }
      out.write(buf);
    }

    await new Promise((resolve, reject) => {
      out.end(() => resolve());
      out.on("error", reject);
    });

    if (totalBytes < 64) {
      fs.unlinkSync(tmpPath);
      throw new Error("Downloaded file from link is empty.");
    }

    const contentType = String(resp.headers.get("content-type") || "").toLowerCase();
    const contentDisp = String(resp.headers.get("content-disposition") || "");
    const finalUrlPath = new URL(resp.url || fetchUrl).pathname;

    // Detect actual format via magic bytes first, then headers & URL extension
    let ext = "";
    const headAscii = headBuf.subarray(0, 16).toString("latin1");
    const headUtf8 = headBuf.toString("utf8").trimStart().toLowerCase();

    if (headAscii.startsWith("%PDF-")) {
      ext = ".pdf";
    } else if (headBuf[0] === 0x50 && headBuf[1] === 0x4b) {
      ext = ".epub";
    } else if (contentType.includes("application/pdf") || finalUrlPath.toLowerCase().endsWith(".pdf")) {
      ext = ".pdf";
    } else if (
      contentType.includes("epub") ||
      finalUrlPath.toLowerCase().endsWith(".epub") ||
      finalUrlPath.toLowerCase().includes(".epub")
    ) {
      ext = ".epub";
    } else if (
      contentType.includes("text/html") ||
      contentType.includes("xhtml") ||
      headUtf8.startsWith("<!doctype html") ||
      headUtf8.startsWith("<html") ||
      headUtf8.startsWith("<?xml")
    ) {
      ext = ".html";
    } else {
      fs.unlinkSync(tmpPath);
      throw new Error(
        `Unsupported link content (${contentType || "binary"}). Paste a link to an EPUB, PDF, Gutenberg book, arXiv paper, or readable web page.`
      );
    }

    // Derive clean filename/title hint
    let rawFilename = "";
    const cdMatch = contentDisp.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
    if (cdMatch) rawFilename = decodeURIComponent(cdMatch[1]);
    if (!rawFilename) {
      rawFilename = decodeURIComponent(path.basename(finalUrlPath)) || "linked_book";
    }

    const sourcePath = path.join(destDir, `source${ext}`);
    fs.renameSync(tmpPath, sourcePath);

    const guessTitle = rawFilename
      .replace(/\.(epub3\.images|epub|pdf|xhtml|html|htm)$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      ext,
      sourcePath,
      originalFilename: rawFilename,
      guessTitle: guessTitle && !/^\d+$/.test(guessTitle) ? guessTitle : "Imported Link Edition",
    };
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  try {
    // 1. Global AI & Library Status
    if (pathname === "/api/status" && req.method === "GET") {
      const lib = readLibrary();
      return sendJSON(res, 200, {
        aiConnected: Boolean(process.env.GEMINI_API_KEY),
        activeModel,
        activeModelLabel: getModelLabel(activeModel),
        models: ALLOWED_MODELS,
        bookCount: lib.books.length,
      });
    }

    if (pathname === "/api/model" && req.method === "POST") {
      const body = await readJsonBody(req);
      const requested = String(body.model || "").trim();
      if (!ALLOWED_MODELS.some((m) => m.id === requested)) {
        return sendJSON(res, 400, { error: "Unsupported model selection." });
      }
      activeModel = requested;
      return sendJSON(res, 200, {
        ok: true,
        activeModel,
        activeModelLabel: getModelLabel(activeModel),
      });
    }

    // 2. List All Stored Books in Website Library
    if (pathname === "/api/books" && req.method === "GET") {
      const lib = readLibrary();
      return sendJSON(res, 200, { books: lib.books });
    }

    // 3. Upload EPUB or PDF Book -> Start Background Processing
    if (pathname === "/api/books/upload" && req.method === "POST") {
      const rawName = decodeURIComponent(
        String(req.headers["x-filename"] || parsedUrl.searchParams.get("filename") || "book.epub")
      );
      const ext = path.extname(rawName).toLowerCase();
      if (ext !== ".epub" && ext !== ".pdf") {
        return sendJSON(res, 400, {
          error: "Unsupported file format. Please upload an .epub or .pdf file.",
        });
      }

      const comicMode = String(
        req.headers["x-comic-mode"] || parsedUrl.searchParams.get("comicMode") || "all"
      );

      const bookId = `book_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const dir = bookDir(bookId);
      const sourcePath = path.join(dir, `source${ext}`);
      const sizeBytes = await streamUploadToFile(req, sourcePath);

      if (sizeBytes < 64) {
        fs.rmSync(dir, { recursive: true, force: true });
        return sendJSON(res, 400, { error: "Uploaded file is empty." });
      }

      const guessTitle = path
        .basename(rawName, ext)
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      const now = Date.now();
      const initialBook = {
        id: bookId,
        title: guessTitle || "Uploaded Book",
        subtitle: "",
        author: "Extracting…",
        publisherMeta: `${ext.slice(1).toUpperCase()} EDITION`,
        pubDate: "",
        balanceDue: "PROCESSING",
        tagline: "“EXTRACTING ACTUAL CHAPTER PROSE…”",
        sourceFormat: ext.slice(1),
        originalFilename: path.basename(rawName),
        sourcePath,
        totalPages: 0,
        wordCount: 0,
        createdAt: now,
        updatedAt: now,
        job: {
          status: "processing",
          readable: false,
          comicMode,
          percent: 3,
          phase: "Queued for chapter extraction & Gemini visual enrichment…",
        },
        chapters: [],
      };

      writeBook(initialBook);
      writeBookState(bookId, { chapters: {} });

      // Launch background processing asynchronously
      setImmediate(() => {
        processBookInBackground(bookId, { comicMode });
      });

      return sendJSON(res, 202, {
        ok: true,
        bookId,
        book: initialBook,
      });
    }

    // 3b. Import Book by URL (Direct .epub / .pdf, Gutenberg, arXiv, Drive, or Web Text)
    if (pathname === "/api/books/import-url" && req.method === "POST") {
      const body = await readJsonBody(req);
      const rawUrl = String(body.url || "").trim();
      const comicMode = String(body.comicMode || "all");
      if (!rawUrl) {
        return sendJSON(res, 400, { error: "Please paste a valid http:// or https:// link." });
      }

      const bookId = `book_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const dir = bookDir(bookId);

      try {
        const dl = await downloadRemoteBook(rawUrl, dir);
        const fmtLabel = dl.ext === ".html" ? "web" : dl.ext.slice(1);
        const now = Date.now();
        const initialBook = {
          id: bookId,
          title: dl.guessTitle,
          subtitle: "",
          author: "Extracting…",
          publisherMeta: `${fmtLabel.toUpperCase()} EDITION`,
          pubDate: "",
          balanceDue: "PROCESSING",
          tagline: "“EXTRACTING ACTUAL CHAPTER PROSE…”",
          sourceFormat: fmtLabel,
          sourceUrl: rawUrl,
          originalFilename: dl.originalFilename,
          sourcePath: dl.sourcePath,
          totalPages: 0,
          wordCount: 0,
          createdAt: now,
          updatedAt: now,
          job: {
            status: "processing",
            readable: false,
            comicMode,
            percent: 4,
            phase: "Downloaded from link — extracting chapters & launching Gemini enrichment…",
          },
          chapters: [],
        };

        writeBook(initialBook);
        writeBookState(bookId, { chapters: {} });

        setImmediate(() => {
          processBookInBackground(bookId, { comicMode });
        });

        return sendJSON(res, 202, {
          ok: true,
          bookId,
          book: initialBook,
        });
      } catch (dlErr) {
        fs.rmSync(dir, { recursive: true, force: true });
        return sendJSON(res, 400, { error: dlErr.message || "Failed to fetch book from URL." });
      }
    }

    // 4. Book-Scoped Endpoints: /api/books/:bookId/...
    const bookMatch = pathname.match(/^\/api\/books\/(book_[a-z0-9_]+)(?:\/(.*))?$/);
    if (bookMatch) {
      const bookId = sanitizeBookId(bookMatch[1]);
      const subroute = bookMatch[2] || "";
      if (!bookId) return sendJSON(res, 400, { error: "Invalid book ID" });

      // GET /api/books/:id -> Full book JSON
      if (!subroute && req.method === "GET") {
        const book = readBook(bookId);
        if (!book) return sendJSON(res, 404, { error: "Book not found" });
        const safeBook = { ...book };
        delete safeBook.sourcePath;
        return sendJSON(res, 200, safeBook);
      }

      // DELETE /api/books/:id -> Delete book from library
      if (!subroute && req.method === "DELETE") {
        const lib = readLibrary();
        lib.books = lib.books.filter((b) => b.id !== bookId);
        writeLibrary(lib);
        fs.rmSync(bookDir(bookId), { recursive: true, force: true });
        return sendJSON(res, 200, { ok: true, deleted: bookId });
      }

      // GET /api/books/:id/progress -> Lightweight background job poll + section visual diffs
      if (subroute === "progress" && req.method === "GET") {
        const book = readBook(bookId);
        if (!book) return sendJSON(res, 404, { error: "Book not found" });
        return sendJSON(res, 200, {
          id: book.id,
          title: book.title,
          subtitle: book.subtitle,
          author: book.author,
          publisherMeta: book.publisherMeta,
          pubDate: book.pubDate,
          balanceDue: book.balanceDue,
          tagline: book.tagline,
          chapterCount: (book.chapters || []).length,
          wordCount: book.wordCount || 0,
          updatedAt: book.updatedAt,
          job: book.job,
          chapterVisuals: (book.chapters || []).map((c) => ({
            slug: c.slug,
            title: c.title,
            shortTitle: c.shortTitle,
            receiptTagline: c.receiptTagline,
            enriched: Boolean(c.enriched),
            sections: (c.sections || []).map((s) => ({
              id: s.id,
              title: s.title,
              subtitle: s.subtitle,
              takeawayLead: s.takeawayLead,
              takeaway: s.takeaway,
              quote: s.quote,
              diagram: s.diagram,
              beats: s.beats,
              comicUrl: s.comicUrl,
              comicStatus: s.comicStatus,
              enriched: Boolean(s.enriched),
            })),
          })),
        });
      }

      // POST /api/books/:id/generate-comic -> On-demand single section comic generation
      if (subroute === "generate-comic" && req.method === "POST") {
        const body = await readJsonBody(req);
        const book = readBook(bookId);
        if (!book) return sendJSON(res, 404, { error: "Book not found" });

        const ch = (book.chapters || []).find((c) => c.slug === body.chapter);
        const sec = (ch?.sections || []).find((s) => s.id === body.sectionId);
        if (!ch || !sec) return sendJSON(res, 404, { error: "Section not found" });

        const outImg = path.join(bookDir(bookId), "comics", `ch${ch.num}_sec${sec.num}.jpg`);
        const prompt = buildStoryComicPrompt({
          bookTitle: book.title,
          author: book.author,
          chapterTitle: `${ch.chapterLabel}: ${ch.title}`,
          sectionTitle: sec.title,
          comicSpec: sec.comicSpec,
          takeaway: sec.takeaway,
        });

        await generateComicImageToFile(prompt, outImg);
        sec.comicUrl = `/api/books/${bookId}/comics/ch${ch.num}_sec${sec.num}.jpg?v=${Date.now()}`;
        sec.comicStatus = "ready";
        writeBook(book);

        return sendJSON(res, 200, { ok: true, comicUrl: sec.comicUrl, sectionId: sec.id });
      }

      // POST /api/books/:id/retry -> Resume/retry background enrichment
      if (subroute === "retry" && req.method === "POST") {
        const body = await readJsonBody(req);
        const book = readBook(bookId);
        if (!book) return sendJSON(res, 404, { error: "Book not found" });
        setImmediate(() => {
          processBookInBackground(bookId, { comicMode: body.comicMode || book.job?.comicMode || "all" });
        });
        return sendJSON(res, 202, { ok: true });
      }

      // GET /api/books/:id/comics/:filename -> Serve generated comic image
      const comicMatch = subroute.match(/^comics\/([a-zA-Z0-9_.-]+\.(?:jpg|jpeg|png|webp))$/);
      if (comicMatch && req.method === "GET") {
        const imgPath = path.join(bookDir(bookId), "comics", comicMatch[1]);
        if (!fs.existsSync(imgPath)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          return res.end("Comic not found");
        }
        const ext = path.extname(imgPath).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME_TYPES[ext] || "image/jpeg",
          "Cache-Control": "public, max-age=86400",
        });
        return fs.createReadStream(imgPath).pipe(res);
      }

      // GET /api/books/:id/state -> Annotations & AI chat state for this book
      if (subroute === "state" && req.method === "GET") {
        const state = readBookState(bookId);
        return sendJSON(res, 200, {
          bookId,
          chapters: state.chapters || {},
          activeModel,
          activeModelLabel: getModelLabel(activeModel),
        });
      }

      // POST /api/books/:id/annotations/sync
      if (subroute === "annotations/sync" && req.method === "POST") {
        const body = await readJsonBody(req);
        const ch = normalizeChapterSlug(body.chapter);
        const list = Array.isArray(body.annotations) ? body.annotations : [];
        const state = readBookState(bookId);
        if (!state.chapters[ch]) state.chapters[ch] = { annotations: [], chatMessages: [] };
        state.chapters[ch].annotations = list;
        writeBookState(bookId, state);
        return sendJSON(res, 200, { ok: true, chapter: ch, count: list.length });
      }

      // POST /api/books/:id/chat/sync -> Persist merged client/offline chat history on server
      if (subroute === "chat/sync" && req.method === "POST") {
        const body = await readJsonBody(req);
        const ch = normalizeChapterSlug(body.chapter);
        const incoming = Array.isArray(body.chatMessages) ? body.chatMessages : [];
        const state = readBookState(bookId);
        if (!state.chapters[ch]) state.chapters[ch] = { annotations: [], chatMessages: [] };

        const byId = new Map();
        for (const m of state.chapters[ch].chatMessages || []) {
          if (m && m.id) byId.set(m.id, m);
        }
        for (const m of incoming) {
          if (m && m.id) byId.set(m.id, m);
        }
        const merged = Array.from(byId.values()).sort(
          (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
        );
        state.chapters[ch].chatMessages = merged;
        writeBookState(bookId, state);
        return sendJSON(res, 200, { ok: true, chapter: ch, chatMessages: merged });
      }

      // POST /api/books/:id/endnotes -> Add, update, or delete chapter endnotes (anchored or standalone)
      if (subroute === "endnotes" && req.method === "POST") {
        const body = await readJsonBody(req);
        const book = readBook(bookId);
        if (!book) return sendJSON(res, 404, { error: "Book not found" });

        const chSlug = normalizeChapterSlug(body.chapter);
        const ch = (book.chapters || []).find((c) => c.slug === chSlug);
        if (!ch) return sendJSON(res, 404, { error: "Chapter not found" });

        ensureChapterEndnoteUids(ch);
        const action = String(body.action || "add");

        if (action === "add") {
          const uid = `en_u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          const rawText = String(body.text || "").trim();
          const htmlBody = rawText ? markdownToEndnoteHtml(rawText) : "";
          const paraIdx =
            typeof body.paraIndex === "number" &&
            body.paraIndex >= 0 &&
            body.paraIndex < (ch.paragraphs || []).length
              ? body.paraIndex
              : null;

          let anchored = false;
          let notePage = Number(body.page) || ch.folioStart || 1;

          if (paraIdx !== null && typeof body.paraEndOffset === "number" && body.paraEndOffset > 0) {
            const targetPara = ch.paragraphs[paraIdx];
            targetPara.html = insertSuperscriptInParagraphHtml(
              targetPara.html,
              body.paraEndOffset,
              uid,
              ch.num
            );
            notePage = targetPara.page || notePage;
            anchored = true;
          } else if (body.anchorQuote) {
            // Fallback quote match if added from a saved chat message without exact DOM offset
            const needle = String(body.anchorQuote).trim();
            if (needle.length >= 3) {
              for (const p of ch.paragraphs || []) {
                const plain = stripTags(p.html);
                const pos = plain.indexOf(needle);
                if (pos >= 0) {
                  p.html = insertSuperscriptInParagraphHtml(
                    p.html,
                    pos + needle.length,
                    uid,
                    ch.num
                  );
                  notePage = p.page || notePage;
                  anchored = true;
                  break;
                }
              }
            }
          }

          if (!Array.isArray(ch.endnotes)) ch.endnotes = [];
          ch.endnotes.push({
            uid,
            num: ch.endnotes.length + 1,
            html: htmlBody,
            rawText,
            page: notePage,
            anchored,
            userAdded: true,
          });

          renumberChapterEndnotes(ch);
          writeBook(book);

          const created = ch.endnotes.find((n) => n.uid === uid);
          return sendJSON(res, 200, {
            ok: true,
            chapter: ch,
            createdUid: uid,
            createdNum: created ? created.num : ch.endnotes.length,
          });
        }

        if (action === "update") {
          const target = (ch.endnotes || []).find(
            (n) => (body.uid && n.uid === body.uid) || (body.num && n.num === Number(body.num))
          );
          if (!target) return sendJSON(res, 404, { error: "Endnote not found" });
          const rawText = String(body.text ?? "").trim();
          target.rawText = rawText;
          target.html = markdownToEndnoteHtml(rawText);
          writeBook(book);
          return sendJSON(res, 200, { ok: true, chapter: ch, updatedNum: target.num });
        }

        if (action === "delete") {
          const target = (ch.endnotes || []).find(
            (n) => (body.uid && n.uid === body.uid) || (body.num && n.num === Number(body.num))
          );
          if (!target) return sendJSON(res, 404, { error: "Endnote not found" });
          const delUid = target.uid;

          (ch.paragraphs || []).forEach((p) => {
            p.html = String(p.html || "").replace(
              new RegExp(
                `<sup class="note-ref"\\s+data-note-uid="${delUid}"[^>]*>[\\s\\S]*?<\\/sup>`,
                "gi"
              ),
              ""
            );
          });
          ch.endnotes = (ch.endnotes || []).filter((n) => n.uid !== delUid);
          renumberChapterEndnotes(ch);
          writeBook(book);
          return sendJSON(res, 200, { ok: true, chapter: ch });
        }

        return sendJSON(res, 400, { error: "Unsupported endnotes action" });
      }

      // POST /api/books/:id/chat -> Gemini 4 Neon study companion
      if (subroute === "chat" && req.method === "POST") {
        const body = await readJsonBody(req);
        const book = readBook(bookId);
        if (!book) return sendJSON(res, 404, { error: "Book not found" });

        const ch = normalizeChapterSlug(body.chapter);
        const question = String(body.question || "").trim();
        if (!question) return sendJSON(res, 400, { error: "Question is required." });

        const selectedHighlight = body.selectedHighlight || null;
        const notes = Array.isArray(body.notes) ? body.notes : [];
        const requestedModel = body.model ? String(body.model).trim() : activeModel;

        const state = readBookState(bookId);
        if (!state.chapters[ch]) state.chapters[ch] = { annotations: [], chatMessages: [] };
        const history = state.chapters[ch].chatMessages || [];
        const now = Date.now();

        const userMsg = {
          id: `msg_u_${now}_${Math.random().toString(36).slice(2, 6)}`,
          role: "user",
          content: question,
          highlightQuote: (selectedHighlight && selectedHighlight.quote) || "",
          highlightLoc: (selectedHighlight && selectedHighlight.locLabel) || "",
          notesCount: notes.length,
          createdAt: now,
        };

        const { answer, modelLabel, sources, searchQueries } = await generateBookStudyAnswer({
          book,
          chapterSlug: ch,
          question,
          selectedHighlight,
          notes,
          history,
          modelOverride: requestedModel,
        });

        const assistantMsg = {
          id: `msg_a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          role: "assistant",
          content: answer,
          highlightQuote: "",
          highlightLoc: modelLabel,
          notesCount: 0,
          sources: sources || [],
          searchQueries: searchQueries || [],
          createdAt: Date.now(),
        };

        state.chapters[ch].chatMessages = [...history, userMsg, assistantMsg];
        writeBookState(bookId, state);

        return sendJSON(res, 200, {
          ok: true,
          chapter: ch,
          userMessage: userMsg,
          assistantMessage: assistantMsg,
        });
      }

      // DELETE /api/books/:id/chat?chapter=chapter-1
      if (subroute === "chat" && req.method === "DELETE") {
        const ch = normalizeChapterSlug(parsedUrl.searchParams.get("chapter"));
        const state = readBookState(bookId);
        if (state.chapters[ch]) state.chapters[ch].chatMessages = [];
        writeBookState(bookId, state);
        return sendJSON(res, 200, { ok: true, chapter: ch });
      }
    }

    // 5. Serve Static Frontend Files from ./public
    let relPath = pathname === "/" ? "/index.html" : pathname;
    const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
    const fullPath = path.join(PUBLIC_DIR, safePath);

    if (!fullPath.startsWith(PUBLIC_DIR) || safePath.startsWith("/.")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }

    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      return fs.createReadStream(fullPath).pipe(res);
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error("[Server Error]", err);
    sendJSON(res, 500, { error: err.message || "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `Imprint running at http://${HOST}:${PORT}/ (Chat Model: ${getModelLabel(
      activeModel
    )} [${activeModel}], API Key: ${process.env.GEMINI_API_KEY ? "connected" : "missing"})`
  );
});
