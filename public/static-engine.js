/**
 * Imprint — Serverless Browser Engine for GitHub Pages / Static Hosting
 *
 * Automatically activates ONLY when no Node backend (`/api/status`) is reachable
 * (such as when hosted statically on GitHub Pages).
 *
 * Provides full parity in the browser:
 *  - Client-side .epub extraction (via JSZip + DOMParser)
 *  - Client-side .pdf extraction (via Mozilla pdf.js + outline/folio detection)
 *  - Client-side URL / blog / article Readability extraction
 *  - Background Gemini enrichment (masthead, sections, 3-step SVG diagrams, and
 *    16:9 `gemini-3.1-flash-image` Story Comics compressed via <canvas> into IndexedDB)
 *  - Gemini 4 Neon + live Google Search (`googleSearch`) study chat & Endnotes CRUD
 *  - Bring-Your-Own-Key (`GEMINI_API_KEY`) stored strictly in the visitor's localStorage
 */
(function () {
  "use strict";

  const API_KEY_STORAGE = "imprint_browser_gemini_key_v1";
  const MODEL_STORAGE = "imprint_browser_model_v1";
  const STATIC_DB_NAME = "ImprintStaticServerDB";
  const STATIC_DB_VER = 1;

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
  const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
  const NUM_WORDS = [
    "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty",
  ];

  const nativeFetch = window.fetch.bind(window);
  let modeResolved = false;
  let staticMode = false;
  let modePromise = null;

  function getApiKey() {
    try {
      return (localStorage.getItem(API_KEY_STORAGE) || "").trim();
    } catch (_) {
      return "";
    }
  }

  function setApiKey(val) {
    try {
      const clean = String(val || "").trim();
      if (clean) localStorage.setItem(API_KEY_STORAGE, clean);
      else localStorage.removeItem(API_KEY_STORAGE);
    } catch (_) {}
  }

  function getActiveModel() {
    try {
      return localStorage.getItem(MODEL_STORAGE) || "gemini-4-neon";
    } catch (_) {
      return "gemini-4-neon";
    }
  }

  function setActiveModel(m) {
    try {
      localStorage.setItem(MODEL_STORAGE, m);
    } catch (_) {}
  }

  function getModelLabel(id) {
    return ALLOWED_MODELS.find((m) => m.id === id)?.label || id;
  }

  /* ========================================================================
     IndexedDB Persistence for Serverless Books & States
     ======================================================================== */
  function openStaticDB() {
    return new Promise((resolve) => {
      if (!("indexedDB" in window)) return resolve(null);
      const req = indexedDB.open(STATIC_DB_NAME, STATIC_DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
        if (!db.objectStoreNames.contains("states")) db.createObjectStore("states", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  async function dbGetAllBooks() {
    const db = await openStaticDB();
    if (!db) return [];
    return new Promise((resolve) => {
      const req = db.transaction("books", "readonly").objectStore("books").getAll();
      req.onsuccess = () => {
        const list = Array.isArray(req.result) ? req.result : [];
        list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        resolve(list);
      };
      req.onerror = () => resolve([]);
    });
  }

  async function dbGetBook(id) {
    const db = await openStaticDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const req = db.transaction("books", "readonly").objectStore("books").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async function dbPutBook(book) {
    const db = await openStaticDB();
    if (!db) return;
    book.updatedAt = Date.now();
    return new Promise((resolve) => {
      const tx = db.transaction("books", "readwrite");
      tx.objectStore("books").put(book);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  async function dbDeleteBook(id) {
    const db = await openStaticDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(["books", "states"], "readwrite");
      tx.objectStore("books").delete(id);
      tx.objectStore("states").delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  async function dbGetState(bookId) {
    const db = await openStaticDB();
    if (!db) return { id: bookId, chapters: {} };
    return new Promise((resolve) => {
      const req = db.transaction("states", "readonly").objectStore("states").get(bookId);
      req.onsuccess = () => resolve(req.result || { id: bookId, chapters: {} });
      req.onerror = () => resolve({ id: bookId, chapters: {} });
    });
  }

  async function dbPutState(bookId, stateObj) {
    const db = await openStaticDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction("states", "readwrite");
      tx.objectStore("states").put({ ...stateObj, id: bookId });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  /* ========================================================================
     Dynamic CDN Loaders (JSZip & pdf.js Loaded On-Demand Only in Static Mode)
     ======================================================================== */
  const loadedScripts = {};
  function loadExternalScript(url) {
    if (loadedScripts[url]) return loadedScripts[url];
    loadedScripts[url] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.crossOrigin = "anonymous";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.head.appendChild(s);
    });
    return loadedScripts[url];
  }

  async function ensureJSZip() {
    if (!window.JSZip) {
      await loadExternalScript("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js");
    }
    return window.JSZip;
  }

  async function ensurePdfJs() {
    if (!window.pdfjsLib) {
      await loadExternalScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }
    return window.pdfjsLib;
  }

  /* ========================================================================
     Client-Side EPUB, PDF & Web Link Extractors
     ======================================================================== */
  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function stripTags(h) {
    const tmp = document.createElement("div");
    tmp.innerHTML = String(h || "")
      .replace(/<span class="folio-marker"[^>]*>[\s\S]*?<\/span>/gi, " ")
      .replace(/<sup class="note-ref"[^>]*>[\s\S]*?<\/sup>/gi, " ");
    return (tmp.textContent || "").replace(/\s+/g, " ").trim();
  }

  function stripTagsKeepUrls(h) {
    return stripTags(
      String(h || "").replace(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    );
  }

  function countWords(h) {
    const t = stripTags(h);
    return t ? t.split(/\s+/).length : 0;
  }

  function chapterWordLabel(n) {
    return n >= 1 && n <= NUM_WORDS.length ? `Chapter ${NUM_WORDS[n - 1]}` : `Chapter ${n}`;
  }

  function makeShortTitle(title, fallback) {
    const clean = String(title || "")
      .replace(/^(chapter|part|section)\s+([0-9ivxlcdm]+|[a-z-]+)\s*[:.\-–—]?\s*/i, "")
      .trim() || fallback;
    const w = clean.split(/\s+/);
    return w.length > 5 ? w.slice(0, 5).join(" ") + "…" : clean;
  }

  function serializeCleanInline(node, baseUrl) {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "svg", "nav"].includes(tag)) return "";
    if (tag === "br") return " ";
    const inner = Array.from(node.childNodes)
      .map((n) => serializeCleanInline(n, baseUrl))
      .join("");
    if (tag === "em" || tag === "i") return `<em>${inner}</em>`;
    if (tag === "strong" || tag === "b") return `<strong>${inner}</em>`.replace("</em>", "</strong>");
    if (tag === "sub" || tag === "sup" || tag === "code") return `<${tag}>${inner}</${tag}>`;
    if (tag === "a") {
      const rawHref = (node.getAttribute("href") || "").trim();
      if (rawHref && !rawHref.startsWith("#") && !/^javascript:/i.test(rawHref)) {
        try {
          const resolved = baseUrl ? new URL(rawHref, baseUrl).href : rawHref;
          if (/^https?:\/\//i.test(resolved)) {
            return `<a href="${escapeHtml(resolved)}" target="_blank" rel="noopener noreferrer" class="prose-link">${inner}</a>`;
          }
        } catch (_) {}
      }
    }
    return inner;
  }

  function extractBlocksFromDOM(containerEl, baseUrl) {
    const blocks = [];
    let firstHeading = "";

    function walk(el) {
      for (const child of Array.from(el.children || [])) {
        const tag = child.tagName.toLowerCase();
        if (["script", "style", "nav", "aside", "footer", "form", "svg"].includes(tag)) continue;
        if (/^h[1-4]$/.test(tag)) {
          const txt = (child.textContent || "").replace(/\s+/g, " ").trim();
          if (!txt) continue;
          if (!firstHeading && (tag === "h1" || tag === "h2")) {
            firstHeading = txt;
          } else {
            blocks.push({ type: "subhead", html: escapeHtml(txt) });
          }
        } else if (tag === "blockquote") {
          const html = serializeCleanInline(child, baseUrl).replace(/\s+/g, " ").trim();
          if (stripTags(html)) blocks.push({ type: "blockquote", html });
        } else if (tag === "p" || tag === "li") {
          const html = serializeCleanInline(child, baseUrl).replace(/\s+/g, " ").trim();
          if (stripTags(html)) blocks.push({ type: "p", html });
        } else {
          walk(child);
        }
      }
    }

    walk(containerEl);
    return { firstHeading, blocks };
  }

  function resolveRelPath(baseFile, relHref) {
    const cleanHref = decodeURIComponent(String(relHref || "").split("#")[0]);
    if (!cleanHref) return baseFile;
    const baseParts = baseFile.split("/").slice(0, -1);
    for (const seg of cleanHref.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") baseParts.pop();
      else baseParts.push(seg);
    }
    return baseParts.join("/");
  }

  async function extractEpubInBrowser(arrayBuffer, filename) {
    const JSZip = await ensureJSZip();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const parser = new DOMParser();

    const containerXml = await zip.file("META-INF/container.xml")?.async("string");
    if (!containerXml) throw new Error("Invalid EPUB: missing META-INF/container.xml");
    const cDoc = parser.parseFromString(containerXml, "application/xml");
    const opfPath = cDoc.querySelector("rootfile")?.getAttribute("full-path");
    if (!opfPath || !zip.file(opfPath)) throw new Error("Invalid EPUB: missing OPF package");

    const opfXml = await zip.file(opfPath).async("string");
    const opfDoc = parser.parseFromString(opfXml, "application/xml");

    const titleRaw = (opfDoc.getElementsByTagNameNS("*", "title")[0]?.textContent || filename.replace(/\.epub$/i, "")).trim();
    const author = (opfDoc.getElementsByTagNameNS("*", "creator")[0]?.textContent || "Unknown Author").trim();
    const publisher = (opfDoc.getElementsByTagNameNS("*", "publisher")[0]?.textContent || "EPUB EDITION").trim();
    const pubDate = (opfDoc.getElementsByTagNameNS("*", "date")[0]?.textContent || "").trim().slice(0, 10);

    const manifest = {};
    Array.from(opfDoc.getElementsByTagNameNS("*", "item")).forEach((it) => {
      const id = it.getAttribute("id");
      const href = it.getAttribute("href");
      if (id && href) {
        manifest[id] = {
          path: resolveRelPath(opfPath, href),
          type: it.getAttribute("media-type") || "",
          props: it.getAttribute("properties") || "",
        };
      }
    });

    // Map TOC labels
    const tocMap = {};
    for (const info of Object.values(manifest)) {
      if (info.props.includes("nav") || info.path.endsWith(".ncx")) {
        const rawToc = await zip.file(info.path)?.async("string");
        if (!rawToc) continue;
        const tDoc = parser.parseFromString(rawToc, "text/html");
        tDoc.querySelectorAll("a[href]").forEach((a) => {
          const p = resolveRelPath(info.path, a.getAttribute("href"));
          const lbl = (a.textContent || "").replace(/\s+/g, " ").trim();
          if (p && lbl && !tocMap[p]) tocMap[p] = lbl;
        });
        tDoc.querySelectorAll("navPoint").forEach((np) => {
          const src = np.querySelector("content")?.getAttribute("src");
          const lbl = (np.querySelector("navLabel text")?.textContent || "").trim();
          if (src && lbl) {
            const p = resolveRelPath(info.path, src);
            if (!tocMap[p]) tocMap[p] = lbl;
          }
        });
      }
    }

    const skipRe = /^(cover|title\s*page|copyright|contents|table\s+of\s+contents|acknowledg|index|colophon)\b/i;
    const spineRefs = Array.from(opfDoc.getElementsByTagNameNS("*", "itemref"));
    const rawChapters = [];

    for (const ref of spineRefs) {
      const info = manifest[ref.getAttribute("idref")];
      if (!info || !zip.file(info.path)) continue;
      const xhtml = await zip.file(info.path).async("string");
      const doc = parser.parseFromString(xhtml, "text/html");
      const { firstHeading, blocks } = extractBlocksFromDOM(doc.body || doc.documentElement);
      const wc = blocks.reduce((s, b) => s + countWords(b.html), 0);
      if (wc === 0) continue;
      const label = tocMap[info.path] || firstHeading || "";
      if (label && skipRe.test(label) && wc < 800) continue;

      if (rawChapters.length > 0 && !tocMap[info.path] && (!firstHeading || wc < 200)) {
        rawChapters[rawChapters.length - 1].blocks.push(...blocks);
      } else {
        rawChapters.push({ title: label || `Chapter ${rawChapters.length + 1}`, blocks });
      }
    }

    let page = 1;
    const chapters = rawChapters
      .filter((c) => c.blocks.reduce((s, b) => s + countWords(b.html), 0) >= 40)
      .map((c, idx) => {
        const chNum = idx + 1;
        const startPage = page;
        let wordsOnPage = 0;
        const paragraphs = c.blocks.map((b, bIdx) => {
          let html = b.html;
          const w = countWords(html);
          wordsOnPage += w;
          if (bIdx === 0 || wordsOnPage >= 310) {
            if (bIdx > 0) {
              page += Math.max(1, Math.floor(wordsOnPage / 310));
              wordsOnPage %= 310;
            }
            if (b.type === "p") {
              html = `<span class="folio-marker" data-page="${page}" title="Page ${page}">p. ${page}</span>${html}`;
            }
          }
          return { type: b.type, html, page };
        });
        const endPage = Math.max(startPage, page);
        page = endPage + 1;
        const chLabel = chapterWordLabel(chNum);
        return {
          slug: `chapter-${chNum}`,
          num: chNum,
          chapterLabel: chLabel,
          title: c.title,
          shortTitle: makeShortTitle(c.title, chLabel),
          folioStart: startPage,
          folioEnd: endPage,
          wordCount: paragraphs.reduce((s, p) => s + countWords(p.html), 0),
          paragraphs,
          endnotes: [],
        };
      });

    if (!chapters.length) throw new Error("No readable chapters found in EPUB.");
    let title = titleRaw;
    let subtitle = "";
    if (title.includes(":")) {
      const [t, sub] = title.split(":", 2);
      title = t.trim();
      subtitle = sub.trim();
    }

    return {
      sourceFormat: "epub",
      title,
      subtitle,
      author,
      publisherMeta: publisher.toUpperCase(),
      pubDate,
      totalPages: Math.max(1, page - 1),
      wordCount: chapters.reduce((s, c) => s + c.wordCount, 0),
      chapters,
    };
  }

  async function extractPdfInBrowser(arrayBuffer, filename) {
    const pdfjsLib = await ensurePdfJs();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;
    if (!totalPages) throw new Error("PDF has 0 pages.");

    let title = filename.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
    let author = "PDF Edition";
    try {
      const meta = await pdf.getMetadata();
      if (meta?.info?.Title && meta.info.Title.trim()) title = meta.info.Title.trim();
      if (meta?.info?.Author && meta.info.Author.trim()) author = meta.info.Author.trim();
    } catch (_) {}

    // Group pages into chapters (~12 pages per part if no outline)
    const ranges = [];
    try {
      const outline = await pdf.getOutline();
      if (Array.isArray(outline) && outline.length >= 2) {
        const resolved = [];
        for (const item of outline.slice(0, 30)) {
          let dest = item.dest;
          if (typeof dest === "string") dest = await pdf.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) {
            const pIdx = await pdf.getPageIndex(dest[0]);
            const t = (item.title || "").trim();
            if (t && !/^(cover|contents|copyright|index)/i.test(t)) {
              resolved.push({ title: t, page: pIdx + 1 });
            }
          }
        }
        for (let i = 0; i < resolved.length; i++) {
          const start = resolved[i].page;
          const end = i + 1 < resolved.length ? Math.max(start, resolved[i + 1].page - 1) : totalPages;
          ranges.push({ title: resolved[i].title, start, end });
        }
      }
    } catch (_) {}

    if (!ranges.length) {
      if (totalPages <= 16) {
        ranges.push({ title, start: 1, end: totalPages });
      } else {
        let part = 1;
        for (let p = 1; p <= totalPages; p += 14) {
          const end = Math.min(totalPages, p + 13);
          ranges.push({ title: `Part ${part} (pp. ${p}–${end})`, start: p, end });
          part++;
        }
      }
    }

    const chapters = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const paragraphs = [];
      for (let pg = r.start; pg <= r.end; pg++) {
        const page = await pdf.getPage(pg);
        const content = await page.getTextContent();
        const lines = [];
        let lastY = null;
        let curLine = [];

        for (const item of content.items) {
          const str = item.str || "";
          if (!str.trim() && !curLine.length) continue;
          const y = Math.round(item.transform[5]);
          if (lastY !== null && Math.abs(y - lastY) > 6) {
            const joined = curLine.join(" ").replace(/\s+/g, " ").trim();
            if (joined) lines.push({ text: joined, gap: Math.abs(lastY - y) });
            curLine = [];
          }
          curLine.push(escapeHtml(str));
          lastY = y;
        }
        if (curLine.length) {
          const joined = curLine.join(" ").replace(/\s+/g, " ").trim();
          if (joined) lines.push({ text: joined, gap: 0 });
        }

        // Group lines into paragraphs by vertical gap or sentence endings
        let paraBuf = [];
        let folioUsed = false;
        const flushPara = () => {
          if (!paraBuf.length) return;
          let html = paraBuf.join(" ").replace(/-\s+([a-z])/g, "$1").replace(/\s+/g, " ").trim();
          paraBuf = [];
          if (!html || /^\d+$/.test(html)) return;
          if (!folioUsed) {
            html = `<span class="folio-marker" data-page="${pg}" title="Page ${pg}">p. ${pg}</span>${html}`;
            folioUsed = true;
          }
          paragraphs.push({ type: "p", html, page: pg });
        };

        for (const ln of lines) {
          if (ln.gap > 18 && paraBuf.length > 0) flushPara();
          paraBuf.push(ln.text);
        }
        flushPara();
      }

      if (!paragraphs.length) continue;
      const chNum = chapters.length + 1;
      const chLabel = chapterWordLabel(chNum);
      chapters.push({
        slug: `chapter-${chNum}`,
        num: chNum,
        chapterLabel: chLabel,
        title: r.title,
        shortTitle: makeShortTitle(r.title, chLabel),
        folioStart: r.start,
        folioEnd: r.end,
        wordCount: paragraphs.reduce((s, p) => s + countWords(p.html), 0),
        paragraphs,
        endnotes: [],
      });
    }

    let subtitle = "";
    if (title.includes(":")) {
      const [t, sub] = title.split(":", 2);
      title = t.trim();
      subtitle = sub.trim();
    }

    return {
      sourceFormat: "pdf",
      title,
      subtitle,
      author,
      publisherMeta: "PDF DIGITAL EDITION",
      pubDate: "",
      totalPages,
      wordCount: chapters.reduce((s, c) => s + c.wordCount, 0),
      chapters,
    };
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await nativeFetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function buildWebEditionFromBlocks({ cleanTitle, author, siteName, pubDate, blocks }) {
    let page = 1;
    let wordsOnPage = 0;
    const paragraphs = blocks.map((b, idx) => {
      let html = b.html;
      wordsOnPage += countWords(html);
      if (idx === 0 || wordsOnPage >= 310) {
        if (idx > 0) {
          page += Math.max(1, Math.floor(wordsOnPage / 310));
          wordsOnPage %= 310;
        }
        if (b.type === "p") {
          html = `<span class="folio-marker" data-page="${page}" title="Page ${page}">p. ${page}</span>${html}`;
        }
      }
      return { type: b.type, html, page };
    });

    const totalWords = paragraphs.reduce((s, p) => s + countWords(p.html), 0);
    return {
      sourceFormat: "web",
      title: cleanTitle,
      subtitle: "",
      author: String(author || siteName).trim(),
      publisherMeta: String(siteName || "WEB EDITION").toUpperCase().slice(0, 28),
      pubDate: String(pubDate || "").slice(0, 10),
      totalPages: page,
      wordCount: totalWords,
      chapters: [
        {
          slug: "chapter-1",
          num: 1,
          chapterLabel: "Chapter One",
          title: cleanTitle,
          shortTitle: makeShortTitle(cleanTitle, "Article"),
          folioStart: 1,
          folioEnd: page,
          wordCount: totalWords,
          paragraphs,
          endnotes: [],
        },
      ],
    };
  }

  function parseHtmlIntoWebEdition(htmlText, u, fallbackMeta = {}) {
    const baseUrl = fallbackMeta.finalUrl || u.href;
    const doc = new DOMParser().parseFromString(htmlText, "text/html");

    const ogTitle =
      doc.querySelector('meta[property="og:title"], meta[name="twitter:title"]')?.getAttribute("content") || "";
    const siteName =
      doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || u.hostname.replace(/^www\./, "");
    const authorMeta =
      doc.querySelector('meta[name="author"]')?.getAttribute("content") ||
      doc.querySelector('[rel="author"], .author, .byline')?.textContent ||
      fallbackMeta.author ||
      siteName;
    const postHeading =
      doc.querySelector(".entry-title, .post-title, .post h1, .post h2, article h1, main h1")?.textContent?.trim() || "";

    // Prune non-article chrome (comments, sidebars, nav, share widgets, footers)
    doc
      .querySelectorAll(
        "script, style, nav, footer, aside, form, iframe, .comments, #comments, .commentlist, #respond, [id*='comment'], [class*='comment-'], .sidebar, #sidebar, .widget, .sharedaddy, .really_simple_share, .robots-nocontent, .postmetadata, .entry-meta, .navigation, .post-navigation, #header, #jp-post-flair, .jp-relatedposts"
      )
      .forEach((el) => el.remove());

    const mainEl =
      doc.querySelector(
        ".entry-content, .post-content, .article-content, .article-body, div.entry, [itemprop='articleBody'], article, .post, main"
      ) || doc.body;

    const { firstHeading, blocks } = extractBlocksFromDOM(mainEl, baseUrl);
    let rawTitle = (postHeading || ogTitle || firstHeading || fallbackMeta.title || doc.title || "Web Article")
      .replace(/\s+/g, " ")
      .trim();
    if (rawTitle.includes("»")) {
      const parts = rawTitle.split("»").map((s) => s.trim()).filter(Boolean);
      rawTitle = parts[parts.length - 1] || rawTitle;
    }

    const filtered = blocks.filter((b) => {
      const plain = stripTags(b.html);
      return (
        plain &&
        !/^(this entry was posted|leave a reply|share this:|posted in\s)/i.test(plain) &&
        plain.toLowerCase() !== rawTitle.toLowerCase()
      );
    });

    if (!filtered.length) return null;
    return buildWebEditionFromBlocks({
      cleanTitle: rawTitle,
      author: String(authorMeta || siteName).replace(/\s+/g, " ").trim(),
      siteName,
      pubDate: fallbackMeta.publishedTime || "",
      blocks: filtered,
    });
  }

  function parseMarkdownIntoWebEdition(mdText, u, meta = {}) {
    const siteName = u.hostname.replace(/^www\./, "");
    let cleanTitle = String(meta.title || "Web Article").replace(/\s+/g, " ").trim();
    if (cleanTitle.includes("»")) {
      const parts = cleanTitle.split("»").map((s) => s.trim()).filter(Boolean);
      cleanTitle = parts[parts.length - 1] || cleanTitle;
    }

    const chunks = String(mdText || "")
      .replace(/\r\n/g, "\n")
      .split(/\n\s*\n+/)
      .map((c) => c.trim())
      .filter(Boolean);

    const blocks = [];
    for (const chunk of chunks) {
      if (/^!\[[^\]]*\]\([^)]+\)$/.test(chunk) || /^[-=_*]{3,}$/.test(chunk)) continue;
      if (/^#{1,4}\s+/.test(chunk)) {
        const hTxt = chunk.replace(/^#{1,4}\s+/, "").trim();
        if (hTxt && hTxt.toLowerCase() !== cleanTitle.toLowerCase()) {
          blocks.push({ type: "subhead", html: escapeHtml(hTxt) });
        }
        continue;
      }
      const isQuote = chunk.startsWith(">");
      const rawLine = isQuote ? chunk.replace(/^>\s?/gm, "").trim() : chunk;
      const html = escapeHtml(rawLine)
        .replace(
          /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener noreferrer" class="prose-link">$1</a>'
        )
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\s+/g, " ")
        .trim();
      if (stripTags(html)) {
        blocks.push({ type: isQuote ? "blockquote" : "p", html });
      }
    }

    if (!blocks.length) return null;
    return buildWebEditionFromBlocks({
      cleanTitle,
      author: meta.author || siteName,
      siteName,
      pubDate: meta.publishedTime || "",
      blocks,
    });
  }

  async function extractUrlInBrowser(rawUrl) {
    let targetUrl = String(rawUrl || "").trim();
    if (!targetUrl) throw new Error("Please enter a valid https:// URL.");
    if (!/^https?:\/\//i.test(targetUrl)) targetUrl = `https://${targetUrl}`;

    const u = new URL(targetUrl);
    const gutenbergMatch = u.pathname.match(/^\/ebooks\/(\d+)\/?$/i);
    if (u.hostname.endsWith("gutenberg.org") && gutenbergMatch) {
      targetUrl = `https://www.gutenberg.org/cache/epub/${gutenbergMatch[1]}/pg${gutenbergMatch[1]}-images.html`;
    }

    // Tier 1: Try direct CORS fetch first (handles CORS-open HTML, .pdf, and .epub binaries)
    try {
      const directResp = await fetchWithTimeout(targetUrl, {}, 7000);
      if (directResp.ok) {
        const buf = await directResp.arrayBuffer();
        const bytes = new Uint8Array(buf.slice(0, 8));
        if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
          return extractPdfInBrowser(buf, u.pathname.split("/").pop() || "document.pdf");
        }
        if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
          return extractEpubInBrowser(buf, u.pathname.split("/").pop() || "book.epub");
        }
        const htmlText = new TextDecoder("utf-8").decode(buf);
        const parsed = parseHtmlIntoWebEdition(htmlText, u, { finalUrl: directResp.url || targetUrl });
        if (parsed) return parsed;
      }
    } catch (_) {
      // Expected for cross-origin sites without CORS headers; proceed to Tier 2
    }

    // Tier 2: Jina Reader HTML mode (CORS-enabled for browsers, returns raw HTML + metadata)
    try {
      const jinaHtmlResp = await fetchWithTimeout(
        `https://r.jina.ai/${targetUrl}`,
        {
          headers: {
            Accept: "application/json",
            "X-Return-Format": "html",
          },
        },
        22000
      );
      if (jinaHtmlResp.ok) {
        const jJson = await jinaHtmlResp.json();
        const d = jJson?.data || {};
        if (d.html) {
          const parsed = parseHtmlIntoWebEdition(d.html, u, {
            title: d.title,
            finalUrl: d.finalUrl || d.url || targetUrl,
            publishedTime: d.publishedTime,
          });
          if (parsed) return parsed;
        }
      }
    } catch (_) {}

    // Tier 3: Jina Reader clean Markdown mode (no custom preflight headers; handles JS SPAs & remote PDFs)
    try {
      const jinaMdResp = await fetchWithTimeout(
        `https://r.jina.ai/${targetUrl}`,
        { headers: { Accept: "application/json" } },
        22000
      );
      if (jinaMdResp.ok) {
        const jJson = await jinaMdResp.json();
        const d = jJson?.data || {};
        if (d.content) {
          const parsed = parseMarkdownIntoWebEdition(d.content, u, {
            title: d.title,
            publishedTime: d.publishedTime,
          });
          if (parsed) return parsed;
        }
      }
    } catch (_) {}

    // Tier 4: AllOrigins JSON wrapper fallback
    try {
      const aoResp = await fetchWithTimeout(
        `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`,
        {},
        7000
      );
      if (aoResp.ok) {
        const aoJson = await aoResp.json();
        if (aoJson?.contents) {
          const parsed = parseHtmlIntoWebEdition(aoJson.contents, u, { finalUrl: targetUrl });
          if (parsed) return parsed;
        }
      }
    } catch (_) {}

    throw new Error(
      "This site blocked cross-origin browser fetching. Download the page/PDF and drop the file above, or open Imprint locally (http://127.0.0.1:8080)."
    );
  }

  /* ========================================================================
     Browser Background Gemini Worker (Masthead, SVG Diagrams & Story Comics)
     ======================================================================== */
  function buildInitialSections(ch) {
    const paras = ch.paragraphs || [];
    const total = paras.length;
    const wc = ch.wordCount || 0;
    const count = total <= 5 || wc < 550 ? 1 : total <= 12 || wc < 1500 ? 2 : total <= 24 || wc < 3200 ? 3 : 4;
    const sections = [];

    for (let i = 0; i < count; i++) {
      const startIdx = Math.floor((i * total) / count);
      const endIdx = i + 1 < count ? Math.floor(((i + 1) * total) / count) - 1 : Math.max(0, total - 1);
      const slice = paras.slice(startIdx, endIdx + 1);
      const pStart = slice[0]?.page || ch.folioStart || 1;
      const pEnd = slice[slice.length - 1]?.page || ch.folioEnd || pStart;
      const quote = slice[0] ? stripTags(slice[0].html).slice(0, 170) : "";

      sections.push({
        id: `ch${ch.num}-section-${i + 1}`,
        num: i + 1,
        roman: ROMAN[i] || String(i + 1),
        startParagraphIndex: startIdx,
        pageStart: pStart,
        pageEnd: pEnd,
        title: count === 1 ? ch.shortTitle || ch.title : `Movement ${ROMAN[i]}`,
        subtitle: `pp. ${pStart}–${pEnd}`,
        takeawayLead: "Reading Guide",
        takeaway: getApiKey()
          ? "Gemini is analyzing this section in the background…"
          : "Connect your Gemini API Key in the top bar to generate AI concept diagrams & Story Comics.",
        quote,
        diagram: {
          heading: `${(ch.shortTitle || ch.title).toUpperCase().slice(0, 32)} · ${ROMAN[i]}`,
          box1: { title: "OPENING PREMISE", sub: `Section ${ROMAN[i]}` },
          box2: { title: "CORE DEVELOPMENT", sub: "Key argument & evidence" },
          box3: { title: "IMPLICATION", sub: `pp. ${pStart}–${pEnd}` },
          footer: `${ch.title} — Section ${ROMAN[i]}`,
        },
        beats: ["1. Opening", "2. Core Idea", "3. Turning Point", "4. Outcome"],
        comicUrl: "",
        comicStatus: getApiKey() ? "pending" : "skipped",
        enriched: false,
      });
    }
    return sections;
  }

  async function callGeminiJsonBrowser(promptText) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("Gemini API Key not set.");

    let lastErr = null;
    for (const model of ENRICH_TEXT_MODELS) {
      try {
        const res = await nativeFetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
            model
          )}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: promptText }] }],
              generationConfig: {
                temperature: 0.35,
                maxOutputTokens: 8192,
                responseMimeType: "application/json",
              },
            }),
          }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const txt = (data.candidates?.[0]?.content?.parts || [])
          .filter((p) => !p.thought && typeof p.text === "string")
          .map((p) => p.text)
          .join("")
          .trim();
        const cleaned = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        const s = cleaned.indexOf("{");
        const e = cleaned.lastIndexOf("}");
        return JSON.parse(s >= 0 && e > s ? cleaned.slice(s, e + 1) : cleaned);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Gemini JSON request failed");
  }

  async function compressBase64ToJpegDataUrl(b64, mimeType) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const maxW = 1280;
        const scale = img.width > maxW ? maxW / img.width : 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };
      img.onerror = () => resolve(`data:${mimeType || "image/jpeg"};base64,${b64}`);
      img.src = `data:${mimeType || "image/jpeg"};base64,${b64}`;
    });
  }

  async function generateComicDataUrlBrowser(promptText) {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("Set your Gemini API Key first.");

    let lastErr = null;
    for (const model of ENRICH_IMAGE_MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await nativeFetch(
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
            await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
            continue;
          }
          const data = await res.json();
          if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
          const imgPart = (data.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
          if (!imgPart) throw new Error("No image returned");
          return await compressBase64ToJpegDataUrl(imgPart.inlineData.data, imgPart.inlineData.mimeType);
        } catch (err) {
          lastErr = err;
        }
      }
    }
    throw lastErr || new Error("Image generation failed");
  }

  function buildComicPrompt({ bookTitle, author, chapterTitle, sectionTitle, comicSpec, takeaway }) {
    const spec = comicSpec || {};
    return [
      `16:9 widescreen editorial pen-and-ink and warm watercolor Story Comic illustration on cream archival book paper (#f5efe2) with subtle vermilion (#e12b1d) and deep indigo (#27328c) ink accents, Melville House / New Yorker nonfiction graphic narrative style.`,
      `Book: "${bookTitle}" by ${author} — ${chapterTitle} (${sectionTitle}).`,
      `- CENTER (50% x, 38% y): ${spec.centerScene || sectionTitle}. Speech banner: "${String(spec.centerBubble || sectionTitle).slice(0, 64)}".`,
      `- TOP-LEFT CLOUD (15% x, 22% y): ${spec.topLeftScene || "Opening context"}, ribbon "${String(spec.topLeftLabel || "1. Context").slice(0, 26)}".`,
      `- TOP-RIGHT CLOUD (85% x, 22% y): ${spec.topRightScene || "Turning point"}, ribbon "${String(spec.topRightLabel || "3. Turning Point").slice(0, 26)}".`,
      `- BOTTOM-RIGHT CLOUD (85% x, 80% y): ${spec.bottomRightScene || "Outcome"}, ribbon "${String(spec.bottomRightLabel || "4. Outcome").slice(0, 26)}".`,
      `Core idea: ${takeaway || sectionTitle}. Crisp ink linework, warm wash, legible hand-lettered short labels.`,
    ].join("\n");
  }

  const runningJobs = new Set();

  async function enrichBookInBrowser(bookId, comicMode = "all") {
    if (runningJobs.has(bookId)) return;
    runningJobs.add(bookId);

    try {
      const book = await dbGetBook(bookId);
      if (!book) return;

      if (!getApiKey()) {
        book.job = {
          status: "ready",
          readable: true,
          comicMode,
          percent: 100,
          phase: "Full text ready · Set Gemini API Key in top bar to generate Story Comics & AI diagrams.",
        };
        await dbPutBook(book);
        return;
      }

      const chapters = book.chapters || [];
      const plannedComics = [];
      chapters.forEach((c, cIdx) => {
        (c.sections || []).forEach((_, sIdx) => {
          if (comicMode === "diagrams_only") return;
          if (comicMode === "first" && sIdx > 0) return;
          plannedComics.push({ cIdx, sIdx });
        });
      });

      const totalSteps = 1 + chapters.length + plannedComics.length;
      let done = 0;

      const saveProgress = async (phase) => {
        book.job = {
          status: "processing",
          readable: true,
          comicMode,
          completedSteps: done,
          totalSteps,
          comicsDone: chapters.reduce((s, c) => s + (c.sections || []).filter((x) => Boolean(x.comicUrl)).length, 0),
          comicsTotal: plannedComics.length,
          percent: Math.min(99, Math.round((done / Math.max(1, totalSteps)) * 85) + 14),
          phase,
        };
        await dbPutBook(book);
      };

      await saveProgress("Gemini analyzing book masthead…");
      try {
        const sample = (chapters[0]?.paragraphs || []).slice(0, 6).map((p) => stripTags(p.html)).join("\n").slice(0, 1400);
        const mJson = await callGeminiJsonBrowser(
          `Return editorial masthead JSON for "${book.title}" by ${book.author}.\nSample:\n${sample}\nSchema: {"title":"clean title","subtitle":"subtitle or empty","author":"author","publisherMeta":"CAPS EDITION","pubDate":"YEAR","balanceDue":"2-WORD CAPS STATUS","tagline":"short verbatim quote"}`
        );
        if (mJson.title) book.title = String(mJson.title).trim();
        if (typeof mJson.subtitle === "string") book.subtitle = mJson.subtitle.trim();
        if (mJson.author) book.author = String(mJson.author).trim();
        if (mJson.publisherMeta) book.publisherMeta = String(mJson.publisherMeta).toUpperCase().slice(0, 32);
        if (mJson.pubDate) book.pubDate = String(mJson.pubDate).toUpperCase().slice(0, 14);
        if (mJson.balanceDue) book.balanceDue = String(mJson.balanceDue).toUpperCase().slice(0, 18);
        if (mJson.tagline) book.tagline = `“${String(mJson.tagline).replace(/^[“"']+|[”"']+$/g, "").toUpperCase().slice(0, 74)}”`;
      } catch (_) {}
      done++;

      for (let cIdx = 0; cIdx < chapters.length; cIdx++) {
        const ch = chapters[cIdx];
        await saveProgress(`Structuring ${ch.chapterLabel} (${cIdx + 1}/${chapters.length})…`);
        try {
          const paras = ch.paragraphs || [];
          const targetSecCount = (ch.sections || []).length || 1;
          const step = Math.max(1, Math.ceil(paras.length / 40));
          const preview = [];
          for (let p = 0; p < paras.length; p += step) {
            preview.push(`[P${p} | p.${paras[p].page}] ${stripTags(paras[p].html).slice(0, 250)}`);
          }
          const cJson = await callGeminiJsonBrowser(
            `Book: "${book.title}" by ${book.author}\nChapter ${ch.num}: "${ch.title}"\nExcerpts:\n${preview.join("\n")}\nPartition into EXACTLY ${targetSecCount} section(s). Return JSON:\n{"cleanChapterTitle":"title","shortTitle":"2-4 words","receiptTagline":"short quote","aiThemes":"100-word summary","sections":[{"startParagraphIndex":0,"title":"3-6 words","subtitle":"5-9 words","takeawayLead":"2-3 words","takeaway":"1 crisp sentence","quote":"verbatim quote","diagram":{"heading":"CAPS HEADER","box1":{"title":"STEP 1","sub":"sub"},"box2":{"title":"STEP 2","sub":"sub"},"box3":{"title":"STEP 3","sub":"sub"},"footer":"synthesis line"},"comicSpec":{"centerBubble":"short speech","centerScene":"scene","topLeftScene":"scene","topLeftLabel":"1. Beat","centerBeatLabel":"2. Beat","topRightScene":"scene","topRightLabel":"3. Beat","bottomRightScene":"scene","bottomRightLabel":"4. Beat"}}]}`
          );
          if (cJson.cleanChapterTitle) ch.title = String(cJson.cleanChapterTitle).trim();
          if (cJson.shortTitle) ch.shortTitle = String(cJson.shortTitle).trim().slice(0, 36);
          if (cJson.aiThemes) ch.aiThemes = String(cJson.aiThemes).trim();
          if (Array.isArray(cJson.sections) && cJson.sections.length) {
            let lastStart = 0;
            ch.sections = cJson.sections.slice(0, targetSecCount).map((s, idx) => {
              let startIdx = idx === 0 ? 0 : Number(s.startParagraphIndex || idx);
              if (!Number.isFinite(startIdx) || startIdx <= lastStart) {
                startIdx = idx === 0 ? 0 : Math.min(paras.length - 1, Math.max(lastStart + 1, Math.floor((idx * paras.length) / targetSecCount)));
              }
              lastStart = startIdx;
              const cs = s.comicSpec || {};
              return {
                id: `ch${ch.num}-section-${idx + 1}`,
                num: idx + 1,
                roman: ROMAN[idx] || String(idx + 1),
                startParagraphIndex: startIdx,
                pageStart: paras[startIdx]?.page || ch.folioStart,
                pageEnd: ch.folioEnd,
                title: String(s.title || `Section ${ROMAN[idx]}`).trim(),
                subtitle: String(s.subtitle || "").trim(),
                takeawayLead: String(s.takeawayLead || "Key Takeaway").replace(/:$/, ""),
                takeaway: String(s.takeaway || "").trim(),
                quote: String(s.quote || "").replace(/^[“"']+|[”"']+$/g, "").trim(),
                diagram: s.diagram || ch.sections[idx]?.diagram,
                comicSpec: cs,
                beats: [
                  `1. ${String(cs.topLeftLabel || "Opening").replace(/^[1-4]\.\s*/, "").slice(0, 20)}`,
                  `2. ${String(cs.centerBeatLabel || "Core Claim").replace(/^[1-4]\.\s*/, "").slice(0, 20)}`,
                  `3. ${String(cs.topRightLabel || "Turning Point").replace(/^[1-4]\.\s*/, "").slice(0, 20)}`,
                  `4. ${String(cs.bottomRightLabel || "Outcome").replace(/^[1-4]\.\s*/, "").slice(0, 20)}`,
                ],
                comicUrl: "",
                comicStatus: comicMode === "diagrams_only" || (comicMode === "first" && idx > 0) ? "skipped" : "pending",
                enriched: true,
              };
            });
          }
          ch.enriched = true;
        } catch (_) {}
        done++;
      }

      for (let i = 0; i < plannedComics.length; i++) {
        const { cIdx, sIdx } = plannedComics[i];
        const ch = chapters[cIdx];
        const sec = ch?.sections?.[sIdx];
        if (!sec) {
          done++;
          continue;
        }
        await saveProgress(`Illustrating Story Comic ${i + 1}/${plannedComics.length}: Ch. ${ch.num} · ${sec.roman}…`);
        try {
          sec.comicUrl = await generateComicDataUrlBrowser(
            buildComicPrompt({
              bookTitle: book.title,
              author: book.author,
              chapterTitle: `${ch.chapterLabel}: ${ch.title}`,
              sectionTitle: sec.title,
              comicSpec: sec.comicSpec,
              takeaway: sec.takeaway,
            })
          );
          sec.comicStatus = "ready";
        } catch (_) {
          sec.comicStatus = "failed";
        }
        done++;
      }

      book.job = {
        status: "ready",
        readable: true,
        comicMode,
        percent: 100,
        comicsDone: chapters.reduce((s, c) => s + (c.sections || []).filter((x) => Boolean(x.comicUrl)).length, 0),
        comicsTotal: plannedComics.length,
        phase: "Complete — Full text, SVG concept diagrams & Story Comics saved in browser.",
      };
      await dbPutBook(book);
    } finally {
      runningJobs.delete(bookId);
    }
  }

  /* ========================================================================
     Endnotes Helper & Study Chat in Browser Mode
     ======================================================================== */
  function markdownToSimpleHtml(rawText) {
    const blocks = String(rawText || "")
      .replace(/\r\n/g, "\n")
      .trim()
      .split(/\n\s*\n+/)
      .map((blk) =>
        escapeHtml(blk.trim())
          .replace(
            /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener noreferrer" class="prose-link">$1</a>'
          )
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>")
          .replace(/\n/g, "<br>")
      )
      .filter(Boolean);
    if (blocks.length <= 1) return blocks[0] || "";
    return blocks.map((b) => `<span class="endnote-para">${b}</span>`).join("");
  }

  function insertSupBrowser(paraHtml, offset, uid, chNum) {
    const tokenRe = /<span class="folio-marker"[^>]*>[\s\S]*?<\/span>|<sup class="note-ref"[^>]*>[\s\S]*?<\/sup>|<[^>]+>|&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z0-9]+);|[\s\S]/gi;
    let vis = 0;
    let pos = paraHtml.length;
    let reached = false;
    let m;
    while ((m = tokenRe.exec(paraHtml)) !== null) {
      const tok = m[0];
      if (tok.startsWith("<")) {
        if (reached) {
          if (/^<\/(?:a|em|i|strong|b|code|sub|sup)>$/i.test(tok)) {
            pos = m.index + tok.length;
            continue;
          }
          break;
        }
        continue;
      }
      if (reached) break;
      vis += 1;
      if (vis >= offset) {
        pos = m.index + tok.length;
        reached = true;
      }
    }
    const sup = `<sup class="note-ref" data-note-uid="${uid}"><a href="#ch${chNum}-note-1" id="ch${chNum}-ref-1" data-note="1" aria-label="Note 1">1</a></sup>`;
    return paraHtml.slice(0, pos) + sup + paraHtml.slice(pos);
  }

  function renumberEndnotesBrowser(ch) {
    const byUid = new Map((ch.endnotes || []).map((n, i) => [n.uid || `en_${i + 1}`, { ...n, uid: n.uid || `en_${i + 1}` }]));
    const ordered = [];
    const seen = new Set();
    (ch.paragraphs || []).forEach((p) => {
      p.html = String(p.html || "").replace(/<sup class="note-ref"\s+data-note-uid="([^"]+)"[^>]*>[\s\S]*?<\/sup>/gi, (_, uid) => {
        const n = byUid.get(uid);
        if (!n) return "";
        if (!seen.has(uid)) {
          seen.add(uid);
          ordered.push({ ...n, num: ordered.length + 1, anchored: true, page: p.page || 1 });
        }
        const num = ordered.find((x) => x.uid === uid)?.num || 1;
        return `<sup class="note-ref" data-note-uid="${uid}"><a href="#ch${ch.num}-note-${num}" id="ch${ch.num}-ref-${num}" data-note="${num}" aria-label="Note ${num}">${num}</a></sup>`;
      });
    });
    for (const [uid, n] of byUid.entries()) {
      if (!seen.has(uid)) ordered.push({ ...n, num: ordered.length + 1, anchored: false });
    }
    ch.endnotes = ordered;
    ch.receiptNotes = ordered.length ? `NOS. 01–${String(ordered.length).padStart(2, "0")}` : "INLINE EDITION";
  }

  /* ========================================================================
     API Key Modal UI (Shown Only When Hosted Statically on GitHub Pages)
     ======================================================================== */
  function injectStaticApiKeyBanner() {
    const actions = document.querySelector(".reader-bar__actions");
    if (!actions || document.getElementById("staticKeyBtn")) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bar-btn";
    btn.id = "staticKeyBtn";
    btn.title = "Configure your Gemini API Key (stored only in your browser)";
    const refreshBtnLabel = () => {
      const has = Boolean(getApiKey());
      btn.innerHTML = `<span aria-hidden="true">${has ? "🔑" : "⚠️"}</span><span class="bar-btn__label">${
        has ? "API Key" : "Set Gemini Key"
      }</span>`;
      const pill = document.getElementById("aiModelPillBtn");
      if (pill) pill.classList.toggle("is-connected", has);
    };
    refreshBtnLabel();

    btn.addEventListener("click", () => {
      const current = getApiKey();
      const entered = window.prompt(
        "Enter your Google Gemini API Key (stored privately in your browser's localStorage — never sent anywhere except generativelanguage.googleapis.com):",
        current
      );
      if (entered === null) return;
      setApiKey(entered);
      refreshBtnLabel();
    });

    actions.insertBefore(btn, actions.firstChild);
  }

  /* ========================================================================
     In-Browser `/api/...` Router Intercepting Requests on Static Hosts
     ======================================================================== */
  function jsonResponse(status, obj) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function createBookFromExtracted(extracted, extra = {}, comicMode = "all") {
    const id = `book_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const book = {
      id,
      title: extracted.title || "Untitled",
      subtitle: extracted.subtitle || "",
      author: extracted.author || "Unknown Author",
      publisherMeta: extracted.publisherMeta || "DIGITAL EDITION",
      pubDate: extracted.pubDate || "",
      balanceDue: "OPEN EDITION",
      tagline: `“${(extracted.title || "IMPRINT").toUpperCase().slice(0, 68)}”`,
      sourceFormat: extracted.sourceFormat || "epub",
      sourceUrl: extra.sourceUrl || "",
      originalFilename: extra.originalFilename || "",
      totalPages: extracted.totalPages || 1,
      wordCount: extracted.wordCount || 0,
      createdAt: now,
      updatedAt: now,
      job: {
        status: getApiKey() ? "processing" : "ready",
        readable: true,
        comicMode,
        percent: getApiKey() ? 15 : 100,
        phase: getApiKey()
          ? "Extracted chapters — launching Gemini enrichment…"
          : "Full text ready · Click “Set Gemini Key” in top bar for AI Comics & Chat.",
      },
      chapters: (extracted.chapters || []).map((ch) => ({
        ...ch,
        receiptItem: (ch.chapterLabel || `CHAPTER ${ch.num}`).toUpperCase(),
        receiptFolio: `PP. ${String(ch.folioStart).padStart(2, "0")}–${String(ch.folioEnd).padStart(2, "0")}`,
        receiptNotes: (ch.endnotes || []).length ? `NOS. 01–${String(ch.endnotes.length).padStart(2, "0")}` : "INLINE EDITION",
        receiptTagline: `“${ch.title.toUpperCase().slice(0, 70)}”`,
        aiThemes: `${ch.chapterLabel}: ${ch.title} from ${extracted.title}.`,
        sections: buildInitialSections(ch),
      })),
    };

    await dbPutBook(book);
    if (getApiKey()) {
      setTimeout(() => enrichBookInBrowser(id, comicMode), 50);
    }
    return book;
  }

  async function handleStaticApi(pathname, searchParams, method, options) {
    if (pathname === "/api/status" && method === "GET") {
      const books = await dbGetAllBooks();
      const model = getActiveModel();
      return jsonResponse(200, {
        aiConnected: Boolean(getApiKey()),
        staticPagesMode: true,
        activeModel: model,
        activeModelLabel: getModelLabel(model),
        models: ALLOWED_MODELS,
        bookCount: books.length,
      });
    }

    if (pathname === "/api/model" && method === "POST") {
      const body = JSON.parse(options?.body || "{}");
      setActiveModel(body.model || "gemini-4-neon");
      return jsonResponse(200, { ok: true, activeModel: getActiveModel(), activeModelLabel: getModelLabel(getActiveModel()) });
    }

    if (pathname === "/api/books" && method === "GET") {
      const books = await dbGetAllBooks();
      const summaries = books.map((b) => ({
        id: b.id,
        title: b.title,
        subtitle: b.subtitle,
        author: b.author,
        publisherMeta: b.publisherMeta,
        pubDate: b.pubDate,
        tagline: b.tagline,
        sourceFormat: b.sourceFormat,
        sourceUrl: b.sourceUrl || "",
        chapterCount: (b.chapters || []).length,
        wordCount: b.wordCount || 0,
        totalPages: b.totalPages || 1,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        job: b.job || { status: "ready", percent: 100 },
        previewComicUrl: b.chapters?.flatMap((c) => c.sections || []).find((s) => s.comicUrl)?.comicUrl || "",
      }));
      return jsonResponse(200, { books: summaries });
    }

    if (pathname === "/api/books/upload" && method === "POST") {
      try {
        const headers = options?.headers || {};
        const fname = decodeURIComponent(headers["X-Filename"] || headers["x-filename"] || "book.epub");
        const comicMode = headers["X-Comic-Mode"] || headers["x-comic-mode"] || "all";
        const fileBlob = options?.body;
        const buf = await fileBlob.arrayBuffer();
        const ext = fname.toLowerCase().endsWith(".pdf") ? ".pdf" : ".epub";
        const extracted = ext === ".pdf" ? await extractPdfInBrowser(buf, fname) : await extractEpubInBrowser(buf, fname);
        const book = await createBookFromExtracted(extracted, { originalFilename: fname }, comicMode);
        return jsonResponse(202, { ok: true, bookId: book.id, book });
      } catch (err) {
        return jsonResponse(400, { error: err.message || "Browser extraction failed" });
      }
    }

    if (pathname === "/api/books/import-url" && method === "POST") {
      try {
        const body = JSON.parse(options?.body || "{}");
        const extracted = await extractUrlInBrowser(body.url || "");
        const book = await createBookFromExtracted(extracted, { sourceUrl: body.url }, body.comicMode || "all");
        return jsonResponse(202, { ok: true, bookId: book.id, book });
      } catch (err) {
        return jsonResponse(400, { error: err.message || "URL import failed" });
      }
    }

    const m = pathname.match(/^\/api\/books\/(book_[a-z0-9_]+)(?:\/(.*))?$/);
    if (m) {
      const bookId = m[1];
      const sub = m[2] || "";

      if (!sub && method === "GET") {
        const b = await dbGetBook(bookId);
        return b ? jsonResponse(200, b) : jsonResponse(404, { error: "Not found" });
      }
      if (!sub && method === "DELETE") {
        await dbDeleteBook(bookId);
        return jsonResponse(200, { ok: true });
      }
      if (sub === "progress" && method === "GET") {
        const b = await dbGetBook(bookId);
        if (!b) return jsonResponse(404, { error: "Not found" });
        return jsonResponse(200, {
          id: b.id,
          title: b.title,
          subtitle: b.subtitle,
          author: b.author,
          publisherMeta: b.publisherMeta,
          pubDate: b.pubDate,
          balanceDue: b.balanceDue,
          tagline: b.tagline,
          chapterCount: (b.chapters || []).length,
          wordCount: b.wordCount || 0,
          job: b.job,
          chapterVisuals: (b.chapters || []).map((c) => ({
            slug: c.slug,
            title: c.title,
            shortTitle: c.shortTitle,
            enriched: Boolean(c.enriched),
            sections: (c.sections || []).map((s) => ({ ...s })),
          })),
        });
      }
      if (sub === "retry" && method === "POST") {
        setTimeout(() => enrichBookInBrowser(bookId, "all"), 50);
        return jsonResponse(202, { ok: true });
      }
      if (sub === "generate-comic" && method === "POST") {
        try {
          if (!getApiKey()) {
            document.getElementById("staticKeyBtn")?.click();
            if (!getApiKey()) throw new Error("Set your Gemini API Key in the top bar first.");
          }
          const body = JSON.parse(options?.body || "{}");
          const b = await dbGetBook(bookId);
          const ch = (b?.chapters || []).find((c) => c.slug === body.chapter);
          const sec = (ch?.sections || []).find((s) => s.id === body.sectionId);
          if (!sec) return jsonResponse(404, { error: "Section not found" });
          sec.comicUrl = await generateComicDataUrlBrowser(
            buildComicPrompt({
              bookTitle: b.title,
              author: b.author,
              chapterTitle: ch.title,
              sectionTitle: sec.title,
              comicSpec: sec.comicSpec,
              takeaway: sec.takeaway,
            })
          );
          sec.comicStatus = "ready";
          await dbPutBook(b);
          return jsonResponse(200, { ok: true, comicUrl: sec.comicUrl, sectionId: sec.id });
        } catch (err) {
          return jsonResponse(400, { error: err.message });
        }
      }
      if (sub === "state" && method === "GET") {
        const st = await dbGetState(bookId);
        return jsonResponse(200, { bookId, chapters: st.chapters || {}, activeModel: getActiveModel(), activeModelLabel: getModelLabel(getActiveModel()) });
      }
      if (sub === "annotations/sync" && method === "POST") {
        const body = JSON.parse(options?.body || "{}");
        const st = await dbGetState(bookId);
        const ch = body.chapter || "chapter-1";
        st.chapters[ch] = st.chapters[ch] || { annotations: [], chatMessages: [] };
        st.chapters[ch].annotations = body.annotations || [];
        await dbPutState(bookId, st);
        return jsonResponse(200, { ok: true });
      }
      if (sub === "chat/sync" && method === "POST") {
        const body = JSON.parse(options?.body || "{}");
        const st = await dbGetState(bookId);
        const ch = body.chapter || "chapter-1";
        st.chapters[ch] = st.chapters[ch] || { annotations: [], chatMessages: [] };
        st.chapters[ch].chatMessages = body.chatMessages || [];
        await dbPutState(bookId, st);
        return jsonResponse(200, { ok: true, chatMessages: st.chapters[ch].chatMessages });
      }
      if (sub === "chat" && method === "DELETE") {
        const ch = searchParams.get("chapter") || "chapter-1";
        const st = await dbGetState(bookId);
        if (st.chapters[ch]) st.chapters[ch].chatMessages = [];
        await dbPutState(bookId, st);
        return jsonResponse(200, { ok: true });
      }
      if (sub === "chat" && method === "POST") {
        try {
          if (!getApiKey()) {
            document.getElementById("staticKeyBtn")?.click();
          }
          const apiKey = getApiKey();
          if (!apiKey) throw new Error("Click “Set Gemini Key” in the top bar to chat with Gemini 4 Neon.");
          const body = JSON.parse(options?.body || "{}");
          const b = await dbGetBook(bookId);
          const chSlug = body.chapter || "chapter-1";
          const ch = (b?.chapters || []).find((c) => c.slug === chSlug) || b?.chapters?.[0];
          const st = await dbGetState(bookId);
          st.chapters[chSlug] = st.chapters[chSlug] || { annotations: [], chatMessages: [] };
          const history = st.chapters[chSlug].chatMessages;

          const proseSample = (ch?.paragraphs || []).slice(0, 32).map((p) => stripTagsKeepUrls(p.html)).join("\n").slice(0, 6500);
          const hl = body.selectedHighlight;
          const notes = Array.isArray(body.notes) ? body.notes : [];
          const sys = [
            `You are an insightful scholarly reading companion for "${b.title}" by ${b.author}${b.sourceUrl ? ` (${b.sourceUrl})` : ""}.`,
            `You have live Google Search enabled. Use Google Search whenever asked for links, proofs, papers, or external facts, and include clickable Markdown links ([Title](https://...)).`,
            hl?.quote ? `ACTIVE HIGHLIGHT (${hl.locLabel || ""}): "${hl.quote}"` : "",
            notes.length ? `READER NOTES:\n${notes.map((n, i) => `[${i + 1}] ${n.quote || ""} — ${n.note || ""}`).join("\n")}` : "",
            `CHAPTER EXCERPT:\n${proseSample}`,
          ].filter(Boolean).join("\n\n");

          const model = body.model || getActiveModel();
          const contents = history.slice(-8).map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.content }] }));
          contents.push({ role: "user", parts: [{ text: body.question }] });

          const res = await nativeFetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: sys }] },
                contents,
                tools: [{ googleSearch: {} }],
                generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
              }),
            }
          );
          const gData = await res.json();
          if (!res.ok) throw new Error(gData.error?.message || `HTTP ${res.status}`);
          const cand = gData.candidates?.[0] || {};
          const answer = (cand.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join("").trim();
          const gMeta = cand.groundingMetadata || {};
          const sources = [];
          const seen = new Set();
          for (const gc of gMeta.groundingChunks || []) {
            if (gc?.web?.uri && !seen.has(gc.web.uri)) {
              seen.add(gc.web.uri);
              sources.push({ title: (gc.web.title || "Source").slice(0, 50), uri: gc.web.uri });
            }
          }

          const now = Date.now();
          const uMsg = {
            id: `msg_u_${now}`,
            role: "user",
            content: body.question,
            highlightQuote: hl?.quote || "",
            highlightLoc: hl?.locLabel || "",
            notesCount: notes.length,
            createdAt: now,
          };
          const aMsg = {
            id: `msg_a_${now + 1}`,
            role: "assistant",
            content: answer,
            highlightLoc: getModelLabel(model),
            sources,
            searchQueries: gMeta.webSearchQueries || [],
            createdAt: now + 1,
          };
          st.chapters[chSlug].chatMessages.push(uMsg, aMsg);
          await dbPutState(bookId, st);
          return jsonResponse(200, { ok: true, chapter: chSlug, userMessage: uMsg, assistantMessage: aMsg });
        } catch (err) {
          return jsonResponse(400, { error: err.message });
        }
      }
      if (sub === "endnotes" && method === "POST") {
        const body = JSON.parse(options?.body || "{}");
        const b = await dbGetBook(bookId);
        const ch = (b?.chapters || []).find((c) => c.slug === (body.chapter || "chapter-1"));
        if (!ch) return jsonResponse(404, { error: "Chapter not found" });
        if (body.action === "add") {
          const uid = `en_u_${Date.now().toString(36)}`;
          const rawText = String(body.text || "").trim();
          if (typeof body.paraIndex === "number" && ch.paragraphs[body.paraIndex] && body.paraEndOffset > 0) {
            ch.paragraphs[body.paraIndex].html = insertSupBrowser(ch.paragraphs[body.paraIndex].html, body.paraEndOffset, uid, ch.num);
          }
          ch.endnotes = ch.endnotes || [];
          ch.endnotes.push({ uid, num: ch.endnotes.length + 1, rawText, html: markdownToSimpleHtml(rawText), page: body.page || 1, userAdded: true });
          renumberEndnotesBrowser(ch);
          await dbPutBook(b);
          const created = ch.endnotes.find((x) => x.uid === uid);
          return jsonResponse(200, { ok: true, chapter: ch, createdUid: uid, createdNum: created?.num || 1 });
        }
        if (body.action === "update") {
          const target = (ch.endnotes || []).find((n) => n.uid === body.uid || n.num === Number(body.num));
          if (target) {
            target.rawText = String(body.text || "").trim();
            target.html = markdownToSimpleHtml(target.rawText);
            await dbPutBook(b);
          }
          return jsonResponse(200, { ok: true, chapter: ch, updatedNum: target?.num });
        }
        if (body.action === "delete") {
          const target = (ch.endnotes || []).find((n) => n.uid === body.uid || n.num === Number(body.num));
          if (target) {
            (ch.paragraphs || []).forEach((p) => {
              p.html = String(p.html || "").replace(new RegExp(`<sup class="note-ref"\\s+data-note-uid="${target.uid}"[^>]*>[\\s\\S]*?<\\/sup>`, "gi"), "");
            });
            ch.endnotes = (ch.endnotes || []).filter((n) => n.uid !== target.uid);
            renumberEndnotesBrowser(ch);
            await dbPutBook(b);
          }
          return jsonResponse(200, { ok: true, chapter: ch });
        }
      }
    }

    return jsonResponse(404, { error: "Unknown static endpoint" });
  }

  async function detectHostingMode() {
    if (modeResolved) return staticMode;
    if (modePromise) return modePromise;
    modePromise = (async () => {
      try {
        const probe = await nativeFetch("api/status", { cache: "no-store" });
        const ct = (probe.headers.get("content-type") || "").toLowerCase();
        if (probe.ok && ct.includes("application/json")) {
          staticMode = false;
        } else {
          staticMode = true;
        }
      } catch (_) {
        staticMode = true;
      }
      modeResolved = true;
      if (staticMode) {
        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", injectStaticApiKeyBanner);
        } else {
          injectStaticApiKeyBanner();
        }
      }
      return staticMode;
    })();
    return modePromise;
  }

  window.fetch = async function (input, init) {
    const rawUrl = typeof input === "string" ? input : input?.url || "";
    let parsed = null;
    try {
      parsed = new URL(rawUrl, window.location.href);
    } catch (_) {}

    // Intercept `/api/...` calls seamlessly when hosted statically on GitHub Pages
    if (parsed && parsed.origin === window.location.origin && parsed.pathname.includes("/api/")) {
      const apiIdx = parsed.pathname.indexOf("/api/");
      const normPath = parsed.pathname.slice(apiIdx);
      const isStatic = await detectHostingMode();
      if (isStatic) {
        return handleStaticApi(normPath, parsed.searchParams, (init?.method || "GET").toUpperCase(), init);
      }
    }
    return nativeFetch(input, init);
  };
})();
