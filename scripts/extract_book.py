#!/usr/bin/env python3
"""
Extract full actual chapters, paragraphs, blockquotes, headings, page folios,
and endnotes from any .epub or .pdf file into structured JSON for Book Viz Studio.
Never summarizes prose—preserves the complete text of the book.
"""

import html
import json
import os
import posixpath
import re
import sys
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote, urldefrag
import xml.etree.ElementTree as ET

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None


ROMAN_NUMERALS = [
    "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
    "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
]

NUMBER_WORDS = [
    "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
    "Eighteen", "Nineteen", "Twenty", "Twenty-One", "Twenty-Two", "Twenty-Three",
    "Twenty-Four", "Twenty-Five", "Twenty-Six", "Twenty-Seven", "Twenty-Eight",
    "Twenty-Nine", "Thirty",
]

SKIP_TOC_PATTERNS = re.compile(
    r"^(cover|half\s*title|title\s*page|copyright|dedication|contents|table\s+of\s+contents|"
    r"illustrations|list\s+of\s+figures|acknowledg(e)?ments|about\s+the\s+author|"
    r"also\s+by|index|colophon|frontispiece|praise\s+for)\b",
    re.IGNORECASE,
)

NOTES_TOC_PATTERNS = re.compile(
    r"^(notes|endnotes|footnotes|references|bibliography)\b",
    re.IGNORECASE,
)


def chapter_word_label(n: int) -> str:
    if 1 <= n <= len(NUMBER_WORDS):
        return f"Chapter {NUMBER_WORDS[n - 1]}"
    return f"Chapter {n}"


def clean_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def strip_tags(raw_html: str) -> str:
    return clean_whitespace(re.sub(r"<[^>]+>", " ", raw_html or ""))


def count_words(text: str) -> int:
    t = strip_tags(text)
    if not t:
        return 0
    return len(t.split())


def make_short_title(title: str, fallback: str) -> str:
    t = clean_whitespace(title)
    t = re.sub(r"^(chapter|part|book|section)\s+([0-9ivxlcdm]+|[a-z-]+)\s*[:.\-–—]?\s*", "", t, flags=re.I)
    if not t:
        t = clean_whitespace(title) or fallback
    words = t.split()
    if len(words) > 5:
        return " ".join(words[:5]) + "…"
    return t


# ============================================================================
# EPUB XHTML Parser (Preserves <p>, <em>, <strong>, <blockquote>, <h2>, notes)
# ============================================================================

class EpubXHTMLConverter(HTMLParser):
    BLOCK_TAGS = {"p", "div", "li", "h1", "h2", "h3", "h4", "blockquote"}
    INLINE_EM = {"em", "i"}
    INLINE_STRONG = {"strong", "b"}
    SKIP_CONTENT_TAGS = {"script", "style", "head", "title", "svg", "nav"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []  # list of {"type": "p"|"blockquote"|"subhead", "html": str, "id": str}
        self.footnotes_by_id = {}  # id -> html
        self.note_links = []  # (href, text)
        self._skip_depth = 0
        self._in_blockquote = 0
        self._in_aside_note_id = None
        self._aside_buf = []
        self._current_tag = None
        self._current_attrs = {}
        self._buf = []
        self._inline_stack = []
        self.first_heading = ""

    def _push_buf(self, s: str):
        if self._skip_depth > 0:
            return
        if self._in_aside_note_id is not None:
            self._aside_buf.append(s)
        elif self._current_tag is not None:
            self._buf.append(s)

    def _flush_block(self):
        if self._current_tag is None:
            return
        raw = "".join(self._buf).strip()
        raw = re.sub(r"\s+", " ", raw).strip()
        tag = self._current_tag
        attrs = self._current_attrs
        self._current_tag = None
        self._current_attrs = {}
        self._buf = []
        if not raw or not strip_tags(raw):
            return

        elem_id = attrs.get("id", "")
        epub_type = attrs.get("epub:type", "") or attrs.get("role", "")
        cls = attrs.get("class", "").lower()

        # Detect footnote/endnote paragraphs inside the file
        if (
            "footnote" in epub_type
            or "endnote" in epub_type
            or "doc-endnote" in epub_type
            or "footnote" in cls
            or "endnote" in cls
        ) and elem_id:
            self.footnotes_by_id[elem_id] = raw
            return

        if tag in ("h1", "h2", "h3", "h4"):
            plain = strip_tags(raw)
            if not self.first_heading and tag in ("h1", "h2"):
                self.first_heading = plain
                return
            self.blocks.append({"type": "subhead", "html": html.escape(plain), "id": elem_id})
        elif self._in_blockquote > 0 or tag == "blockquote" or "quote" in cls or "extract" in cls:
            self.blocks.append({"type": "blockquote", "html": raw, "id": elem_id})
        else:
            self.blocks.append({"type": "p", "html": raw, "id": elem_id})

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        attr_map = {k.lower(): (v or "") for k, v in attrs}

        if tag in self.SKIP_CONTENT_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth > 0:
            return

        epub_type = attr_map.get("epub:type", "") + " " + attr_map.get("role", "")
        elem_id = attr_map.get("id", "")

        if tag == "aside" and ("note" in epub_type or elem_id):
            self._flush_block()
            self._in_aside_note_id = elem_id or f"aside_{len(self.footnotes_by_id)+1}"
            self._aside_buf = []
            return

        if tag == "blockquote":
            self._flush_block()
            self._in_blockquote += 1
            return

        if tag in ("p", "h1", "h2", "h3", "h4", "li"):
            self._flush_block()
            self._current_tag = tag
            self._current_attrs = attr_map
            return

        if tag == "div" and self._current_tag is None:
            # Only treat leaf-ish divs with classes/ids if needed; nested <p> will flush cleanly
            self._current_tag = "div"
            self._current_attrs = attr_map
            return

        if tag == "br":
            self._push_buf(" ")
            return

        if tag == "span":
            if "pagebreak" in epub_type or "doc-pagebreak" in epub_type:
                pg = attr_map.get("title") or attr_map.get("aria-label") or ""
                pg_num = re.sub(r"[^0-9ivxlcdmIVXLCDM]", "", pg)
                if pg_num:
                    self._push_buf(f'[[FOLIO:{pg_num}]]')
            return

        if tag in self.INLINE_EM:
            self._inline_stack.append("em")
            self._push_buf("<em>")
        elif tag in self.INLINE_STRONG:
            self._inline_stack.append("strong")
            self._push_buf("<strong>")
        elif tag == "a":
            href = attr_map.get("href", "")
            cls = attr_map.get("class", "").lower()
            is_noteref = (
                "noteref" in epub_type
                or "footnote" in cls
                or "endnote" in cls
                or bool(re.search(r"#(fn|note|en|ftn|ref)[-_]?\d+", href, re.I))
            )
            if is_noteref and href:
                self._inline_stack.append(("noteref", href))
                self._push_buf(f"[[NOTEREF:{href}::")
            else:
                self._inline_stack.append(("a", ""))

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.SKIP_CONTENT_TAGS:
            if self._skip_depth > 0:
                self._skip_depth -= 1
            return
        if self._skip_depth > 0:
            return

        if tag == "aside" and self._in_aside_note_id is not None:
            raw = clean_whitespace("".join(self._aside_buf))
            if raw:
                self.footnotes_by_id[self._in_aside_note_id] = raw
            self._in_aside_note_id = None
            self._aside_buf = []
            return

        if tag == "blockquote":
            self._flush_block()
            self._in_blockquote = max(0, self._in_blockquote - 1)
            return

        if tag in ("p", "h1", "h2", "h3", "h4", "li", "div"):
            if self._current_tag == tag:
                self._flush_block()
            return

        if tag in self.INLINE_EM:
            if self._inline_stack and self._inline_stack[-1] == "em":
                self._inline_stack.pop()
                self._push_buf("</em>")
        elif tag in self.INLINE_STRONG:
            if self._inline_stack and self._inline_stack[-1] == "strong":
                self._inline_stack.pop()
                self._push_buf("</strong>")
        elif tag == "a":
            if self._inline_stack and isinstance(self._inline_stack[-1], tuple):
                kind, _ = self._inline_stack.pop()
                if kind == "noteref":
                    self._push_buf("]]")

    def handle_data(self, data):
        if self._skip_depth > 0 or not data:
            return
        self._push_buf(html.escape(data))


def parse_epub_toc_map(zf: zipfile.ZipFile, opf_dir: str, manifest: dict, opf_root: ET.Element) -> dict:
    """Returns mapping of normalized zip href -> TOC label."""
    toc_map = {}

    # 1. Check EPUB3 nav item
    for item_id, info in manifest.items():
        props = info.get("properties", "")
        if "nav" in props.split():
            nav_path = info["path"]
            try:
                raw = zf.read(nav_path).decode("utf-8", errors="replace")
                for m in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', raw, re.I | re.S):
                    href_raw, label_html = m.group(1), m.group(2)
                    doc_part, _ = urldefrag(unquote(href_raw))
                    if not doc_part:
                        continue
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(nav_path), doc_part))
                    label = strip_tags(label_html)
                    if label and resolved not in toc_map:
                        toc_map[resolved] = label
            except Exception:
                pass

    # 2. Check EPUB2 NCX item
    for item_id, info in manifest.items():
        if "ncx" in info.get("media_type", "").lower() or info["path"].lower().endswith(".ncx"):
            ncx_path = info["path"]
            try:
                ncx_root = ET.fromstring(zf.read(ncx_path))
                for np in ncx_root.iter():
                    if np.tag.endswith("navPoint"):
                        label = ""
                        src = ""
                        for child in np:
                            if child.tag.endswith("navLabel"):
                                for t in child.iter():
                                    if t.tag.endswith("text") and t.text:
                                        label = clean_whitespace(t.text)
                                        break
                            elif child.tag.endswith("content"):
                                src = child.attrib.get("src", "")
                        if src and label:
                            doc_part, _ = urldefrag(unquote(src))
                            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(ncx_path), doc_part))
                            if resolved not in toc_map:
                                toc_map[resolved] = label
            except Exception:
                pass

    return toc_map


def extract_epub_native(epub_path: str) -> dict:
    with zipfile.ZipFile(epub_path, "r") as zf:
        container_xml = zf.read("META-INF/container.xml")
        c_root = ET.fromstring(container_xml)
        opf_path = ""
        for elem in c_root.iter():
            if elem.tag.endswith("rootfile") and elem.attrib.get("full-path"):
                opf_path = elem.attrib["full-path"]
                break
        if not opf_path:
            raise ValueError("No OPF rootfile in EPUB container.xml")

        opf_dir = posixpath.dirname(opf_path)
        opf_root = ET.fromstring(zf.read(opf_path))

        title = ""
        author = ""
        publisher = ""
        pub_date = ""

        for elem in opf_root.iter():
            tag_local = elem.tag.split("}")[-1].lower()
            txt = clean_whitespace(elem.text or "")
            if not txt:
                continue
            if tag_local == "title" and not title:
                title = txt
            elif tag_local == "creator" and not author:
                author = txt
            elif tag_local == "publisher" and not publisher:
                publisher = txt
            elif tag_local == "date" and not pub_date:
                pub_date = txt[:10]

        manifest = {}
        for elem in opf_root.iter():
            if elem.tag.endswith("item"):
                item_id = elem.attrib.get("id", "")
                href = unquote(elem.attrib.get("href", ""))
                media_type = elem.attrib.get("media-type", "")
                props = elem.attrib.get("properties", "")
                if item_id and href:
                    norm_path = posixpath.normpath(posixpath.join(opf_dir, href)) if opf_dir else posixpath.normpath(href)
                    manifest[item_id] = {
                        "path": norm_path,
                        "media_type": media_type,
                        "properties": props,
                    }

        spine_paths = []
        for elem in opf_root.iter():
            if elem.tag.endswith("itemref"):
                idref = elem.attrib.get("idref", "")
                if idref in manifest:
                    mt = manifest[idref]["media_type"].lower()
                    if "html" in mt or "xml" in mt:
                        spine_paths.append(manifest[idref]["path"])

        toc_map = parse_epub_toc_map(zf, opf_dir, manifest, opf_root)

        # First pass: parse all spine XHTML files & collect global footnotes
        parsed_docs = []
        global_notes = {}  # (doc_path, frag_id) -> html

        for sp_path in spine_paths:
            try:
                raw_bytes = zf.read(sp_path)
            except KeyError:
                continue
            raw_html = raw_bytes.decode("utf-8", errors="replace")
            parser = EpubXHTMLConverter()
            parser.feed(raw_html)
            parser._flush_block()

            for fid, fhtml in parser.footnotes_by_id.items():
                global_notes[(sp_path, fid)] = fhtml
            # Also capture any block with id that looks like a note if referenced
            for b in parser.blocks:
                if b.get("id"):
                    global_notes.setdefault((sp_path, b["id"]), b["html"])

            parsed_docs.append({
                "path": sp_path,
                "toc_title": toc_map.get(sp_path, ""),
                "heading": parser.first_heading,
                "blocks": parser.blocks,
            })

        # Group spine items into logical chapters
        raw_chapters = []
        for doc in parsed_docs:
            label = doc["toc_title"] or doc["heading"]
            word_cnt = sum(count_words(b["html"]) for b in doc["blocks"])
            if word_cnt == 0:
                continue
            if label and SKIP_TOC_PATTERNS.search(label) and word_cnt < 900:
                continue
            if label and NOTES_TOC_PATTERNS.search(label):
                continue
            if not raw_chapters:
                if word_cnt < 120 and not label:
                    continue
                raw_chapters.append({
                    "path": doc["path"],
                    "title": label or "Chapter 1",
                    "blocks": list(doc["blocks"]),
                })
            else:
                # Merge continuation spine splits without their own TOC title
                if not doc["toc_title"] and (word_cnt < 250 or not doc["heading"]):
                    raw_chapters[-1]["blocks"].extend(doc["blocks"])
                else:
                    if word_cnt < 90 and SKIP_TOC_PATTERNS.search(label or ""):
                        continue
                    raw_chapters.append({
                        "path": doc["path"],
                        "title": label or f"Chapter {len(raw_chapters) + 1}",
                        "blocks": list(doc["blocks"]),
                    })

        # Filter tiny non-chapter front-matter remnants (< 45 words) if real chapters exist
        substantial = [
            c
            for c in raw_chapters
            if sum(count_words(b["html"]) for b in c["blocks"]) >= 45
            or not SKIP_TOC_PATTERNS.search(c.get("title") or "")
        ]
        if substantial:
            raw_chapters = substantial

        # Format chapters with synthetic or native folios + linked endnotes
        chapters = []
        synthetic_page = 1
        words_on_page = 0

        for idx, ch in enumerate(raw_chapters):
            ch_num = idx + 1
            slug = f"chapter-{ch_num}"
            ch_notes = []
            paragraphs = []
            ch_start_page = synthetic_page

            def replace_noteref(match, doc_path=ch["path"]):
                href = match.group(1)
                anchor_text = strip_tags(match.group(2)) or str(len(ch_notes) + 1)
                target_doc, frag = urldefrag(unquote(href))
                resolved_doc = (
                    posixpath.normpath(posixpath.join(posixpath.dirname(doc_path), target_doc))
                    if target_doc
                    else doc_path
                )
                note_body = global_notes.get((resolved_doc, frag), "")
                if not note_body:
                    return f"<sup>{html.escape(anchor_text)}</sup>"
                note_num = len(ch_notes) + 1
                clean_note = re.sub(r"\[\[NOTEREF:[^\]]+\]\]", "", note_body)
                clean_note = re.sub(r"\[\[FOLIO:[^\]]+\]\]", "", clean_note).strip()
                ch_notes.append({
                    "num": note_num,
                    "html": clean_note,
                    "page": synthetic_page,
                })
                return (
                    f'<sup class="note-ref">'
                    f'<a href="#ch{ch_num}-note-{note_num}" id="ch{ch_num}-ref-{note_num}" '
                    f'data-note="{note_num}" aria-label="Note {note_num}">{note_num}</a></sup>'
                )

            for b_idx, b in enumerate(ch["blocks"]):
                b_html = b["html"]

                # Check native folio markers
                native_folios = re.findall(r"\[\[FOLIO:([^\]]+)\]\]", b_html)
                if native_folios:
                    try:
                        synthetic_page = int(re.sub(r"\D", "", native_folios[0]) or synthetic_page)
                    except ValueError:
                        pass

                def replace_folio(fm):
                    pg = fm.group(1)
                    return f'<span class="folio-marker" data-page="{html.escape(pg)}" title="Page {html.escape(pg)}">p. {html.escape(pg)}</span>'

                b_html = re.sub(r"\[\[FOLIO:([^\]]+)\]\]", replace_folio, b_html)
                b_html = re.sub(r"\[\[NOTEREF:([^:]+)::(.*?)\]\]", replace_noteref, b_html)

                w_cnt = count_words(b_html)
                words_on_page += w_cnt
                if not native_folios and (b_idx == 0 or words_on_page >= 310):
                    if b_idx > 0:
                        synthetic_page += max(1, words_on_page // 310)
                        words_on_page = words_on_page % 310
                    if b["type"] == "p":
                        b_html = (
                            f'<span class="folio-marker" data-page="{synthetic_page}" '
                            f'title="Page {synthetic_page}">p. {synthetic_page}</span>' + b_html
                        )

                paragraphs.append({
                    "type": b["type"],
                    "html": b_html,
                    "page": synthetic_page,
                })

            ch_end_page = max(ch_start_page, synthetic_page)
            synthetic_page = ch_end_page + 1
            words_on_page = 0

            raw_title = clean_whitespace(ch["title"])
            # Separate "Chapter 1: Title" if present
            ch_label = chapter_word_label(ch_num)
            clean_title = raw_title
            m_head = re.match(
                r"^(chapter|part|section)\s+([0-9ivxlcdm]+|[a-z-]+)\s*[:.\-–—]+\s*(.+)$",
                raw_title,
                re.I,
            )
            if m_head:
                ch_label = f"{m_head.group(1).title()} {m_head.group(2)}"
                clean_title = m_head.group(3).strip()

            chapters.append({
                "slug": slug,
                "num": ch_num,
                "chapterLabel": ch_label,
                "title": clean_title or ch_label,
                "shortTitle": make_short_title(clean_title, ch_label),
                "folioStart": ch_start_page,
                "folioEnd": ch_end_page,
                "wordCount": sum(count_words(p["html"]) for p in paragraphs),
                "paragraphs": paragraphs,
                "endnotes": ch_notes,
            })

        if not chapters:
            raise ValueError("No readable chapters found in EPUB spine")

        if not title:
            title = os.path.splitext(os.path.basename(epub_path))[0].replace("_", " ").replace("-", " ").title()

        # Split title: subtitle if colon present
        subtitle = ""
        if ":" in title:
            parts = title.split(":", 1)
            title = parts[0].strip()
            subtitle = parts[1].strip()

        return {
            "sourceFormat": "epub",
            "title": title,
            "subtitle": subtitle,
            "author": author or "Unknown Author",
            "publisherMeta": (publisher or "DIGITAL EDITION").upper(),
            "pubDate": pub_date or "",
            "totalPages": max(1, synthetic_page - 1),
            "wordCount": sum(c["wordCount"] for c in chapters),
            "chapters": chapters,
        }


# ============================================================================
# PDF Extractor via PyMuPDF (fitz) — Preserves Actual Prose, Italics & Folios
# ============================================================================

def extract_pdf_with_fitz(pdf_path: str) -> dict:
    if fitz is None:
        raise RuntimeError("PyMuPDF (fitz) is required for PDF extraction.")

    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    if total_pages == 0:
        raise ValueError("Uploaded PDF has 0 pages.")

    meta = doc.metadata or {}
    raw_title = clean_whitespace(meta.get("title") or "")
    author = clean_whitespace(meta.get("author") or "")
    pub_date = ""
    cdate = meta.get("creationDate") or ""
    m_yr = re.search(r"(19|20)\d{2}", cdate)
    if m_yr:
        pub_date = m_yr.group(0)

    # Determine chapter ranges [(title, start_page_1based, end_page_1based)]
    toc = doc.get_toc() or []
    chapter_ranges = []

    if toc:
        # Prefer level-1 entries unless level-1 is only 1-2 "Parts" and level-2 has chapters
        lvl1 = [t for t in toc if t[0] == 1 and 1 <= t[2] <= total_pages]
        lvl2 = [t for t in toc if t[0] == 2 and 1 <= t[2] <= total_pages]
        chosen = lvl1 if len(lvl1) >= 3 or not lvl2 else [t for t in toc if t[0] in (1, 2) and 1 <= t[2] <= total_pages]

        filtered = []
        notes_start_page = total_pages + 1
        for lvl, t_title, pg in chosen:
            t_clean = clean_whitespace(t_title)
            if not t_clean:
                continue
            if NOTES_TOC_PATTERNS.search(t_clean):
                notes_start_page = min(notes_start_page, pg)
                continue
            if SKIP_TOC_PATTERNS.search(t_clean):
                continue
            if filtered and filtered[-1][1] == pg:
                # Merge duplicate page starts
                filtered[-1] = (f"{filtered[-1][0]} — {t_clean}", pg)
            else:
                filtered.append((t_clean, pg))

        for i, (t_clean, start_pg) in enumerate(filtered):
            if start_pg >= notes_start_page:
                continue
            next_pg = filtered[i + 1][1] - 1 if i + 1 < len(filtered) else min(total_pages, notes_start_page - 1)
            end_pg = max(start_pg, min(next_pg, notes_start_page - 1))
            chapter_ranges.append((t_clean, start_pg, end_pg))

    # Fallback 2: Scan pages for prominent "Chapter X" / large-font headings
    if not chapter_ranges:
        detected = []
        heading_re = re.compile(
            r"^(chapter|part|section|lecture|essay)\s+([0-9ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b[:.\-–—\s]*(.*)$",
            re.I,
        )
        for pno in range(total_pages):
            page = doc[pno]
            text_top = clean_whitespace(page.get_text("text")[:450])
            first_lines = [clean_whitespace(ln) for ln in page.get_text("text").splitlines()[:6] if clean_whitespace(ln)]
            for idx_ln, ln in enumerate(first_lines[:3]):
                m = heading_re.match(ln)
                if m:
                    ch_head = f"{m.group(1).title()} {m.group(2)}"
                    rest = clean_whitespace(m.group(3))
                    if not rest and idx_ln + 1 < len(first_lines) and len(first_lines[idx_ln + 1]) < 90:
                        rest = first_lines[idx_ln + 1]
                    full_t = f"{ch_head}: {rest}" if rest else ch_head
                    if not detected or pno + 1 > detected[-1][1]:
                        detected.append((full_t, pno + 1))
                    break

        if len(detected) >= 2:
            for i, (t_clean, start_pg) in enumerate(detected):
                end_pg = detected[i + 1][1] - 1 if i + 1 < len(detected) else total_pages
                chapter_ranges.append((t_clean, start_pg, max(start_pg, end_pg)))

    # Fallback 3: Chunk by ~14 pages (or single chapter if <= 16 pages)
    if not chapter_ranges:
        if total_pages <= 16:
            chapter_ranges = [(raw_title or "Complete Text", 1, total_pages)]
        else:
            chunk = 14
            part_num = 1
            for start_pg in range(1, total_pages + 1, chunk):
                end_pg = min(total_pages, start_pg + chunk - 1)
                chapter_ranges.append((f"Part {part_num} (pp. {start_pg}–{end_pg})", start_pg, end_pg))
                part_num += 1

    # Extract rich paragraphs per chapter range
    chapters = []
    for idx, (ch_raw_title, start_pg, end_pg) in enumerate(chapter_ranges):
        paragraphs = []
        ch_notes = []
        carry_para = None  # {"type": "p"|"blockquote", "html": str, "page": int}

        for pg_1 in range(start_pg, end_pg + 1):
            page = doc[pg_1 - 1]
            rect = page.rect
            page_h = rect.height or 792.0
            page_w = rect.width or 612.0
            pdict = page.get_text("dict")
            blocks = [b for b in pdict.get("blocks", []) if b.get("type") == 0]
            if not blocks:
                continue

            # Estimate typical left margin & body font size on this page
            x0_samples = []
            size_samples = []
            for b in blocks:
                y0, y1 = b["bbox"][1], b["bbox"][3]
                if y0 < page_h * 0.065 or y1 > page_h * 0.935:
                    continue
                for ln in b.get("lines", []):
                    x0_samples.append(ln["bbox"][0])
                    for sp in ln.get("spans", []):
                        if sp.get("text", "").strip():
                            size_samples.append(sp.get("size", 11.0))

            base_x0 = min(x0_samples) if x0_samples else page_w * 0.1
            median_size = sorted(size_samples)[len(size_samples) // 2] if size_samples else 11.0
            folio_inserted_for_page = False

            for b in blocks:
                bx0, by0, bx1, by1 = b["bbox"]
                # Skip running header / page number footer
                raw_block_txt = clean_whitespace(
                    " ".join(sp.get("text", "") for ln in b.get("lines", []) for sp in ln.get("spans", []))
                )
                if not raw_block_txt:
                    continue
                if (by0 < page_h * 0.068 or by1 > page_h * 0.932) and len(raw_block_txt) < 85:
                    continue
                if re.fullmatch(r"[0-9ivxlcdmIVXLCDM]+", raw_block_txt):
                    continue

                # Build formatted lines from spans
                line_htmls = []
                max_span_size = 0.0
                first_line_x0 = bx0
                for l_idx, ln in enumerate(b.get("lines", [])):
                    if l_idx == 0:
                        first_line_x0 = ln["bbox"][0]
                    sp_parts = []
                    for sp in ln.get("spans", []):
                        txt = sp.get("text", "")
                        if not txt:
                            continue
                        sz = sp.get("size", median_size)
                        max_span_size = max(max_span_size, sz)
                        flags = sp.get("flags", 0)
                        font_lower = (sp.get("font") or "").lower()
                        escaped = html.escape(txt)

                        # Superscript note reference inside prose
                        is_super = (flags & 1) or (sz < median_size * 0.76 and txt.strip().isdigit())
                        if is_super and txt.strip().isdigit() and len(txt.strip()) <= 3:
                            sp_parts.append(escaped)
                            continue

                        is_italic = bool(flags & 2) or "italic" in font_lower or "oblique" in font_lower
                        is_bold = bool(flags & 16) or "bold" in font_lower
                        if is_bold and is_italic:
                            escaped = f"<strong><em>{escaped}</em></strong>"
                        elif is_italic:
                            escaped = f"<em>{escaped}</em>"
                        elif is_bold and sz <= median_size * 1.15:
                            escaped = f"<strong>{escaped}</strong>"
                        sp_parts.append(escaped)

                    ln_joined = "".join(sp_parts).strip()
                    if ln_joined:
                        line_htmls.append(ln_joined)

                if not line_htmls:
                    continue

                # Join soft-wrapped lines, healing end-of-line hyphenation
                merged = line_htmls[0]
                for nxt in line_htmls[1:]:
                    if merged.endswith("-") and nxt and nxt[0].islower():
                        merged = merged[:-1] + nxt
                    else:
                        merged = merged + " " + nxt
                merged = re.sub(r"\s+", " ", merged).strip()
                plain_merged = strip_tags(merged)
                if not plain_merged:
                    continue

                # Skip duplicate chapter title on opening page of chapter
                if pg_1 == start_pg and len(paragraphs) == 0 and len(plain_merged) < 120:
                    if plain_merged.lower() in ch_raw_title.lower() or re.match(r"^(chapter|part)\s+[0-9ivxlcdm]+\b", plain_merged, re.I):
                        if len(plain_merged.split()) <= 14:
                            continue

                # Detect subheading vs blockquote vs normal paragraph
                is_subhead = (
                    max_span_size >= median_size * 1.18
                    and len(plain_merged) < 110
                    and not plain_merged.endswith(".")
                )
                is_blockquote = (not is_subhead) and (bx0 > base_x0 + 18) and (median_size - max_span_size >= -0.5)

                folio_tag = ""
                if not folio_inserted_for_page:
                    folio_tag = f'<span class="folio-marker" data-page="{pg_1}" title="Page {pg_1}">p. {pg_1}</span>'
                    folio_inserted_for_page = True

                if is_subhead:
                    if carry_para:
                        paragraphs.append(carry_para)
                        carry_para = None
                    paragraphs.append({
                        "type": "subhead",
                        "html": html.escape(plain_merged),
                        "page": pg_1,
                    })
                    continue

                b_type = "blockquote" if is_blockquote else "p"

                # Merge paragraph broken across page boundary if previous paragraph didn't end sentence
                if (
                    carry_para
                    and carry_para["type"] == b_type
                    and not re.search(r'[.!?”"\')\]—]$', strip_tags(carry_para["html"]))
                    and plain_merged[0].islower()
                ):
                    carry_para["html"] = carry_para["html"] + " " + folio_tag + merged
                else:
                    if carry_para:
                        paragraphs.append(carry_para)
                    carry_para = {
                        "type": b_type,
                        "html": folio_tag + merged,
                        "page": pg_1,
                    }

        if carry_para:
            paragraphs.append(carry_para)

        word_cnt = sum(count_words(p["html"]) for p in paragraphs)
        if word_cnt < 25 and len(chapter_ranges) > 1:
            continue

        ch_num = len(chapters) + 1
        ch_label = chapter_word_label(ch_num)
        clean_title = ch_raw_title
        m_head = re.match(
            r"^(chapter|part|section)\s+([0-9ivxlcdm]+|[a-z-]+)\s*[:.\-–—]+\s*(.+)$",
            ch_raw_title,
            re.I,
        )
        if m_head:
            ch_label = f"{m_head.group(1).title()} {m_head.group(2)}"
            clean_title = m_head.group(3).strip()

        chapters.append({
            "slug": f"chapter-{ch_num}",
            "num": ch_num,
            "chapterLabel": ch_label,
            "title": clean_title or ch_label,
            "shortTitle": make_short_title(clean_title, ch_label),
            "folioStart": start_pg,
            "folioEnd": end_pg,
            "wordCount": word_cnt,
            "paragraphs": paragraphs,
            "endnotes": ch_notes,
        })

    if not raw_title:
        # Try extracting title from page 1 largest text
        try:
            p0 = doc[0].get_text("dict")
            best = ("", 0.0)
            for b in p0.get("blocks", []):
                if b.get("type") != 0:
                    continue
                t = clean_whitespace(" ".join(sp.get("text", "") for ln in b.get("lines", []) for sp in ln.get("spans", [])))
                sz = max((sp.get("size", 0.0) for ln in b.get("lines", []) for sp in ln.get("spans", [])), default=0.0)
                if 2 <= len(t) <= 120 and sz > best[1]:
                    best = (t, sz)
            raw_title = best[0]
        except Exception:
            pass

    if not raw_title:
        raw_title = os.path.splitext(os.path.basename(pdf_path))[0].replace("_", " ").replace("-", " ").title()

    subtitle = ""
    if ":" in raw_title:
        parts = raw_title.split(":", 1)
        raw_title = parts[0].strip()
        subtitle = parts[1].strip()

    doc.close()
    return {
        "sourceFormat": "pdf",
        "title": raw_title,
        "subtitle": subtitle,
        "author": author or "Uploaded Edition",
        "publisherMeta": "PDF DIGITAL EDITION",
        "pubDate": pub_date,
        "totalPages": total_pages,
        "wordCount": sum(c["wordCount"] for c in chapters),
        "chapters": chapters,
    }


def extract_html_document(html_path: str) -> dict:
    with open(html_path, "rb") as f:
        raw_html = f.read().decode("utf-8", errors="replace")

    title_m = re.search(r"<title[^>]*>(.*?)</title>", raw_html, re.I | re.S)
    raw_title = strip_tags(title_m.group(1)) if title_m else ""
    author_m = re.search(
        r'<meta[^>]+name=["\'](?:author|dc\.creator|dcterms\.creator)["\'][^>]+content=["\']([^"\']+)["\']',
        raw_html,
        re.I,
    )
    author = clean_whitespace(author_m.group(1)) if author_m else "Web Edition"

    # Split into chapters if multiple <h1>/<h2> chapter headings exist, else single chapter
    parser = EpubXHTMLConverter()
    parser.feed(raw_html)
    parser._flush_block()

    if not parser.blocks:
        raise ValueError("No readable article or book text found at that URL.")

    grouped = []
    current_title = parser.first_heading or raw_title or "Chapter 1"
    current_blocks = []

    for b in parser.blocks:
        if (
            b["type"] == "subhead"
            and re.match(r"^(chapter|part|book|lecture|act)\s+([0-9ivxlcdm]+|[a-z-]+)\b", b["html"], re.I)
            and sum(count_words(x["html"]) for x in current_blocks) >= 180
        ):
            grouped.append((current_title, current_blocks))
            current_title = b["html"]
            current_blocks = []
        else:
            current_blocks.append(b)
    if current_blocks:
        grouped.append((current_title, current_blocks))

    chapters = []
    synthetic_page = 1
    for idx, (ch_t, blks) in enumerate(grouped):
        ch_num = idx + 1
        ch_start = synthetic_page
        words_on_page = 0
        paragraphs = []
        for b_idx, b in enumerate(blks):
            b_html = re.sub(r"\[\[(?:NOTEREF|FOLIO):[^\]]+\]\]", "", b["html"]).strip()
            if not strip_tags(b_html):
                continue
            w_cnt = count_words(b_html)
            words_on_page += w_cnt
            if b_idx == 0 or words_on_page >= 310:
                if b_idx > 0:
                    synthetic_page += max(1, words_on_page // 310)
                    words_on_page = words_on_page % 310
                if b["type"] == "p":
                    b_html = (
                        f'<span class="folio-marker" data-page="{synthetic_page}" '
                        f'title="Page {synthetic_page}">p. {synthetic_page}</span>' + b_html
                    )
            paragraphs.append({"type": b["type"], "html": b_html, "page": synthetic_page})

        if not paragraphs:
            continue
        ch_end = max(ch_start, synthetic_page)
        synthetic_page = ch_end + 1
        ch_label = chapter_word_label(ch_num)
        clean_t = clean_whitespace(ch_t)
        chapters.append({
            "slug": f"chapter-{ch_num}",
            "num": ch_num,
            "chapterLabel": ch_label,
            "title": clean_t or ch_label,
            "shortTitle": make_short_title(clean_t, ch_label),
            "folioStart": ch_start,
            "folioEnd": ch_end,
            "wordCount": sum(count_words(p["html"]) for p in paragraphs),
            "paragraphs": paragraphs,
            "endnotes": [],
        })

    if not chapters or sum(c["wordCount"] for c in chapters) < 40:
        raise ValueError("The linked web page did not contain enough readable text to build a book edition.")

    if not raw_title:
        raw_title = chapters[0]["title"]
    subtitle = ""
    if ":" in raw_title:
        parts = raw_title.split(":", 1)
        raw_title, subtitle = parts[0].strip(), parts[1].strip()

    return {
        "sourceFormat": "web",
        "title": raw_title,
        "subtitle": subtitle,
        "author": author,
        "publisherMeta": "WEB LINK EDITION",
        "pubDate": "",
        "totalPages": max(1, synthetic_page - 1),
        "wordCount": sum(c["wordCount"] for c in chapters),
        "chapters": chapters,
    }


def main():
    if len(sys.argv) < 3:
        print("Usage: extract_book.py <input.epub|input.pdf|input.html> <output.json>", file=sys.stderr)
        sys.exit(1)

    in_path = sys.argv[1]
    out_path = sys.argv[2]
    ext = os.path.splitext(in_path)[1].lower()

    if ext == ".epub":
        try:
            result = extract_epub_native(in_path)
        except Exception as epub_err:
            if fitz is not None:
                result = extract_pdf_with_fitz(in_path)
                result["sourceFormat"] = "epub"
            else:
                raise epub_err
    elif ext == ".pdf":
        result = extract_pdf_with_fitz(in_path)
    elif ext in (".html", ".htm", ".xhtml"):
        result = extract_html_document(in_path)
    else:
        raise ValueError(f"Unsupported file extension: {ext}. Please provide an .epub, .pdf, or readable web URL.")

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(
        json.dumps({
            "ok": True,
            "title": result["title"],
            "chapters": len(result["chapters"]),
            "words": result["wordCount"],
        })
    )


if __name__ == "__main__":
    main()
