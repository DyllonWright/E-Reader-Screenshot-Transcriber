# Project Overview

This project is a pipeline for processing e-reader screenshots. It uses a multi-stage pipeline:

1. **Local OCR** — Tesseract.js reads each screenshot and extracts raw text, cached per file.
2. **Screen Classification** — Each screenshot classifies as `text` or `image` (full-screen illustration) by reading the reader header's blue/green band colors from the pixels (`checkHeaderColors`), cached per file as `isTextPage`.
3. **Fuzzy Deduplication** — Adjacent text screenshots are fuzzy-matched and merged to eliminate scroll-overlap duplicates.
4. **Illustration Extraction** — Full-screen illustration screenshots are auto-cropped using Jimp corner-pixel background detection.
5. **Gemini Formatting** — OCR text is sent to Gemini (in batches of ≤50 pages) for cleanup and formatting. Illustration namings are bundled into a single API call.
6. **Daily Markdown Output** — Clean transcriptions and Obsidian image embeds are written to `output/YYYY-MM-DD.md`.

The primary interface is a local **web GUI** (`gui/server.js` + `gui/public/`). The legacy CLI entrypoint `processScreenshots.js` still works for headless use.

## Technologies Used

*   **Node.js**: Runtime environment.
*   **express**: Local web server serving the GUI on port `3301`.
*   **dotenv**: Loads `GEMINI_API_KEY` from `.env`.
*   **@google/generative-ai**: Official Google Gemini API client (`gemini-flash-latest`).
*   **tesseract.js**: Local multi-worker OCR scheduler.
*   **jimp**: Pure-JS image loading and bounding-box cropping for illustration extraction.

## Project Structure

```
E-Reader-Screenshot-Transcriptions/
  gui/
    server.js             ← Express backend, all API endpoints, full pipeline logic
    public/
      index.html          ← Multi-step SPA (Configure → Process → Review → Success)
      style.css           ← Glassmorphic Esoteric Quasar Blue theme, all Vanilla CSS
      app.js              ← Frontend state, SSE stream, file upload, review grid
  screenshots/            ← Raw phone screenshots (Screenshot_YYYYMMDD_HHMMSS_*.jpg/.png)
  output/                 ← Daily .md files + YYYY-MM-DD Extracted Images/ subdirectories
  .ocr_cache/             ← JSON cache: {text, mtime} per screenshot file
  meta.json               ← GUI persistence: bookTitle, imageContexts
  .env                    ← GEMINI_API_KEY (git-ignored)
  processScreenshots.js   ← Legacy CLI entrypoint (same core algorithm, no GUI)
  run.bat                 ← One-click launcher: auto-installs deps, starts GUI, opens browser
  eng.traineddata         ← Bundled Tesseract English model
  ARCHITECTURE.md         ← Full developer context guide: data flow, endpoints, design decisions
  README.md               ← User-facing documentation and setup guide
```

## Building and Running

### Setup

1. **Install Dependencies:**
   ```powershell
   npm install
   ```

2. **Configure API Key:**
   Create `.env` in the project root:
   ```
   GEMINI_API_KEY=YOUR_REAL_API_KEY_HERE
   ```
   Or paste and save the key directly inside the GUI after first launch.

### GUI Mode (Primary)

Double-click `run.bat`. It self-bootstraps `npm install` if needed, starts the Express server at `http://localhost:3301`, and opens your browser automatically.

**Workflow inside the GUI:**
1. Import screenshots via the dropzone (pulls from any folder, e.g. Downloads).
2. Set the current book title, add optional illustration hints.
3. Press **Run AI Transcription & Extractor**.
4. Review and tweak AI-suggested illustration filenames.
5. Press **Finalize** to write crops and the daily Markdown note.
6. Click **Show in System Explorer** to open the output folder.

### CLI Mode (Legacy)

```powershell
node processScreenshots.js
```

Place screenshots in `screenshots/`, run the command. Output goes to `output/`.

## Development Conventions

*   **Screenshot filename pattern:** `Screenshot_YYYYMMDD_HHMMSS_*.jpg` or `.png`
*   **Header detection (`checkHeaderColors`):** center-column pixels show the header's blue band `#3f4863` (y 6–10%) and green band `#3c5e51` (y 9–14%), matched within RGB distance 25 → text page; either band absent → full-screen illustration. Cached as `isTextPage`; classification no longer reads OCR words.
*   **Gemini model:** `gemini-flash-latest` — free-tier quota-efficient. Update in **both** `gui/server.js` and `processScreenshots.js` if changing.
*   **API quota design:** Illustration naming = 1 call/day total (all bundled). Text cleanup = 1–2 calls/day at ≤50 pages per batch.
*   **Output format:** `# Reading – [[YYYY-MM-DD]]` header, bold `**HH:MM:SS**` timestamp per entry, `![[filename.jpg]]` for illustrations.
*   **Port:** `3301` (avoid conflict with other common dev servers).
*   **Persistent state:** `meta.json` stores book title and per-file illustration hints. `.env` stores the API key. Both are auto-managed by the GUI.

## Output Format

```markdown
# Reading – [[2026-05-29]]

**12:34:14**
Cleaned passage of text from the first screenshot.

**12:34:28**
![[2026 05 29 Liber Null Baphomet Symbol.jpg]]

**12:35:19**
Text continues after the illustration.
```