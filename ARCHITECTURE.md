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
├── archive/                Archived raw screenshots after finalize: archive/YYYY-MM-DD/*.jpg (git-ignored)
├── .ocr_cache/             Auto-managed JSON cache: {text, isTextPage, mtime} per screenshot filename
├── .pipeline_cache/        Per-date pipeline state: {draftContent, illustrations, status} (git-ignored)
├── meta.json               Auto-managed GUI persistence: {bookTitle, recentBooks[], imageContexts}
├── gemini_stats.json       Auto-managed call/request telemetry, 24hr UTC windows (git-ignored)
├── .env                    Secret: the GEMINI_API_KEY ring (git-ignored, as are .env.bak/.env.tmp)
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
        ├── Classifies each screenshot: text or image (checkHeaderColors → cached isTextPage)
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

Step 4 (Complete): user chooses screenshot cleanup
  └── GET /api/archive-stream?date=YYYY-MM-DD&mode=archive|delete (SSE, live heartbeat)
        ├── archive → fs.rename each raw screenshot into archive/YYYY-MM-DD/
        ├── delete → PowerShell (Microsoft.VisualBasic) sends them to the Recycle Bin
        └── markBatchArchived() stamps .pipeline_cache/<date>.json status="archived"
        → the batch leaves the active list and appears in the "recently archived" strip

User clicks "Show in System Explorer"
  └── POST /api/open-explorer {target} → exec('explorer.exe "<output|input|archive>"')
```

---

## Key Functions

### `gui/server.js`

| Function | Purpose |
|---|---|
| `parseDateTimeFromFilename(filename)` | Extracts `{date, time}` from `Screenshot_YYYYMMDD_HHMMSS_*.jpg` |
| `checkHeaderColors(image)` | Samples the center column for the reader header's blue (`#3f4863`) and green (`#3c5e51`) bands; returns `true` (**text page**) only when both appear |
| `colorDistance(c1, c2)` | Euclidean RGB distance, used by `checkHeaderColors` with a match threshold of `< 25` |
| `ensureOcrCached(filename, filePath)` | Checks `.ocr_cache/{filename}.json` for matching mtime; on miss runs Tesseract **and** `checkHeaderColors`, writes `{text, isTextPage, mtime}`; returns `{text, isTextPage}` |
| `getTesseractScheduler()` | Lazily initializes a shared Tesseract scheduler with `min(4, cpus-1)` workers |
| `generateContentWithRetry(prompt, onStatusUpdate, meta)` | Wraps Gemini `generateContent`: waits out a 503 for up to 10 min, rotates the key ring on a 429/403, stops on a bad request. See `gui/lib/`. |
| `findOverlapFuzzy(prevText, newText)` | Fuzzy-matches the tail of prev against the head of new to detect/trim scroll overlaps |
| `fuzzRatio(s1, s2)` | Pure-JS Levenshtein edit distance ratio (matches Python `fuzz.ratio` substitution cost=2 behavior) |
| `readMeta() / writeMeta(data)` | Reads/writes `meta.json` for persistent GUI state (bookTitle, imageContexts) |

### `processScreenshots.js` (CLI)

Contains the same algorithms (fuzzRatio, findOverlapFuzzy, checkHeaderColors, getIllustrationFilename, getFormattedTranscriptions). The main difference: illustration naming makes **one call per image** (not batched) and offers no interactive review step. If you improve the core algorithms, update **both files**.

---

## API Endpoints (`gui/server.js`)

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/status` | Full system scan: files, dates, OCR classification, saved settings, `recentBooks[]`, and `archivedInfo[]` (cleared batches) |
| `GET` | `/api/screenshot/:name` | Serve raw screenshot from `screenshots/`, falling back to `archive/<date>/` for cleared batches |
| `GET` | `/api/cropped/:date/:name` | Serve cropped image from `output/YYYY-MM-DD Extracted Images/` |
| `GET` | `/api/load-cache` | Return the saved `.pipeline_cache/<date>.json` for resuming/redoing a batch |
| `POST` | `/api/settings` | Save `bookTitle` to `meta.json` (maintaining the 3-slot `recentBooks` queue), optionally upsert an API key into the `.env` ring (never overwrites the file) |
| `POST` | `/api/save-contexts` | Merge illustration hint text into `meta.json imageContexts` |
| `POST` | `/api/upload` | Receive base64 image, write to `screenshots/`, run background OCR cache |
| `GET` | `/api/process-stream` | SSE stream: full OCR → naming → dedup → Gemini text pipeline for a date |
| `POST` | `/api/finalize` | Crop illustrations, replace placeholders, write MD and image files |
| `GET` | `/api/archive-stream` | SSE stream: after finalize, move a date's raw screenshots to `archive/<date>/` (`mode=archive`) or send them to the Recycle Bin (`mode=delete`); stamps the pipeline cache `status: "archived"` |
| `POST` | `/api/open-explorer` | Run `explorer.exe` pointing to `output/`, `input` (screenshots), or `archive` per `{target}` |
| `GET` | `/api/gemini-stats` | Fetch Gemini API response times, model specs, and token usage aggregated by 24hr UTC windows |
| `POST` | `/api/clear-gemini-stats` | Reset recorded Gemini stats history (`gemini_stats.json`) |

**Port:** `3301` (avoids conflict with common dev servers on 3000)

---

## Frontend Architecture (`gui/public/app.js`)

Single `DOMContentLoaded` closure, no framework. Key state:

```js
appState = {
  bookTitle, recentBooks, apiKeyPresent,    // From /api/status
  dates, datesInfo, archivedInfo, groups,   // Active batches + cleared batches + per-file items
  totalScreenshots,                         // Count shown in the slim input-folder bar
  selectedDate,                             // User's selected batch
  draftContent,                             // Formatted MD text from Gemini (Step 2 output)
  illustrations                             // [{originalFile, suggestedName, time}] for review grid
}
```

**Batch statuses** (`datesInfo[].status`) drive the color-coded cards on Step 1:
`ocr_active` (Analyzing — cyan pulse) → `ocr_done` (Ready — green/go) → `paused`
(Resume Draft — amber) → `completed` (Finalized — violet). Once a finalized batch's
screenshots are archived/deleted it leaves `datesInfo` and reappears in `archivedInfo`
(the collapsed "recently archived" strip). The 3 most-recent archived batches show by
default; the flag button expands the rest. `recentBooks` renders as quick-switch chips
under the book-title field so concurrently-read books swap in one click.

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

**Ambient cosmos:** a fixed, `z-index: -1` `.cosmos` layer holds three slowly-drifting
blurred nebula blobs (`.bg-grad-1/2/3`) plus a `.starfield` of 60 JS-generated `.star`
dots that twinkle via CSS custom properties (`--min-op/--max-op/--dur/--delay`). It stays
purely decorative (`pointer-events: none`) and freezes under `prefers-reduced-motion`.

**Status palette classes** (Step 1 batch cards): `.batch-status-ocr_active` (cyan, pulsing),
`.batch-status-ocr_done` (green — Ready/go), `.batch-status-paused` (amber),
`.batch-status-completed` (violet — Finalized), `.batch-status-archived` (slate).

---

## Illustration Detection Logic

The key insight: the Evie e-reader always paints a top bar when reading text — a blue status band above a green chapter-progress band. When an illustration goes full-screen, both bands disappear. Detection reads those two header colors directly from the pixels rather than from OCR text, so it no longer depends on which words a page happens to contain.

```
checkHeaderColors(image)            // samples the vertical center column, x = width/2
  ├── blue band  #3f4863 (rgb 63,72,99)  within y ∈ [6%, 10%] of height
  └── green band #3c5e51 (rgb 60,94,81)  within y ∈ [9%, 14%] of height
        match = Euclidean RGB distance < 25

  → both bands found   → TEXT page  (isTextPage = true)
  → either band absent → IMAGE page (full-screen illustration, isTextPage = false)
```

The result caches as `isTextPage` alongside the OCR text, so OCR content never gates the classification — a sparse or near-empty reading page (the original false-positive bug) still classifies as text because its header bands remain. `isTextPage` is the **sole** classifier across every code path (`/api/status`, `/api/process-stream`, and the CLI). Legacy cache entries written before this scheme carry no `isTextPage`; the pipeline detects that, recomputes `checkHeaderColors`, and writes the flag back on next read.

> **Why color, not OCR words:** the earlier classifier keyed on header *words* ("Evie", "Contents", "Sleep", "Read") in the OCR output. Chapter starts, quote screens, and tables of contents hide the header text — and a page with little body text yields few words — so genuine text pages fell through to "image." Reading the header *band colors* keys on a UI element present on every reading page regardless of text content.

Cropping logic (separate from detection) uses Jimp to find the bounding box of non-background pixels (sampled from image corners), ignoring the top and bottom 8% of height where on-screen UI overlays may appear.

---

## Gemini API Quota Strategy

Free tier limit: **20 requests/day** on `gemini-flash-latest` (the GUI's
`dailyQuotaTarget` holds the authoritative number; AI Studio holds the real one).

Calls per processing run:
1. **Illustration naming**: always **1 call** (all illustrations bundled in one prompt)
2. **Text cleanup**: **ceil(mergedPages / 50) calls** — typically 1–2 for a normal reading day

A *call* and a *request* differ, and the meter tracks both. One call that fought
through a demand spike sends several requests, and the daily gauge reads
`totalRequests` — reading `totalCalls` there is what let 2026-07-27 record 4
calls against 8 real requests and show a 40% day as 20%.

To change the model, update `GEMINI_MODEL` in `gui/server.js` and
`generateContentWithRetry` in `processScreenshots.js`. Current model:
`gemini-flash-latest`.

---

## Key Ring, Patience, and Pacing (`gui/lib/`)

Three modules ported from ClipPipeline's `foundation/` and mission-control's
`shared/env-key-ring`, added 2026-08-27 after a 503 investigation. Each one owns
a decision the old single retry loop conflated.

| module | owns | the failure it ends |
|---|---|---|
| `keyRing.js` | which key runs, and rotating to the next | one key in `.env`, and a run that dies when it runs dry |
| `geminiRetry.js` | how long to wait, and whether waiting helps at all | 503 and 429 sharing one 30-second budget |
| `geminiPace.js` | the 12s rate window, and rotating *before* a ceiling | the call that discovers the ceiling is a call that failed |

### The policy, in one table

| fault | waiting helps? | the move |
|---|---|---|
| 503 / 500 / dropped connection | yes | back off, jittered 15→30→60→120s, **10 minutes** total |
| 429 / RESOURCE_EXHAUSTED | no — the key is dry | **rotate**, spending no transient try |
| 403 / revoked key | never | rotate off it, mark it dead for the run |
| 400 / bad request / safety block | never | stop at once |
| anything unrecognised | unknown | stop — the report is how it stops being unrecognised |
| a reply that ARRIVED unusable | n/a | its own budget of 3, never the transient one |

### The `.env` layout IS the state

Several keys, one uncommented, a label above each:

```dotenv
# Adam
GEMINI_API_KEY=AIza...
# D Data
#GEMINI_API_KEY=AIza...
```

On a 429 the ring comments the dry key out, uncomments the next, and rewrites
the file — so the next run *starts* on a key with room. Only the `#` moves;
lines, order, labels and line endings survive exactly, and `.env.bak` holds the
file as last written by hand.

`ENV_KEY_RING_PATH` points the ring at a shared file instead — mission-control's
`~/.env-key-ring/keys.env` is the same format, so one line borrows every key the
`ask-google` tool already rotates through.

**`.gitignore` must name `.env.bak` and `.env.tmp` explicitly.** The pattern
`.env` matches that one name, and both of those carry real key values.

### Resumable batches

Each finished text-cleanup batch lands in `.pipeline_cache/<date>.partial.json`
before the next one goes out, keyed by a hash of its own chunk. A failure on
batch 3 of 4 no longer discards batches 1 and 2, and the rerun reuses them for
zero API calls. The file gets deleted once the whole run lands.

### Tests

`npm test` — 106 assertions across `gui/lib/__tests__/`, no network and no real
`.env`. `retryLoop.test.js` stubs the SDK and the clock, so ten minutes of
patience costs no wall time, and drives the loop through a 503 spike, a dry key,
a revoked key, a ring gone dry, and an unusable reply.

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
