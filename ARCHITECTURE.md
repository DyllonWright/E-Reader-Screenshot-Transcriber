# Architecture & Developer Context Guide

This document explains how the E-Reader Screenshot Transcriber is structured, how data flows through the pipeline, and what you need to know before making changes. Keep it updated alongside the codebase.

---

## System Overview

The tool has two operational modes:

1. **GUI Mode** (primary) — `run.bat` → `node gui/server.js` → browser-based SPA
2. **CLI Mode** (legacy) — `node processScreenshots.js` directly

Both modes share the same core processing logic. The GUI server re-implements the pipeline from `processScreenshots.js` using the same algorithms — the duplication is intentional to allow headless CLI operation without Express overhead.

---

## Directory Map

```
/
├── gui/
│   ├── server.js           Express backend (all API endpoints + pipeline execution)
│   └── public/
│       ├── index.html      HTML structure — 4-step stepper SPA
│       ├── style.css       All styling — CSS variables, glassmorphic dark theme
│       └── app.js          All frontend JS — state management, fetch/SSE, DOM updates
│
├── processScreenshots.js   Standalone CLI pipeline (no GUI, shares algorithm logic)
├── run.bat                 Windows launcher: checks Node, auto-installs deps, starts server, opens browser
│
├── screenshots/            Input: raw phone screenshots (Screenshot_YYYYMMDD_HHMMSS_*.jpg/.png)
├── output/                 Output: YYYY-MM-DD.md daily notes + YYYY-MM-DD Extracted Images/ subdirs
├── .ocr_cache/             Auto-managed JSON cache: {text, mtime} per screenshot filename
├── meta.json               Auto-managed GUI persistence: {bookTitle, imageContexts}
├── .env                    Secret: GEMINI_API_KEY (git-ignored, can be overwritten via GUI)
└── eng.traineddata         Bundled Tesseract English language model (required by tesseract.js)
```

---

## Core Data Flow (GUI Mode)

```
run.bat
  └── node gui/server.js
        ├── Serves gui/public/ at http://localhost:3301
        └── Opens browser to http://localhost:3301

Browser (app.js)
  └── GET /api/status
        ├── Reads screenshots/ directory
        ├── Groups files by date (parseDateTimeFromFilename)
        ├── Runs parallel OCR via Tesseract scheduler (ensureOcrCached)
        ├── Classifies each screenshot: text or image (hasReaderHeader)
        └── Returns: { dates, groups, bookTitle, apiKeyPresent }

User selects date, optionally imports files, types illustration hints
  └── POST /api/upload (base64 JSON, one file at a time)
        ├── Writes file to screenshots/
        └── Pre-caches OCR immediately

User clicks "Run AI Transcription & Extractor"
  └── POST /api/save-contexts → saves hint text to meta.json
  └── GET /api/process-stream?date=YYYY-MM-DD (Server-Sent Events)
        │
        ├── Step 1: Read all OCR results from cache (ensureOcrCached)
        ├── Step 2: SINGLE Gemini API call to name all illustrations
        │     └── Bundles all {prevText, nextText, userNotes} per illustration
        │     └── Returns JSON array: [{file, bookTitle, description, filename}]
        │     └── Falls back to "Book Illustration N" if API fails
        ├── Step 3: Fuzzy deduplication on text pages only (findOverlapFuzzy)
        │     └── Slides anchor window from tail of prev → matches prefix of next
        │     └── Merges/trims overlapping content in-place
        ├── Step 4: SINGLE Gemini API call (batch ≤50 pages) for text cleanup
        │     └── Image placeholders [IMAGE: filename.jpg] pass through untouched
        └── Sends SSE "complete" event with {draftContent, illustrations[]}

User reviews illustration names, edits in text areas
  └── POST /api/finalize
        ├── For each illustration: Jimp loads screenshot, samples corners for bg color,
        │   crops bounding box (ignoring top/bottom 8%), writes to Extracted Images/
        ├── Replaces [IMAGE: filename.jpg] in draft with ![[filename.jpg]]
        ├── Writes output/YYYY-MM-DD.md (appends if file already exists)
        └── 100ms delay between each crop write for sequential Windows timestamps

User clicks "Show in System Explorer"
  └── POST /api/open-explorer → exec('explorer.exe "output/"')
```

---

## Key Functions

### `gui/server.js`

| Function | Purpose |
|---|---|
| `parseDateTimeFromFilename(filename)` | Extracts `{date, time}` from `Screenshot_YYYYMMDD_HHMMSS_*.jpg` |
| `hasReaderHeader(text)` | Returns `true` if OCR text contains "Evie", "Contents", "Sleep", or "Read" — classifies as **text page** |
| `ensureOcrCached(filename, filePath)` | Checks `.ocr_cache/{filename}.json` for matching mtime; runs Tesseract and writes cache on miss |
| `getTesseractScheduler()` | Lazily initializes a shared Tesseract scheduler with `min(4, cpus-1)` workers |
| `generateContentWithRetry(apiKey, prompt, maxRetries)` | Wraps Gemini `generateContent` with exponential backoff on 429/503 |
| `findOverlapFuzzy(prevText, newText)` | Fuzzy-matches the tail of prev against the head of new to detect/trim scroll overlaps |
| `fuzzRatio(s1, s2)` | Pure-JS Levenshtein edit distance ratio (matches Python `fuzz.ratio` substitution cost=2 behavior) |
| `readMeta() / writeMeta(data)` | Reads/writes `meta.json` for persistent GUI state (bookTitle, imageContexts) |

### `processScreenshots.js` (CLI)

Contains the same algorithms (fuzzRatio, findOverlapFuzzy, hasReaderHeader, getIllustrationFilename, getFormattedTranscriptions). The main difference is that illustration naming makes **one call per image** (not batched) and there is no interactive review step. If you improve the core algorithms, update **both files**.

---

## API Endpoints (`gui/server.js`)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/status` | Full system scan: files, dates, OCR classification, saved settings |
| `GET` | `/api/screenshot/:name` | Serve raw screenshot from `screenshots/` |
| `GET` | `/api/cropped/:date/:name` | Serve cropped image from `output/YYYY-MM-DD Extracted Images/` |
| `POST` | `/api/settings` | Save `bookTitle` to `meta.json`, optionally overwrite `.env` with new API key |
| `POST` | `/api/save-contexts` | Merge illustration hint text into `meta.json imageContexts` |
| `POST` | `/api/upload` | Receive base64 image, write to `screenshots/`, run background OCR cache |
| `GET` | `/api/process-stream` | SSE stream: full OCR → naming → dedup → Gemini text pipeline for a date |
| `POST` | `/api/finalize` | Crop illustrations, replace placeholders, write MD and image files |
| `POST` | `/api/open-explorer` | Run `explorer.exe` pointing to `output/` |

**Port:** `3301` (avoids conflict with common dev servers on 3000)

---

## Frontend Architecture (`gui/public/app.js`)

Single `DOMContentLoaded` closure, no framework. Key state:

```js
appState = {
  bookTitle, apiKeyPresent, dates, groups,  // From /api/status
  selectedDate,                             // User's selected batch
  draftContent,                             // Formatted MD text from Gemini (Step 2 output)
  illustrations                             // [{originalFile, suggestedName, time}] for review grid
}
```

**Step transitions** are managed by `setStepActive(stepIndicator, targetPanel)`, which toggles `.active` / `.completed` CSS classes.

**SSE log streaming** uses the native `EventSource` API. Event types:
- `log` → append to terminal
- `progress` → update progress bar width and label
- `error` → show error in terminal + back button
- `complete` → navigate to review panel with `reviewData` payload

**File uploads** use `FileReader.readAsDataURL()` to base64-encode each file and POST them one at a time to `/api/upload`.

**Review grid** renders `<textarea rows="2" resize="none">` for each illustration. The `value` is the AI-suggested name; user edits are read back at `POST /api/finalize` time.

---

## CSS Design System (`gui/public/style.css`)

All colors are defined as CSS variables at the `:root` level. Theme: **Esoteric Quasar Blue**.

| Variable | Value | Role |
|---|---|---|
| `--bg-dark` | `hsl(240, 30%, 4%)` | Deep space background |
| `--bg-card` | `rgba(10, 11, 24, 0.7)` | Glass panel background |
| `--primary` | `hsl(195, 100%, 43%)` | Quasar neon blue — buttons, active stepper, focus rings |
| `--primary-hover` | `hsl(188, 100%, 52%)` | Electric cyan hover |
| `--accent-purple` | `hsl(280, 50%, 42%)` | Nebula violet — background blob gradient |
| `--accent-cyan` | `hsl(190, 100%, 50%)` | High-energy cyan — timestamps, key status |
| `--accent-gold` | `hsl(42, 85%, 55%)` | Esoteric sacred gold — completed steps, success icon |
| `--accent-green` | `hsl(150, 80%, 40%)` | Terminal success log text |

To update the theme, change only the `:root` variables — all component styles inherit them.

---

## Illustration Detection Logic

The key insight: the Evie e-reader always shows a top bar (book title + menu buttons) when reading text. When an illustration goes full-screen, that header disappears.

```
hasReaderHeader(ocrText)
  → true  (contains "Evie"|"Contents"|"Sleep"|"Read")  → TEXT page
  → false                                              → IMAGE page (full-screen illustration)
```

This means **no word count heuristics, no pixel analysis for detection** — header presence is the sole classifier. Cropping logic uses Jimp to find the bounding box of non-background pixels (sampled from image corners), ignoring the top and bottom 8% of height where on-screen UI overlays may appear.

---

## Gemini API Quota Strategy

Free tier limit: **20 requests/day** on `gemini-flash-latest`.

Calls per processing run:
1. **Illustration naming**: always **1 call** (all illustrations bundled in one prompt)
2. **Text cleanup**: **ceil(mergedPages / 50) calls** — typically 1–2 for a normal reading day

To change the model, update `generateContentWithRetry` in **both** `gui/server.js` and `processScreenshots.js`. Current model: `gemini-flash-latest`.

---

## Filename Conventions

Screenshots: `Screenshot_YYYYMMDD_HHMMSS_*.jpg` or `.png`
- Parsed by regex: `/^Screenshot_(\d{8})_(\d{6})/`

Extracted illustrations: `YYYY MM DD Book Title Short Description.jpg`
- Spaces as separators (not underscores or dashes) — matches natural language sorting in Obsidian
- Sanitized by: `s.replace(/[\/\\?%*:|"<>]/g, "").replace(/\s+/g, " ").trim()`

Daily notes: `output/YYYY-MM-DD.md`
- Always start with `# Reading – [[YYYY-MM-DD]]`
- Append-safe: existing header is detected and content is added after it

---

## Extending the Pipeline

**Add a new processing step:**
1. Add a new SSE `sendEvent("log", ...)` block inside the `/api/process-stream` handler.
2. Update `appendLog` logic in `app.js` if a new event type is needed.

**Add a new persistent setting:**
1. Add the field to the `readMeta()` / `writeMeta()` return shape.
2. Add a form input to `index.html` Step 1.
3. POST it to `/api/settings` or create a new endpoint.
4. Read it back in `loadStatus()` in `app.js`.

**Change the output Markdown format:**
- Edit the `getFormattedTranscriptions` prompt string in `gui/server.js` (and mirror in `processScreenshots.js`).
- Update the `![[filename.jpg]]` replacement regex if Obsidian embed syntax changes.

**Change crop behavior:**
- Edit the Jimp bounding box scan inside `POST /api/finalize` in `gui/server.js`.
- The `0.08` / `0.92` boundary constants control how much of the top/bottom to ignore during crop detection.
