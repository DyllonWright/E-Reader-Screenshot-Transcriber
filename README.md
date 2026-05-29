# E-Reader Screenshot Transcriber

A Node.js pipeline for transcribing and archiving e-reader screenshots. Combines parallel local OCR, intelligent fuzzy text deduplication, full-screen illustration extraction, and AI-powered formatting — all wrapped in a beautiful one-click local web GUI.

## Capabilities

*   **Local Web GUI:** A glassmorphic browser-based interface. Launch it by double-clicking `run.bat`. No installation steps needed — it self-bootstraps all dependencies on first run.
*   **Screenshot Import:** Import screenshots directly from your Downloads folder or any directory using the browser's native file picker. Files are uploaded to `screenshots/` and OCR-cached automatically in the background.
*   **Parallel Worker Pool OCR:** A dynamic pool of Tesseract.js workers (scaled to CPU core count) runs local OCR concurrently on all screenshots.
*   **OCR Caching:** Stores OCR results per image. Subsequent runs reuse cached text for unchanged screenshots, making re-runs essentially instant.
*   **Header-Based Screen Classification:** Detects the e-reader's reading header (containing "Evie", "Contents", "Read", or "Sleep") to instantly distinguish **text pages** from **full-screen illustration screenshots** — no heuristics, no word counts.
*   **Fuzzy Overlap Deduplication:** Slides an anchor window from the tail of the previous screenshot and fuzzy-matches it against the head of the next, using a pure-JavaScript Levenshtein edit distance ratio (`fuzzRatio`). Overlapping and duplicate pages are automatically trimmed and merged into a continuous, clean transcription.
*   **Illustration Extraction & Cropping:** Full-screen illustration screenshots are detected, background-sampled at corners, and automatically cropped to their bounding box. The crop ignores the top/bottom 8% (where UI overlays appear).
*   **Contextual AI Naming:** All detected illustrations are bundled into a **single Gemini API call**, providing each illustration's surrounding text context and any user-supplied hints. Gemini returns descriptive, Windows-safe filenames like `YYYY MM DD Book Title Description.jpg`.
*   **Interactive Name Review:** Before saving anything, a visual review grid displays each cropped illustration thumbnail alongside its AI-suggested filename in an editable 2-line text area. Rename them directly before finalizing.
*   **Sequential Chronological Writes:** Crop files are written with 100ms spacing between each, guaranteeing that Windows file creation timestamps match the chronological order of the original screenshots.
*   **Obsidian-Compatible Output:** Illustrations are embedded in the daily Markdown file using Obsidian's `![[filename.jpg]]` syntax, woven chronologically among the timestamped text entries.
*   **Persistent Settings:** Book title and illustration context hints are saved to `meta.json` and automatically reloaded between sessions. The API key can be pasted and saved directly in the GUI, overwriting `.env`.
*   **API Resilience:** Automatic exponential backoff retries on transient Gemini API errors (429 rate limit, 503 overload).
*   **One-Click Explorer Access:** A "Show in System Explorer" button on the success screen instantly opens the `output/` folder in Windows File Explorer.

## Tools & Dependencies

| Package | Role |
|---|---|
| `express` | Local web server for the GUI backend |
| `tesseract.js` | Local OCR engine (multi-worker scheduler) |
| `jimp` | Pure-JS image loading and bounding box cropping |
| `@google/generative-ai` | Gemini API client (`gemini-flash-latest`) |
| `dotenv` | Loads `GEMINI_API_KEY` from `.env` |

## Project Layout

```
E-Reader-Screenshot-Transcriptions/
│
├── gui/                          ← Local web GUI (Express backend + HTML/CSS/JS frontend)
│   ├── server.js                 ← Express server: API endpoints, OCR orchestration, Gemini calls, SSE streaming
│   └── public/
│       ├── index.html            ← Multi-step stepper UI (Config → Processing → Review → Success)
│       ├── style.css             ← Glassmorphic dark theme, Vanilla CSS
│       └── app.js                ← Frontend state management, file upload, SSE log listener, review grid
│
├── screenshots/                  ← Drop raw phone screenshots here (Screenshot_YYYYMMDD_HHMMSS_*.jpg/png)
├── output/                       ← Daily .md files + date-named Extracted Images subdirectories
│   ├── YYYY-MM-DD.md             ← Formatted daily Markdown with Obsidian image embeds
│   └── YYYY-MM-DD Extracted Images/
│       └── YYYY MM DD Book Title Description.jpg
│
├── .ocr_cache/                   ← JSON-cached OCR results keyed to file mtime (auto-managed)
├── meta.json                     ← Persistent GUI state: book title, illustration context hints (auto-managed)
├── .env                          ← Holds GEMINI_API_KEY (git-ignored)
├── processScreenshots.js         ← Legacy CLI entrypoint (same pipeline logic, no GUI)
├── run.bat                       ← One-click launcher: installs deps if needed, starts GUI server, opens browser
├── package.json
└── eng.traineddata               ← Bundled Tesseract English language model
```

## Setup

### Prerequisites

*   Node.js (LTS recommended) — download from [nodejs.org](https://nodejs.org/)
*   A Google Gemini API key from [Google AI Studio](https://aistudio.google.com/)

### Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/DyllonWright/E-Reader-Screenshot-Transcriber
    cd E-Reader-Screenshot-Transcriber
    ```

2.  Create `.env` in the project root with your API key:
    ```
    GEMINI_API_KEY=YOUR_KEY_HERE
    ```
    *(You can also paste and save the key directly inside the GUI on first launch.)*

3.  Double-click `run.bat`. It will auto-install all Node.js dependencies on first run, then open the GUI in your browser.

## GUI Workflow

The GUI walks you through a 4-step pipeline:

**Step 1 — Configure & Import**
- Set the current book title (saved to `meta.json` for future sessions).
- Paste a new Gemini API key to update `.env` on-the-fly.
- Click **Load Screenshots** to multiselect image files from your phone or Downloads folder. They are copied to `screenshots/` and OCR-cached instantly.
- Select the date batch to process from the dropdown.
- Optionally type context hints next to detected illustration thumbnails (e.g., *"world map"* or *"chapter opener"*) to help Gemini name them precisely.
- Press **Run AI Transcription & Extractor**.

**Step 2 — AI Processing**
- Watch the live retro-terminal console stream OCR reads, deduplication decisions, Gemini illustration naming (single bundled call), and Gemini text cleanup batches in real time.

**Step 3 — Review & Rename**
- Inspect each cropped illustration alongside its AI-suggested filename.
- Edit the filename in the 2-line text area directly before saving.
- Press **Finalize Notes & Save Sequential Crops**.

**Step 4 — Complete**
- Crops are written to `output/YYYY-MM-DD Extracted Images/` in chronological order.
- The daily Markdown note is written to `output/YYYY-MM-DD.md`.
- Press **Show in System Explorer** to jump straight to the output folder.

## Output Format

```markdown
# Reading – [[2026-05-29]]

**12:34:14**
This is the first passage of cleaned-up text, with paragraphs joined into a single line.

**12:34:28**
![[2026 05 29 My Book Title Chapter Map.jpg]]

**12:35:19**
This passage continues after the illustration entry above.
```

## CLI Mode (Legacy)

The original headless script still works and uses the same core pipeline:

```powershell
node processScreenshots.js
```

Place screenshots in `screenshots/`, run the command, and formatted output is written to `output/`. No GUI required. Useful for automation or batch runs.

## API Quota Notes

This tool uses `gemini-flash-latest` which has a free daily call limit. The pipeline is designed to be quota-efficient:

- **Illustration naming**: All illustrations per day are bundled into **1 API call** (regardless of count).
- **Text transcription**: Up to 50 OCR pages are bundled per call. A typical reading day uses **1–2 calls** total.
- **OCR caching**: Re-runs on already-processed screenshots consume **zero additional API calls**.
