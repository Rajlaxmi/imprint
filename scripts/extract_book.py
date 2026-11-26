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
    INLINE_PASSTHROUGH = {"sub", "sup", "code"}
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
        self._in_figure = False
        self._figure_id = ""
        self._figure_img_src = ""
        self._figure_img_alt = ""
        self._figure_cap_buf = []
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
        elif self._in_figure:
            self._figure_cap_buf.append(s)
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

        if tag == "figure":
            self._flush_block()
            self._in_figure = True
            self._figure_id = elem_id
            self._figure_img_src = ""
            self._figure_img_alt = ""
            self._figure_cap_buf = []
            return

        if tag == "img":
            src = (attr_map.get("src") or "").strip()
            alt = clean_whitespace(attr_map.get("alt") or "")
            role = (attr_map.get("role") or "").lower()
            if not src or role == "doc-cover" or re.search(r"(^|/)cover\.(jpg|jpeg|png|webp)$", src, re.I):
                return
            if self._in_figure:
                if not self._figure_img_src:
                    self._figure_img_src = src
                    self._figure_img_alt = alt
            else:
                self._flush_block()
                self.blocks.append({
                    "type": "figure",
                    "raw_src": src,
                    "caption": alt,
                    "html": html.escape(alt),
                    "id": elem_id,
                })
            return

        if self._in_figure:
            if tag == "br":
                self._push_buf(" ")
            elif tag == "span":
                if "pagebreak" in epub_type or "doc-pagebreak" in epub_type:
                    pg = attr_map.get("title") or attr_map.get("aria-label") or ""
                    pg_num = re.sub(r"[^0-9ivxlcdmIVXLCDM]", "", pg)
                    if pg_num:
                        self._push_buf(f"[[FOLIO:{pg_num}]]")
            elif tag in self.INLINE_EM:
                self._inline_stack.append("em")
                self._push_buf("<em>")
            elif tag in self.INLINE_STRONG:
                self._inline_stack.append("strong")
                self._push_buf("<strong>")
            elif tag in self.INLINE_PASSTHROUGH:
                self._inline_stack.append(tag)
                self._push_buf(f"<{tag}>")
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
        elif tag in self.INLINE_PASSTHROUGH:
            self._inline_stack.append(tag)
            self._push_buf(f"<{tag}>")
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
            elif href.startswith(("http://", "https://")):
                safe_href = html.escape(href, quote=True)
                self._inline_stack.append(("extlink", safe_href))
                self._push_buf(f'<a href="{safe_href}" target="_blank" rel="noopener noreferrer" class="prose-link">')
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

        if tag == "figure" and self._in_figure:
            raw_cap = re.sub(r"\s+", " ", "".join(self._figure_cap_buf)).strip()
            if self._figure_img_src:
                plain_cap = strip_tags(re.sub(r"\[\[(?:FOLIO|NOTEREF):[^\]]+\]\]", "", raw_cap)) or self._figure_img_alt
                self.blocks.append({
                    "type": "figure",
                    "raw_src": self._figure_img_src,
                    "caption": plain_cap,
                    "html": raw_cap,
                    "id": self._figure_id,
                })
            self._in_figure = False
            self._figure_id = ""
            self._figure_img_src = ""
            self._figure_img_alt = ""
            self._figure_cap_buf = []
            self._inline_stack.clear()
            return

        if self._in_figure:
            if tag in self.INLINE_EM and self._inline_stack and self._inline_stack[-1] == "em":
                self._inline_stack.pop()
                self._push_buf("</em>")
            elif tag in self.INLINE_STRONG and self._inline_stack and self._inline_stack[-1] == "strong":
                self._inline_stack.pop()
                self._push_buf("</strong>")
            elif tag in self.INLINE_PASSTHROUGH and self._inline_stack and self._inline_stack[-1] == tag:
                self._inline_stack.pop()
                self._push_buf(f"</{tag}>")
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
        elif tag in self.INLINE_PASSTHROUGH:
            if self._inline_stack and self._inline_stack[-1] == tag:
                self._inline_stack.pop()
                self._push_buf(f"</{tag}>")
        elif tag == "a":
            if self._inline_stack and isinstance(self._inline_stack[-1], tuple):
                kind, _ = self._inline_stack.pop()
                if kind == "noteref":
                    self._push_buf("]]")
                elif kind == "extlink":
                    self._push_buf("</a>")

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


def extract_epub_native(epub_path: str, out_dir: str = None) -> dict:
    book_id = os.path.basename(os.path.abspath(out_dir)) if out_dir else ""
    figures_dir = os.path.join(out_dir, "figures") if out_dir else ""
    fig_url_prefix = f"/api/books/{book_id}/figures" if book_id.startswith("book_") else "figures"

    with zipfile.ZipFile(epub_path, "r") as zf:
        namelist_set = set(zf.namelist())
        namelist_lower = {n.lower(): n for n in zf.namelist()}
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
                b["doc_path"] = sp_path
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

                if b["type"] == "figure":
                    raw_src = (b.get("raw_src") or "").strip()
                    if not raw_src:
                        continue
                    src_url = ""
                    if raw_src.startswith(("http://", "https://")):
                        src_url = raw_src
                    elif figures_dir:
                        doc_base = posixpath.dirname(b.get("doc_path") or ch["path"])
                        clean_rel, _ = urldefrag(unquote(raw_src))
                        cand = posixpath.normpath(posixpath.join(doc_base, clean_rel)) if doc_base else posixpath.normpath(clean_rel)
                        zip_entry = cand if cand in namelist_set else namelist_lower.get(cand.lower(), "")
                        if zip_entry:
                            os.makedirs(figures_dir, exist_ok=True)
                            base_name = re.sub(r"[^a-zA-Z0-9_.-]", "_", posixpath.basename(zip_entry))
                            out_path_img = os.path.join(figures_dir, base_name)
                            if not os.path.exists(out_path_img):
                                with open(out_path_img, "wb") as img_f:
                                    img_f.write(zf.read(zip_entry))
                            src_url = f"{fig_url_prefix}/{base_name}"
                    if src_url:
                        cap_clean = clean_whitespace(b.get("caption") or "")
                        paragraphs.append({
                            "type": "figure",
                            "src": src_url,
                            "caption": cap_clean,
                            "html": html.escape(cap_clean),
                            "page": synthetic_page,
                        })
                    continue

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
                "wordCount": sum(count_words(p.get("html", "")) for p in paragraphs if p.get("type") != "figure"),
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
# PDF Extractor via PyMuPDF (fitz) — Main Content Isolation + Inline Figures
# ============================================================================

PDF_PRINT_HEADER_RE = re.compile(
    r"^(\d{1,2}/\d{1,2}/\d{2,4},?\s+\d{1,2}:\d{2}\s*(AM|PM)\b|https?://\S+\s+\d+\s*/\s*\d+$)",
    re.I,
)

PDF_SOCIAL_WIDGET_RE = re.compile(
    r"^(\d+(\s+\d+)*(\s*(Share|Likes?|Restacks?|Comments?))?|Share|Restack|Subscribe|Listen|Paid|Free)$",
    re.I,
)

PDF_DATE_BYLINE_RE = re.compile(
    r"^((?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s+\d{1,2},?\s+20\d{2})(?:\s*[∙·•|\-–—]\s*(?:PAID|FREE|SUBSCRIBER[S\s]*ONLY|\d+\s*MIN\s*READ))?$",
    re.I,
)

PDF_TAIL_CUTOFF_RE = re.compile(
    r"^("
    r"Recommend\s+.+\s+to\s+your\s+readers\b|"
    r"Discussion\s+about\s+this\s+post\b|"
    r"Comments\s+Restacks\b|"
    r"Write\s+a\s+comment\.{2,}|"
    r"\d+\s+Likes?\s*[∙·•]\s*\d+\s+Restacks?\b|"
    r"Leave\s+a\s+(?:comment|reply)\b|"
    r"Ready\s+for\s+more\?|"
    r"Substack\s+is\s+the\s+home\s+for\s+writing\b|"
    r"©\s*(?:19|20)\d{2}\b.*(?:Privacy|Terms|Collection\s+notice)"
    r")",
    re.I,
)

PDF_CAPTION_PREFIX_RE = re.compile(
    r"^(Source|Sources|Figure|Fig\.|Chart|Exhibit|Table|Note|Notes|Credit|Image)s?\s*[:\-–—]",
    re.I,
)


def _save_pdf_xref_image(doc, xref: int, figures_dir: str, out_stem: str) -> tuple:
    """Extracts an image xref from PyMuPDF doc into figures_dir, handling alpha smasks cleanly."""
    try:
        info = doc.extract_image(xref)
        if not info or not info.get("image"):
            return ("", 0, 0)
        w = int(info.get("width") or 0)
        h = int(info.get("height") or 0)
        smask = int(info.get("smask") or 0)
        os.makedirs(figures_dir, exist_ok=True)

        if smask > 0:
            pix0 = fitz.Pixmap(doc, xref)
            mask = fitz.Pixmap(doc, smask)
            if pix0.alpha:
                pix0 = fitz.Pixmap(pix0, 0)
            pix = fitz.Pixmap(pix0, mask)
            fname = f"{out_stem}.png"
            pix.save(os.path.join(figures_dir, fname))
            return (fname, pix.width, pix.height)

        ext = (info.get("ext") or "png").lower()
        if ext == "jpeg":
            ext = "jpg"
        if ext not in ("png", "jpg", "webp"):
            pix = fitz.Pixmap(doc, xref)
            if pix.n - pix.alpha > 3:
                pix = fitz.Pixmap(fitz.csRGB, pix)
            fname = f"{out_stem}.png"
            pix.save(os.path.join(figures_dir, fname))
            return (fname, pix.width, pix.height)

        fname = f"{out_stem}.{ext}"
        with open(os.path.join(figures_dir, fname), "wb") as f:
            f.write(info["image"])
        return (fname, w, h)
    except Exception:
        return ("", 0, 0)


def _find_link_for_span_bbox(span_bbox, page_links: list) -> str:
    sx0, sy0, sx1, sy1 = span_bbox
    scx = (sx0 + sx1) * 0.5
    scy = (sy0 + sy1) * 0.5
    for r, uri in page_links:
        if r.x0 - 2 <= scx <= r.x1 + 2 and r.y0 - 2 <= scy <= r.y1 + 2:
            return uri
    return ""


def extract_pdf_with_fitz(pdf_path: str, out_dir: str = None) -> dict:
    if fitz is None:
        raise RuntimeError("PyMuPDF (fitz) is required for PDF extraction.")

    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    if total_pages == 0:
        raise ValueError("Uploaded PDF has 0 pages.")

    book_id = os.path.basename(os.path.abspath(out_dir)) if out_dir else ""
    figures_dir = os.path.join(out_dir, "figures") if out_dir else ""
    fig_url_prefix = f"/api/books/{book_id}/figures" if book_id.startswith("book_") else "figures"

    meta = doc.metadata or {}
    raw_title = clean_whitespace(meta.get("title") or "")
    author = clean_whitespace(meta.get("author") or "")
    subtitle_detected = ""
    publisher_detected = ""
    detected_source_url = ""
    pub_date = ""
    cdate = meta.get("creationDate") or ""
    m_yr = re.search(r"(19|20)\d{2}", cdate)
    if m_yr:
        pub_date = m_yr.group(0)

    # Determine chapter ranges [(title, start_page_1based, end_page_1based)]
    toc = doc.get_toc() or []
    chapter_ranges = []

    if toc:
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
                filtered[-1] = (f"{filtered[-1][0]} — {t_clean}", pg)
            else:
                filtered.append((t_clean, pg))

        for i, (t_clean, start_pg) in enumerate(filtered):
            if start_pg >= notes_start_page:
                continue
            next_pg = filtered[i + 1][1] - 1 if i + 1 < len(filtered) else min(total_pages, notes_start_page - 1)
            end_pg = max(start_pg, min(next_pg, notes_start_page - 1))
            chapter_ranges.append((t_clean, start_pg, end_pg))

    # Fallback 2: Scan pages for prominent "Chapter X" headings
    if not chapter_ranges:
        detected = []
        heading_re = re.compile(
            r"^(chapter|part|section|lecture|essay)\s+([0-9ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b[:.\-–—\s]*(.*)$",
            re.I,
        )
        for pno in range(total_pages):
            page = doc[pno]
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

    # Fallback 3: Chunk by ~14 pages (or single chapter if <= 18 pages)
    if not chapter_ranges:
        if total_pages <= 18:
            chapter_ranges = [(raw_title or "Complete Text", 1, total_pages)]
        else:
            chunk = 14
            part_num = 1
            for start_pg in range(1, total_pages + 1, chunk):
                end_pg = min(total_pages, start_pg + chunk - 1)
                chapter_ranges.append((f"Part {part_num} (pp. {start_pg}–{end_pg})", start_pg, end_pg))
                part_num += 1

            if not raw_title:
                # Re-check with proper span concatenation
                pass

    # Detect page 1 title size cleanly with joined spans
    if not meta.get("title"):
        try:
            p0 = doc[0].get_text("dict")
            best = ("", 0.0)
            for b in p0.get("blocks", []):
                if b.get("type") != 0 or b["bbox"][1] < 32:
                    continue
                t = clean_whitespace(" ".join("".join(sp.get("text", "") for sp in ln.get("spans", [])) for ln in b.get("lines", [])))
                sz = max((sp.get("size", 0.0) for ln in b.get("lines", []) for sp in ln.get("spans", [])), default=0.0)
                if 2 <= len(t) <= 140 and sz > best[1]:
                    best = (t, sz)
            if best[0]:
                raw_title = best[0]
                if len(chapter_ranges) == 1:
                    chapter_ranges[0] = (raw_title, chapter_ranges[0][1], chapter_ranges[0][2])
        except Exception:
            pass

    chapters = []
    hit_article_end = False
    max_content_page = 1

    for idx, (ch_raw_title, start_pg, end_pg) in enumerate(chapter_ranges):
        if hit_article_end:
            break
        paragraphs = []
        ch_notes = []
        carry_para = None  # {"type": "p"|"blockquote", "html": str, "page": int, "by1": float, "pg": int}
        ch_last_page = start_pg

        for pg_1 in range(start_pg, end_pg + 1):
            if hit_article_end:
                break
            page = doc[pg_1 - 1]
            rect = page.rect
            page_h = rect.height or 792.0
            page_w = rect.width or 612.0
            pdict = page.get_text("dict")
            raw_blocks = [b for b in pdict.get("blocks", []) if b.get("type") == 0]

            # Collect clickable external links on this page
            page_links = []
            for lnk in page.get_links() or []:
                uri = (lnk.get("uri") or "").strip()
                from_rect = lnk.get("from")
                if uri.startswith(("http://", "https://")) and from_rect is not None:
                    if "substack.com/@" in uri or "substackcdn.com/image/" in uri:
                        continue
                    page_links.append((from_rect, uri))

            # Harvest sourceUrl from Print-to-PDF running footers before filtering margin chrome
            for b in raw_blocks:
                bx0, by0, bx1, by1 = b["bbox"]
                if by0 > page_h * 0.93 or by1 > page_h * 0.948:
                    ftxt = clean_whitespace(
                        " ".join("".join(sp.get("text", "") for sp in ln.get("spans", [])) for ln in b.get("lines", []))
                    )
                    if not detected_source_url:
                        m_url = re.search(r"https?://[^\s<>\"']+", ftxt)
                        if m_url:
                            candidate = m_url.group(0).rstrip(".,;)")
                            detected_source_url = candidate
                            try:
                                host = re.sub(r"^www\.", "", candidate.split("/")[2]).lower()
                                if "semianalysis" in host:
                                    publisher_detected = "SEMIANALYSIS"
                                elif not publisher_detected:
                                    publisher_detected = host.split(".")[0].upper()
                            except Exception:
                                pass

            # Filter out top/bottom running headers & footers, then sort visually by (y0, x0)
            blocks = []
            for b in raw_blocks:
                bx0, by0, bx1, by1 = b["bbox"]
                if by0 < page_h * 0.048 or by0 > page_h * 0.935 or by1 > page_h * 0.952:
                    continue
                blocks.append(b)
            blocks.sort(key=lambda b: (round(b["bbox"][1], 1), round(b["bbox"][0], 1)))

            # Estimate typical left margin, median font size, and line height on this page
            x0_samples = []
            size_samples = []
            lh_samples = []
            for b in blocks:
                for ln in b.get("lines", []):
                    x0_samples.append(ln["bbox"][0])
                    lh = ln["bbox"][3] - ln["bbox"][1]
                    if 8 <= lh <= 34:
                        lh_samples.append(lh)
                    for sp in ln.get("spans", []):
                        if sp.get("text", "").strip():
                            size_samples.append(sp.get("size", 11.0))

            base_x0 = min(x0_samples) if x0_samples else page_w * 0.075
            median_size = sorted(size_samples)[len(size_samples) // 2] if size_samples else 11.5
            median_lh = sorted(lh_samples)[len(lh_samples) // 2] if lh_samples else 18.0

            # Collect valid inline figures on this page (excluding small icons/avatars)
            page_figures = []
            if figures_dir:
                seen_fig_keys = set()
                fig_seq = 0
                for im in page.get_image_info(xrefs=True) or []:
                    xref = int(im.get("xref") or 0)
                    bx = im.get("bbox") or (0, 0, 0, 0)
                    bw = bx[2] - bx[0]
                    bh = bx[3] - bx[1]
                    iw = int(im.get("width") or 0)
                    ih = int(im.get("height") or 0)
                    if xref <= 0 or bw < 150 or bh < 65 or iw < 260 or ih < 110:
                        continue
                    if bx[1] < page_h * 0.04 or bx[1] > page_h * 0.93:
                        continue
                    dedup_key = (xref, int(round(bx[1] / 8.0)))
                    if dedup_key in seen_fig_keys:
                        continue
                    seen_fig_keys.add(dedup_key)
                    fig_seq += 1
                    page_figures.append({
                        "kind": "figure",
                        "y0": bx[1],
                        "x0": bx[0],
                        "y1": bx[3],
                        "x1": bx[2],
                        "xref": xref,
                        "seq": fig_seq,
                    })
                page_figures.sort(key=lambda f: (round(f["y0"], 1), round(f["x0"], 1)))

            # Build unified visual-order stream of text blocks + figures on this page
            parsed_text_items = []
            prose_started_on_page1 = len(paragraphs) > 0 or carry_para is not None
            for b in blocks:
                bx0, by0, bx1, by1 = b["bbox"]
                raw_block_txt = clean_whitespace(
                    " ".join("".join(sp.get("text", "") for sp in ln.get("spans", [])) for ln in b.get("lines", []))
                )
                if not raw_block_txt:
                    continue
                if PDF_PRINT_HEADER_RE.search(raw_block_txt):
                    continue
                if re.fullmatch(r"[0-9ivxlcdmIVXLCDM]+", raw_block_txt):
                    continue

                # Check end-of-article cutoff (Substack comments, recommendations, legal footer)
                if PDF_TAIL_CUTOFF_RE.search(raw_block_txt) and (pg_1 >= 2 or prose_started_on_page1):
                    hit_article_end = True
                    # Discard any figures situated at or below the cutoff y0 on this page
                    page_figures = [fg for fg in page_figures if fg["y1"] <= by0]
                    break

                # Opening page masthead & social bar cleanup before first prose paragraph
                if pg_1 == start_pg and not prose_started_on_page1 and by0 < page_h * 0.36:
                    max_sz_top = max(
                        (sp.get("size", median_size) for ln in b.get("lines", []) for sp in ln.get("spans", [])),
                        default=median_size,
                    )
                    # Skip main article title block on page 1
                    if max_sz_top >= median_size * 1.45 or (
                        raw_title and raw_block_txt.lower().startswith(raw_title.lower()[:24])
                    ):
                        continue
                    # Capture deck / subtitle directly below title
                    if (
                        not subtitle_detected
                        and by0 < page_h * 0.24
                        and len(raw_block_txt) <= 180
                        and not raw_block_txt.endswith(".")
                        and not PDF_DATE_BYLINE_RE.match(raw_block_txt)
                        and not PDF_SOCIAL_WIDGET_RE.match(raw_block_txt)
                        and not re.fullmatch(r"[A-Z][A-Z\s,.'&\-]+", raw_block_txt)
                    ):
                        subtitle_detected = raw_block_txt
                        continue
                    # Capture all-caps author byline
                    if (
                        re.fullmatch(r"[A-Z][A-Z\s,.'&\-]{5,95}", raw_block_txt)
                        and not PDF_DATE_BYLINE_RE.match(raw_block_txt)
                        and not PDF_SOCIAL_WIDGET_RE.match(raw_block_txt)
                    ):
                        if not author or author == "Uploaded Edition":
                            author = re.sub(r",\s*,+", ",", raw_block_txt.title().replace(" And ", " & "))
                        continue
                    # Capture date / PAID badge line
                    m_dt = PDF_DATE_BYLINE_RE.match(raw_block_txt)
                    if m_dt:
                        pub_date = m_dt.group(1).upper()
                        continue
                    # Skip social like/comment/share counters
                    if PDF_SOCIAL_WIDGET_RE.match(raw_block_txt):
                        continue

                if PDF_SOCIAL_WIDGET_RE.match(raw_block_txt) and len(raw_block_txt) <= 24:
                    continue

                # Format spans + inline hyperlinks
                line_htmls = []
                max_span_size = 0.0
                for ln in b.get("lines", []):
                    sp_parts = []
                    cur_link_uri = ""
                    link_buf = []

                    def flush_link():
                        nonlocal cur_link_uri, link_buf
                        if not link_buf:
                            return
                        inner_h = "".join(link_buf)
                        if cur_link_uri:
                            safe_u = html.escape(cur_link_uri, quote=True)
                            sp_parts.append(
                                f'<a href="{safe_u}" target="_blank" rel="noopener noreferrer" class="prose-link">{inner_h}</a>'
                            )
                        else:
                            sp_parts.append(inner_h)
                        cur_link_uri = ""
                        link_buf = []

                    for sp in ln.get("spans", []):
                        txt = sp.get("text", "")
                        if not txt:
                            continue
                        sz = sp.get("size", median_size)
                        max_span_size = max(max_span_size, sz)
                        flags = sp.get("flags", 0)
                        font_lower = (sp.get("font") or "").lower()
                        escaped = html.escape(txt)

                        is_italic = bool(flags & 2) or "italic" in font_lower or "oblique" in font_lower
                        is_bold = bool(flags & 16) or "bold" in font_lower
                        if is_bold and is_italic:
                            escaped = f"<strong><em>{escaped}</em></strong>"
                        elif is_italic:
                            escaped = f"<em>{escaped}</em>"
                        elif is_bold and sz <= median_size * 1.15:
                            escaped = f"<strong>{escaped}</strong>"

                        span_uri = _find_link_for_span_bbox(sp.get("bbox", b["bbox"]), page_links) if txt.strip() else cur_link_uri
                        if span_uri != cur_link_uri:
                            flush_link()
                            cur_link_uri = span_uri
                        link_buf.append(escaped)

                    flush_link()
                    ln_joined = "".join(sp_parts).strip()
                    if ln_joined:
                        line_htmls.append(ln_joined)

                if not line_htmls:
                    continue

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

                prose_started_on_page1 = True
                parsed_text_items.append({
                    "kind": "text",
                    "y0": by0,
                    "x0": bx0,
                    "y1": by1,
                    "x1": bx1,
                    "html": merged,
                    "plain": plain_merged,
                    "max_size": max_span_size,
                })

            # Attach figure captions directly below each figure before merging
            consumed_text_indices = set()
            materialized_figures = []
            for fg in page_figures:
                fname, fw, fh = _save_pdf_xref_image(
                    doc, fg["xref"], figures_dir, f"fig_p{pg_1}_{fg['seq']}"
                )
                if not fname:
                    continue
                caption_txt = ""
                for t_idx, ti in enumerate(parsed_text_items):
                    if t_idx in consumed_text_indices:
                        continue
                    gap = ti["y0"] - fg["y1"]
                    if -4 <= gap <= 28 and len(ti["plain"]) <= 185:
                        if ti["x0"] > base_x0 + 22 or PDF_CAPTION_PREFIX_RE.match(ti["plain"]):
                            caption_txt = ti["plain"]
                            consumed_text_indices.add(t_idx)
                            break
                materialized_figures.append({
                    "kind": "figure",
                    "y0": fg["y0"],
                    "x0": fg["x0"],
                    "y1": fg["y1"],
                    "src": f"{fig_url_prefix}/{fname}",
                    "caption": caption_txt,
                    "width": fw,
                    "height": fh,
                    "page": pg_1,
                })

            remaining_texts = [
                ti for idx_t, ti in enumerate(parsed_text_items) if idx_t not in consumed_text_indices
            ]
            combined_stream = sorted(
                remaining_texts + materialized_figures,
                key=lambda item: (round(item["y0"], 1), round(item["x0"], 1)),
            )

            # If a previous page ended mid-sentence AND this page starts with a top floating figure
            # followed immediately by the lowercase sentence continuation, let the sentence finish first!
            if (
                carry_para
                and len(combined_stream) >= 2
                and combined_stream[0]["kind"] == "figure"
                and combined_stream[1]["kind"] == "text"
                and not re.search(r'[.!?”"\')\]—:]$', strip_tags(carry_para["html"]))
                and combined_stream[1]["plain"][0].islower()
            ):
                combined_stream[0], combined_stream[1] = combined_stream[1], combined_stream[0]

            if combined_stream:
                ch_last_page = max(ch_last_page, pg_1)
                max_content_page = max(max_content_page, pg_1)

            folio_inserted_for_page = False

            for item in combined_stream:
                if item["kind"] == "figure":
                    if carry_para:
                        paragraphs.append({
                            "type": carry_para["type"],
                            "html": carry_para["html"],
                            "page": carry_para["page"],
                        })
                        carry_para = None
                    paragraphs.append({
                        "type": "figure",
                        "src": item["src"],
                        "caption": item["caption"],
                        "width": item["width"],
                        "height": item["height"],
                        "html": html.escape(item["caption"] or ""),
                        "page": pg_1,
                    })
                    continue

                plain_merged = item["plain"]
                merged = item["html"]
                max_span_size = item["max_size"]
                bx0, by0, by1 = item["x0"], item["y0"], item["y1"]

                is_subhead = (
                    max_span_size >= median_size * 1.13
                    and len(plain_merged) < 130
                    and not plain_merged.endswith(".")
                )
                is_bullet = bool(re.match(r"^[-•▪◦]\s+", plain_merged))
                is_blockquote = (
                    not is_subhead
                    and not is_bullet
                    and (bx0 > base_x0 + 20)
                    and (median_size - max_span_size >= -0.5)
                )

                folio_tag = ""
                if not folio_inserted_for_page:
                    folio_tag = f'<span class="folio-marker" data-page="{pg_1}" title="Page {pg_1}">p. {pg_1}</span>'
                    folio_inserted_for_page = True

                if is_subhead:
                    if carry_para:
                        paragraphs.append({
                            "type": carry_para["type"],
                            "html": carry_para["html"],
                            "page": carry_para["page"],
                        })
                        carry_para = None
                    paragraphs.append({
                        "type": "subhead",
                        "html": html.escape(plain_merged),
                        "page": pg_1,
                    })
                    continue

                b_type = "blockquote" if is_blockquote else "p"

                # Merge soft-wrapped lines within the same paragraph on the same page,
                # OR across page boundaries when the previous page ended mid-sentence!
                same_page_soft_wrap = (
                    carry_para is not None
                    and carry_para["pg"] == pg_1
                    and carry_para["type"] == b_type
                    and not is_bullet
                    and 0 <= (by0 - carry_para["by1"]) <= max(11.5, median_lh * 0.55)
                )
                cross_page_continuation = (
                    carry_para is not None
                    and carry_para["pg"] != pg_1
                    and carry_para["type"] == b_type
                    and not is_bullet
                    and not re.search(r'[.!?”"\')\]—:]$', strip_tags(carry_para["html"]))
                    and plain_merged[0].islower()
                )

                if same_page_soft_wrap or cross_page_continuation:
                    joiner = "" if carry_para["html"].endswith("-") and plain_merged[0].islower() else " "
                    if joiner == "":
                        carry_para["html"] = carry_para["html"][:-1] + folio_tag + merged
                    else:
                        carry_para["html"] = carry_para["html"] + " " + folio_tag + merged
                    carry_para["by1"] = by1
                    carry_para["pg"] = pg_1
                else:
                    if carry_para:
                        paragraphs.append({
                            "type": carry_para["type"],
                            "html": carry_para["html"],
                            "page": carry_para["page"],
                        })
                    carry_para = {
                        "type": b_type,
                        "html": folio_tag + merged,
                        "page": pg_1,
                        "by1": by1,
                        "pg": pg_1,
                    }

        if carry_para:
            paragraphs.append({
                "type": carry_para["type"],
                "html": carry_para["html"],
                "page": carry_para["page"],
            })

        word_cnt = sum(count_words(p.get("html", "")) for p in paragraphs if p.get("type") != "figure")
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
            "folioEnd": ch_last_page,
            "wordCount": word_cnt,
            "paragraphs": paragraphs,
            "endnotes": ch_notes,
        })

    if not raw_title:
        raw_title = os.path.splitext(os.path.basename(pdf_path))[0].replace("_", " ").replace("-", " ").title()

    subtitle = subtitle_detected
    if ":" in raw_title:
        parts = raw_title.split(":", 1)
        raw_title = parts[0].strip()
        if not subtitle:
            subtitle = parts[1].strip()
        else:
            raw_title = f"{parts[0].strip()}: {parts[1].strip()}"

    doc.close()
    return {
        "sourceFormat": "pdf",
        "sourceUrl": detected_source_url,
        "title": raw_title,
        "subtitle": subtitle,
        "author": author or "Uploaded Edition",
        "publisherMeta": publisher_detected or "PDF DIGITAL EDITION",
        "pubDate": pub_date,
        "totalPages": max_content_page if hit_article_end else total_pages,
        "wordCount": sum(c["wordCount"] for c in chapters),
        "chapters": chapters,
    }


# ============================================================================
# Readability-Grade Main Content Extractor for Web / Blog / Essay Links
# ============================================================================

VOID_HTML_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}

DROP_SUBTREE_TAGS = {
    "script", "style", "noscript", "svg", "iframe", "canvas", "form",
    "button", "input", "select", "textarea", "nav", "footer", "aside",
    "dialog", "menu",
}

NOISE_ATTR_RE = re.compile(
    r"(^|[\s_-])("
    r"comment|comments|commentlist|comment-list|respond|reply|replies|disqus|utterances|giscus|pingback|trackback|"
    r"sidebar|widget|widgets|blogroll|related|recommended|popular|trending|more-posts|"
    r"share|sharing|sharedaddy|social|robots-nocontent|snap_nopreview|"
    r"navbar|menubar|breadcrumbs|breadcrumb|pagination|pager|post-navigation|nav-links|navigation|"
    r"site-header|site-footer|masthead|headerimg|subfooter|colophon|"
    r"postmetadata|entry-meta|post-meta|entry-footer|post-footer|cat-links|tags-links|taxonomy|"
    r"newsletter|subscribe|paywall|promo|advert|ad-slot|sponsor|cookie|popup|modal|author-bio"
    r")($|[\s_-])",
    re.I,
)

BOILERPLATE_PARA_RE = re.compile(
    r"^(this entry was posted\b|posted in\b.*leave a comment|you can follow any responses to this entry|"
    r"leave a reply|comments are closed|subscribe to our newsletter|share this:)",
    re.I,
)


class DomNode:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag: str, attrs: dict, parent=None):
        self.tag = tag
        self.attrs = attrs
        self.children = []  # DomNode | str
        self.parent = parent

    def attr_tokens(self) -> str:
        return " ".join(
            filter(
                None,
                [
                    self.attrs.get("id", ""),
                    self.attrs.get("class", ""),
                    self.attrs.get("role", ""),
                    self.attrs.get("aria-label", ""),
                ],
            )
        )

    def text_content(self) -> str:
        out = []
        for ch in self.children:
            if isinstance(ch, str):
                out.append(ch)
            else:
                out.append(ch.text_content())
        return clean_whitespace(" ".join(out))

    def link_text_len(self) -> int:
        if self.tag == "a":
            return len(self.text_content())
        return sum(ch.link_text_len() for ch in self.children if isinstance(ch, DomNode))

    def iter_nodes(self):
        yield self
        for ch in self.children:
            if isinstance(ch, DomNode):
                yield from ch.iter_nodes()

    def to_html(self) -> str:
        if self.tag == "root":
            return "".join(ch if isinstance(ch, str) else ch.to_html() for ch in self.children)
        attrs_str = "".join(
            f' {k}="{html.escape(v, quote=True)}"'
            for k, v in self.attrs.items()
            if k in ("id", "class", "href", "epub:type", "role") and v
        )
        if self.tag in VOID_HTML_TAGS:
            return f"<{self.tag}{attrs_str}/>"
        inner = "".join(ch if isinstance(ch, str) else ch.to_html() for ch in self.children)
        return f"<{self.tag}{attrs_str}>{inner}</{self.tag}>"


class DomTreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = DomNode("root", {})
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        t = tag.lower()
        amap = {k.lower(): (v or "") for k, v in attrs}
        node = DomNode(t, amap, self.cur)
        self.cur.children.append(node)
        if t not in VOID_HTML_TAGS:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        t = tag.lower()
        amap = {k.lower(): (v or "") for k, v in attrs}
        node = DomNode(t, amap, self.cur)
        self.cur.children.append(node)

    def handle_endtag(self, tag):
        t = tag.lower()
        if t in VOID_HTML_TAGS:
            return
        p = self.cur
        while p is not None and p.tag != "root":
            if p.tag == t:
                self.cur = p.parent or self.root
                return
            p = p.parent

    def handle_data(self, data):
        if data:
            self.cur.children.append(html.escape(data))


def clean_page_title(raw_title: str, site_name: str = "") -> str:
    t = clean_whitespace(raw_title)
    if not t:
        return ""
    # Handle WordPress "Site Name » Blog Archive » Actual Title"
    if "»" in t:
        parts = [p.strip() for p in t.split("»") if p.strip()]
        t = parts[-1]
    # Strip trailing " | Site Name" or " — Site Name"
    for sep in (" | ", " — ", " – ", " - "):
        if sep in t:
            left, right = t.rsplit(sep, 1)
            if len(left) >= 6 and (not site_name or site_name.lower() in right.lower() or len(right) < 32):
                t = left.strip()
                break
    return t


def extract_web_metadata(root: DomNode) -> dict:
    og_title = ""
    og_site = ""
    doc_title = ""
    author = ""
    pub_date = ""

    for n in root.iter_nodes():
        if n.tag == "title" and not doc_title:
            doc_title = n.text_content()
        elif n.tag == "meta":
            prop = (n.attrs.get("property") or n.attrs.get("name") or "").lower()
            content = clean_whitespace(n.attrs.get("content") or "")
            if not content:
                continue
            if prop in ("og:title", "twitter:title") and not og_title:
                og_title = content
            elif prop == "og:site_name" and not og_site:
                og_site = content
            elif prop in ("author", "dc.creator", "dcterms.creator", "article:author") and not author:
                if not content.startswith("http"):
                    author = content
            elif prop in ("article:published_time", "date", "dc.date", "pubdate") and not pub_date:
                pub_date = content[:10]
        elif n.tag == "time" and not pub_date:
            dt = clean_whitespace(n.attrs.get("datetime") or n.text_content())
            if dt:
                pub_date = dt[:16]

    # Look for explicit article/post title heading in body before site header steals it
    post_heading = ""
    for n in root.iter_nodes():
        if n.tag in ("h1", "h2"):
            cls = n.attr_tokens().lower()
            p_cls = (n.parent.attr_tokens().lower() if n.parent else "")
            if (
                any(k in cls for k in ("entry-title", "post-title", "article-title", "headline"))
                or any(k in p_cls for k in ("post", "hentry", "article", "entry-header"))
                or any(
                    isinstance(c, DomNode) and c.tag == "a" and "bookmark" in c.attrs.get("rel", "").lower()
                    for c in n.children
                )
            ):
                cand = n.text_content()
                if cand:
                    post_heading = cand
                    break

    # Look for WordPress / blog date & author if meta tags were absent
    if not pub_date:
        full_txt = root.text_content()
        m_dt = re.search(
            r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,\s+(19|20)\d{2}\b",
            full_txt,
        )
        if m_dt:
            pub_date = m_dt.group(0)

    if not og_site and "»" in doc_title:
        og_site = doc_title.split("»", 1)[0].strip()

    best_title = post_heading or og_title or clean_page_title(doc_title, og_site)
    return {
        "title": best_title,
        "site_name": og_site,
        "author": author,
        "pub_date": pub_date,
    }


def is_protected_main_container(node: DomNode) -> bool:
    if node.tag in ("html", "body", "main", "article"):
        return True
    cls_tokens = set(re.split(r"[\s]+", (node.attrs.get("class") or "").lower()))
    nid = (node.attrs.get("id") or "").lower()
    if nid in ("content", "main", "main-content", "primary") or nid.startswith("post-"):
        return True
    if cls_tokens & {"post", "hentry", "entry", "entry-content", "post-content", "article-content", "article-body"}:
        return True
    return False


def prune_noise_subtrees(node: DomNode):
    kept = []
    for ch in node.children:
        if isinstance(ch, str):
            kept.append(ch)
            continue

        if ch.tag in DROP_SUBTREE_TAGS:
            continue

        # Drop page-level <header> banners unless inside <article>/.post
        if ch.tag == "header":
            anc = node
            in_article = False
            while anc is not None:
                if anc.tag == "article" or "post" in anc.attr_tokens().lower():
                    in_article = True
                    break
                anc = anc.parent
            if not in_article:
                continue

        tokens = ch.attr_tokens()
        if tokens and not is_protected_main_container(ch) and NOISE_ATTR_RE.search(tokens):
            continue

        # Drop link-heavy navigation lists / blogrolls / category clouds
        if ch.tag in ("ul", "ol") and not is_protected_main_container(ch):
            txt = ch.text_content()
            tlen = len(txt)
            if 0 < tlen < 900:
                llen = ch.link_text_len()
                if llen / max(1, tlen) > 0.72:
                    continue

        prune_noise_subtrees(ch)
        kept.append(ch)

    node.children = kept


def select_main_content_node(root: DomNode) -> DomNode:
    # 1. Explicit article body class/itemprop selectors (cleanest prose-only containers)
    explicit_classes = (
        "entry-content",
        "post-content",
        "article-content",
        "article-body",
        "post-body",
        "story-body",
        "available-content",
        "entry",
    )
    matches = []
    for n in root.iter_nodes():
        itemprop = (n.attrs.get("itemprop") or "").lower()
        cls_set = set((n.attrs.get("class") or "").lower().split())
        if itemprop == "articlebody" or any(c in cls_set for c in explicit_classes):
            wc = len(n.text_content().split())
            if wc >= 60:
                matches.append((wc, n))
    if matches:
        # Pick the primary (longest) entry body
        matches.sort(key=lambda x: x[0], reverse=True)
        return matches[0][1]

    # 2. Semantic <article> or .post / .hentry / <main>
    for n in root.iter_nodes():
        cls_set = set((n.attrs.get("class") or "").lower().split())
        nid = (n.attrs.get("id") or "").lower()
        if n.tag == "article" or "post" in cls_set or "hentry" in cls_set or nid.startswith("post-"):
            if len(n.text_content().split()) >= 60:
                return n

    for n in root.iter_nodes():
        if n.tag == "main" or n.attrs.get("role", "").lower() == "main":
            if len(n.text_content().split()) >= 60:
                return n

    # 3. Readability paragraph-density scoring fallback
    best_node = root
    best_score = -1.0
    for n in root.iter_nodes():
        if n.tag not in ("div", "section", "td", "body"):
            continue
        p_words = 0
        commas = 0
        for ch in n.iter_nodes():
            if ch.tag in ("p", "blockquote"):
                t = ch.text_content()
                p_words += len(t.split())
                commas += t.count(",")
        if p_words < 50:
            continue
        total_len = max(1, len(n.text_content()))
        link_density = n.link_text_len() / total_len
        score = (p_words * 5.0 + commas * 4.0) * max(0.05, 1.0 - link_density * 1.3)
        if score > best_score:
            best_score = score
            best_node = n

    return best_node


def extract_html_document(html_path: str) -> dict:
    with open(html_path, "rb") as f:
        raw_html = f.read().decode("utf-8", errors="replace")

    # Strip Project Gutenberg outer license wrappers if present
    start_g = re.search(r"\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*", raw_html, re.I)
    if start_g:
        raw_html = raw_html[start_g.end():]
    end_g = re.search(r"\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*", raw_html, re.I)
    if end_g:
        raw_html = raw_html[:end_g.start()]

    tree = DomTreeBuilder()
    tree.feed(raw_html)

    meta = extract_web_metadata(tree.root)
    prune_noise_subtrees(tree.root)
    main_node = select_main_content_node(tree.root)

    cleaned_html = main_node.to_html()
    parser = EpubXHTMLConverter()
    parser.feed(cleaned_html)
    parser._flush_block()

    # Filter any residual post-footer boilerplate lines & duplicate title subhead
    raw_title = meta["title"] or parser.first_heading or "Imported Article"
    filtered_blocks = []
    for b in parser.blocks:
        plain = strip_tags(b["html"])
        if not plain:
            continue
        if BOILERPLATE_PARA_RE.search(plain):
            continue
        if len(filtered_blocks) == 0 and b["type"] == "subhead" and plain.lower() == raw_title.lower():
            continue
        # Stop if a trailing comment-section heading somehow survived inside the same container
        if b["type"] == "subhead" and re.match(r"^(\d+\s+responses?\s+to\b|comments?\b|leave\s+a\s+reply\b)", plain, re.I):
            break
        filtered_blocks.append(b)

    if not filtered_blocks:
        raise ValueError("No readable article or book text found at that URL.")

    grouped = []
    current_title = raw_title
    current_blocks = []

    for b in filtered_blocks:
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

    if not chapters or sum(c["wordCount"] for c in chapters) < 30:
        raise ValueError("The linked web page did not contain enough readable text to build a book edition.")

    subtitle = ""
    if ":" in raw_title and len(raw_title) < 120:
        parts = raw_title.split(":", 1)
        raw_title, subtitle = parts[0].strip(), parts[1].strip()

    publisher_meta = (meta["site_name"] or "WEB LINK EDITION").upper()
    author = meta["author"] or meta["site_name"] or "Web Edition"

    return {
        "sourceFormat": "web",
        "title": raw_title,
        "subtitle": subtitle,
        "author": author,
        "publisherMeta": publisher_meta,
        "pubDate": meta["pub_date"] or "",
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
    out_dir = os.path.dirname(os.path.abspath(out_path))
    ext = os.path.splitext(in_path)[1].lower()

    if ext == ".epub":
        try:
            result = extract_epub_native(in_path, out_dir=out_dir)
        except Exception as epub_err:
            if fitz is not None:
                result = extract_pdf_with_fitz(in_path, out_dir=out_dir)
                result["sourceFormat"] = "epub"
            else:
                raise epub_err
    elif ext == ".pdf":
        result = extract_pdf_with_fitz(in_path, out_dir=out_dir)
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
