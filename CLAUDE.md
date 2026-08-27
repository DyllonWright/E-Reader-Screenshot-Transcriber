# E-Reader Screenshot Transcriber — agent notes

Pipeline: Tesseract OCR → header-color screen classification →
fuzzy dedup → illustration crop → Gemini batch formatting → daily
markdown at `output/YYYY-MM-DD.md`. Primary interface: the web GUI
(`gui/server.js`, port 3301); `processScreenshots.js` remains the
legacy headless CLI.

**Read `ARCHITECTURE.md` first** — data flow, endpoints, design
decisions. `GEMINI.md` carries the same orientation for the Gemini
CLI; keep both routing to `ARCHITECTURE.md` rather than duplicating.

- Run: `run.bat` (installs deps, starts GUI, opens browser), or
  `npm install` + `node gui/server.js`
- Requires `GEMINI_API_KEY` in `.env` (gitignored)
- `.ocr_cache/` and `.pipeline_cache/` rebuild on demand after deletion

## Gemini calls

Never call the SDK directly. `generateContentWithRetry` in `gui/server.js`
routes through `gui/lib/` — the key ring, the patience budget, the pacer —
and those three own decisions that used to sit conflated in one retry loop.
`ARCHITECTURE.md` carries the policy table.

- `.gitignore` must keep naming `.env.bak` and `.env.tmp`. The pattern `.env`
  matches that one name; the rotation writes the other two, and they hold real
  keys. This is a public repo.
- `npm test` runs `gui/lib/__tests__/` — no network, no real `.env`, stubbed
  clock. Run it after touching anything under `gui/lib/`.
