# Book Viz Studio

Upload any **EPUB** or **PDF** book and let **Gemini** process it in the background into a rich, interactive digital edition—complete with **actual full-book text**, **16:9 Story Comics** with guided 5-beat camera pan/zoom tours, **animated SVG concept diagrams**, **inline endnotes**, **multi-color highlights & margin notes**, and **Gemini 4 Neon** scholarly AI chat.

## Features

- **EPUB & PDF Upload + Live Background Processing**:
  - Upload `.epub` or `.pdf` books straight from the browser.
  - Full chapter text, blockquotes, italics, page folios, and endnotes are extracted immediately (never condensed into study-guide summaries) so you can start reading within seconds.
  - In the background, Gemini partitions each chapter into thematic sections, generates editorial receipt metadata, builds 3-step animated SVG diagrams, extracts verbatim pull-quotes, and illustrates 16:9 pen-and-ink + watercolor **Story Comics** (`gemini-3.1-flash-image`), hot-updating the open book live as each visual finishes.
- **3-Column Editorial Workbench**:
  - **Melville House Receipt Masthead**: Dynamic chapter ledger (`ITEM`, `FOLIO`, `ENDNOTES`, `BALANCE DUE`) and chapter tagline.
  - **Left Sidebar**: Collapsible multi-chapter accordion with clickable Roman-numeral section links (`I..IV`) and live scroll-spy.
  - **Center Book Stage**: Compact Chapter Menu switcher (`Prev` / `Next`), `Paper` / `Sepia` / `Night` themes, adjustable serif measure and type sizes, 5-beat guided Story Comic camera tour + SVG Diagram toggle, and full chapter prose.
  - **Right Sidebar**: 4-color text highlighting & Markdown margin notes, **Gemini 4 Neon** AI study chat (automatically grounded in your highlighted passage + margin notes), and linked chapter endnotes.
- **Persistent Website Storage**:
  - All uploaded books, extracted prose, generated Story Comics, highlights, margin notes, and AI chat threads are stored persistently on the website server (`data/books/<bookId>/`) and mirrored in browser `IndexedDB` + `localStorage`.

## Quick Start

1. **Configure API Key** — Create a `.env` file in the project root:
   ```bash
   cp .env.example .env
   # Set GEMINI_API_KEY=your_api_key_here
   ```
   *(Requires Node.js 18+ and Python 3 with PyMuPDF `pymupdf` installed for PDF/EPUB parsing: `pip install pymupdf`.)*

2. **Start the Server**:
   ```bash
   npm start
   ```
   Open [http://127.0.0.1:8080](http://127.0.0.1:8080) and click **Library / + Upload Book** to upload any `.epub` or `.pdf`.
