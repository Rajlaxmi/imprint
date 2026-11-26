# Imprint

Turn any **EPUB**, **PDF**, or **web essay/blog link** into a rich, interactive digital edition—complete with **full original prose**, **16:9 Story Comics** with guided 5-beat camera pan/zoom tours, **animated SVG concept diagrams**, **editable superscript endnotes**, **multi-color highlights & margin notes**, and **Gemini 4 Neon** (with live Google Search grounding) study chat.

## Two Ways to Run Imprint

1. **GitHub Pages (Serverless Browser Mode)**:
   - Hosted directly from `./public` via GitHub Actions Pages (`.github/workflows/pages.yml`).
   - Automatically activates `static-engine.js`, parsing `.epub` (`JSZip`), `.pdf` (`pdf.js`), and web links directly in the browser, storing books, Story Comics, highlights, endnotes, and chat history in `IndexedDB`, and connecting directly to Gemini with a browser-stored API key (**Set Gemini Key** button in the top bar).
2. **Local / Self-Hosted Server Mode (`npm start`)**:
   - Uses `server.js` + `scripts/extract_book.py` (PyMuPDF `pymupdf`) with server-side `.env` (`GEMINI_API_KEY`) and persistent server storage in `data/books/<bookId>/` mirrored to `IndexedDB`.

```bash
cp .env.example .env   # Add GEMINI_API_KEY=...
npm start              # Runs at http://127.0.0.1:8080
```
