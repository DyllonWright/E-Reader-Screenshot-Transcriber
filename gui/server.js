// gui/server.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec, execFile } = require("child_process");
const os = require("os");
const Tesseract = require("tesseract.js");
const { Jimp } = require("jimp");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { KeyRing, fingerprint, defaultRingPath, scrubSecrets } = require("./lib/keyRing");
const geminiRetry = require("./lib/geminiRetry");
const { Pace } = require("./lib/geminiPace");

// Load initial environment
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.PORT || 3301;

// Enable large JSON payloads for base64 uploads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, "public")));

// Define core project directories relative to this file
const projectRoot   = path.join(__dirname, "..");
const screenshotsDir = path.join(projectRoot, "screenshots");
const outputDir      = path.join(projectRoot, "output");
const ocrCacheDir    = path.join(projectRoot, ".ocr_cache");
const metaFilePath   = path.join(projectRoot, "meta.json");
const pipelineCacheDir = path.join(projectRoot, ".pipeline_cache");
const archiveDir     = path.join(projectRoot, "archive");
const geminiStatsFilePath = path.join(projectRoot, "gemini_stats.json");

// Ensure baseline directories exist
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
if (!fs.existsSync(ocrCacheDir)) fs.mkdirSync(ocrCacheDir, { recursive: true });
if (!fs.existsSync(pipelineCacheDir)) fs.mkdirSync(pipelineCacheDir, { recursive: true });
if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- The Gemini key ring, the pacer, and this process's dead keys ---
//
// One ring over `.env`, read fresh on every call, so a rotation made by a
// previous run (or by hand between runs) gets picked up without a restart.
// Set `ENV_KEY_RING_PATH` in `.env` to borrow a shared ring — mission-control's
// `~/.env-key-ring/keys.env` is the same format, so one line here gives this
// pipeline every key the `ask-google` tool already rotates through.
const keys = new KeyRing({
  filePath: defaultRingPath(path.join(projectRoot, ".env")),
  log: (message) => console.log(`[Gemini Keys] ${message}`),
});

// The rate window and the per-key call budget. `dailyQuotaTarget` from the
// settings panel drives the budget, since that number is the owner saying what
// one key's day holds.
const pace = new Pace();

// Keys this PROCESS has proven unusable — revoked, wrong project, banned. Kept
// for the life of the server so the ring steps over one instead of rotating
// onto it, failing, and rotating again on every subsequent call.
const deadKeys = new Set();

// Dates with a `/api/process-stream` run in flight. The batch resume cache is
// one file per date, read whole and written whole, so two concurrent runs on
// one date would overwrite each other's finished batches.
const runningDates = new Set();

// Settle `.env` on exactly one active key at start-up. Two uncommented keys
// make every label a lie, and dotenv silently takes the last.
try {
  const tidied = keys.tidy();
  if (tidied.keys) {
    console.log(`[Gemini Keys] Ring holds ${tidied.keys} key(s); active: ${tidied.active}.`);
    if (tidied.dropped) console.log(`[Gemini Keys] Dropped ${tidied.dropped} duplicate line(s).`);
  }
} catch (err) {
  console.error("[Gemini Keys] Could not tidy .env:", err.message);
}

// Locate a screenshot by filename, falling back to the archive/<date>/ folders
// so finalized batches whose raw shots were archived can still preview/re-crop.
function findScreenshotPath(name, date = null) {
  const primary = path.join(screenshotsDir, name);
  if (fs.existsSync(primary)) return primary;
  if (date) {
    const dated = path.join(archiveDir, date, name);
    if (fs.existsSync(dated)) return dated;
  }
  if (fs.existsSync(archiveDir)) {
    for (const sub of fs.readdirSync(archiveDir)) {
      const candidate = path.join(archiveDir, sub, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Send a list of files to the Windows Recycle Bin (recoverable, not permanent).
// One PowerShell invocation handles the whole batch; paths are single-quote escaped.
function recycleFilesToBin(filePaths) {
  return new Promise((resolve, reject) => {
    if (!filePaths || filePaths.length === 0) return resolve();
    const psArray = filePaths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($f in @(${psArray})) { if (Test-Path -LiteralPath $f) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f,'OnlyErrorDialogs','SendToRecycleBin') } }`;
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve();
    });
  });
}

// Stamp a batch's pipeline cache as archived so /api/status can surface it in the
// "recently archived" strip even though its screenshots have left the input folder.
function markBatchArchived(date, mode, fileCount) {
  const cachePath = path.join(pipelineCacheDir, `${date}.json`);
  let data = {};
  if (fs.existsSync(cachePath)) {
    try { data = JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch (e) { data = {}; }
  }
  data.date = date;
  data.status = "archived";
  data.archiveMode = mode;
  data.archivedAt = new Date().toISOString();
  data.fileCount = fileCount;
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");
}

// --- Persistent State Helpers ---
function readMeta() {
  if (fs.existsSync(metaFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(metaFilePath, "utf8"));
      return { bookTitle: "", imageContexts: {}, recentBooks: [], dailyQuotaTarget: 50, ...data };
    } catch (err) {
      console.error("Error reading meta.json, resetting:", err);
    }
  }
  return { bookTitle: "", imageContexts: {}, recentBooks: [], dailyQuotaTarget: 50 };
}

function writeMeta(data) {
  fs.writeFileSync(metaFilePath, JSON.stringify(data, null, 2), "utf8");
}

// --- Gemini API Stats & Timing Helpers ---
function readGeminiStats() {
  if (fs.existsSync(geminiStatsFilePath)) {
    try {
      return JSON.parse(fs.readFileSync(geminiStatsFilePath, "utf8"));
    } catch (err) {
      console.error("Error reading gemini_stats.json, resetting:", err);
    }
  }
  return { lastRun: null, dailyStats: {}, history: [] };
}

function writeGeminiStats(data) {
  try {
    fs.writeFileSync(geminiStatsFilePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Error writing gemini_stats.json:", err);
  }
}

function recordGeminiCall(callDetail) {
  const stats = readGeminiStats();
  const utcDate = new Date().toISOString().split("T")[0]; // 24hr UTC window key e.g. "2026-07-22"
  
  if (!stats.dailyStats) stats.dailyStats = {};
  if (!stats.dailyStats[utcDate]) {
    stats.dailyStats[utcDate] = {
      utcDate,
      totalCalls: 0,
      totalRequests: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      models: {},
      calls: []
    };
  }

  const day = stats.dailyStats[utcDate];
  day.totalCalls += 1;
  // Google's meter counts REQUESTS. This one used to count calls, so a call
  // that took five attempts to get past a 503 landed here as 1 — which is how
  // 2026-07-27 recorded `totalCalls: 4` against 8 real requests, and why the
  // quota gauge read 20% at a genuine 40%. `totalCalls` stays for the older
  // days already in the file; `totalRequests` is the one the gauge reads.
  day.totalRequests = (day.totalRequests || 0) + (callDetail.requests || 1);
  day.totalDurationMs += callDetail.durationMs;
  day.avgDurationMs = Math.round(day.totalDurationMs / day.totalCalls);
  day.totalInputTokens += callDetail.inputTokens;
  day.totalOutputTokens += callDetail.outputTokens;
  day.totalTokens += callDetail.totalTokens;
  
  if (!day.models) day.models = {};
  day.models[callDetail.model] = (day.models[callDetail.model] || 0) + 1;
  
  if (!day.calls) day.calls = [];
  day.calls.unshift(callDetail);
  if (day.calls.length > 50) day.calls.pop();

  if (!stats.history) stats.history = [];
  stats.history.unshift(callDetail);
  if (stats.history.length > 100) stats.history.pop();

  writeGeminiStats(stats);
  return callDetail;
}

function recordLastRunStats(lastRunSummary) {
  const stats = readGeminiStats();
  stats.lastRun = lastRunSummary;
  writeGeminiStats(stats);
}

function parseDateTimeFromFilename(filename) {
  const match = filename.match(/^Screenshot_(\d{8})_(\d{6})/);
  if (!match) return null;
  const [, yyyymmdd, hhmmss] = match;
  const date = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  const time = `${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}`;
  return { date, time };
}

const TARGET_BLUE = { r: 63, g: 72, b: 99 };   // #3f4863
const TARGET_GREEN = { r: 60, g: 94, b: 81 };  // #3c5e51

function colorDistance(c1, c2) {
  return Math.sqrt((c1.r - c2.r)**2 + (c1.g - c2.g)**2 + (c1.b - c2.b)**2);
}

function checkHeaderColors(image) {
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  const midX = Math.floor(w / 2);

  let foundBlue = false;
  let foundGreen = false;

  const yBlueStart = Math.floor(h * 0.06);
  const yBlueEnd = Math.floor(h * 0.10);
  const yGreenStart = Math.floor(h * 0.09);
  const yGreenEnd = Math.floor(h * 0.14);

  // Scan for blue
  for (let y = yBlueStart; y <= yBlueEnd; y++) {
    const color = image.getPixelColor(midX, y);
    const r = (color >> 24) & 0xff;
    const g = (color >> 16) & 0xff;
    const b = (color >> 8) & 0xff;
    
    if (colorDistance({ r, g, b }, TARGET_BLUE) < 25) {
      foundBlue = true;
      break;
    }
  }

  // Scan for green
  for (let y = yGreenStart; y <= yGreenEnd; y++) {
    const color = image.getPixelColor(midX, y);
    const r = (color >> 24) & 0xff;
    const g = (color >> 16) & 0xff;
    const b = (color >> 8) & 0xff;
    
    if (colorDistance({ r, g, b }, TARGET_GREEN) < 25) {
      foundGreen = true;
      break;
    }
  }

  return foundBlue && foundGreen;
}

// Helper to calculate auto-crop boundaries based on content bounding box detection
function getAutoCropCoordinates(image) {
  const width = image.bitmap.width;
  const height = image.bitmap.height;

  // Sample corners to detect background color
  const corners = [
    image.getPixelColor(10, 10),
    image.getPixelColor(width - 10, 10),
    image.getPixelColor(10, height - 10),
    image.getPixelColor(width - 10, height - 10)
  ];
  
  const counts = {};
  let bgHex = corners[0];
  let maxCount = 0;
  for (const color of corners) {
    counts[color] = (counts[color] || 0) + 1;
    if (counts[color] > maxCount) {
      maxCount = counts[color];
      bgHex = color;
    }
  }

  const bgR = (bgHex >> 24) & 0xff;
  const bgG = (bgHex >> 16) & 0xff;
  const bgB = (bgHex >> 8) & 0xff;

  const threshold = 15;
  const startY = Math.floor(height * 0.08);
  const endY = Math.floor(height * 0.92);

  // Compute column and row activity profiles
  const colActive = new Int32Array(width);
  const rowActive = new Int32Array(height);

  for (let y = startY; y < endY; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = image.bitmap.data[idx];
      const g = image.bitmap.data[idx + 1];
      const b = image.bitmap.data[idx + 2];

      const diff = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
      if (diff > threshold) {
        colActive[x]++;
        rowActive[y]++;
      }
    }
  }

  // Helper to find intervals of activity
  function findIntervals(activityArray, startIdx, endIdx, noiseThreshold, maxGap) {
    const intervals = [];
    let currentInterval = null;

    for (let i = startIdx; i < endIdx; i++) {
      const isActive = activityArray[i] > noiseThreshold;
      if (isActive) {
        if (!currentInterval) {
          currentInterval = { start: i, end: i };
        } else {
          currentInterval.end = i;
        }
      } else {
        if (currentInterval) {
          let gapIsLarge = true;
          // Peek ahead to see if active pixels resume within maxGap
          for (let g = 1; g <= maxGap && i + g < endIdx; g++) {
            if (activityArray[i + g] > noiseThreshold) {
              gapIsLarge = false;
              break;
            }
          }
          if (gapIsLarge) {
            intervals.push(currentInterval);
            currentInterval = null;
          }
        }
      }
    }
    if (currentInterval) {
      intervals.push(currentInterval);
    }
    return intervals;
  }

  // Noise thresholds: ignore columns/rows with very few active pixels
  const colNoise = Math.max(2, Math.floor((endY - startY) * 0.005));
  const rowNoise = Math.max(2, Math.floor(width * 0.005));

  // Max gap to merge parts of the same illustration
  const colMaxGap = Math.floor(width * 0.02);
  const rowMaxGap = Math.floor(height * 0.05);

  const xIntervals = findIntervals(colActive, 0, width, colNoise, colMaxGap);
  const yIntervals = findIntervals(rowActive, startY, endY, rowNoise, rowMaxGap);

  let minX = 0, maxX = -1;
  if (xIntervals.length > 0) {
    // Sort descending by interval width to find the largest contiguous content block
    xIntervals.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    minX = xIntervals[0].start;
    maxX = xIntervals[0].end;
  }

  let minY = startY, maxY = -1;
  if (yIntervals.length > 0) {
    // Sort descending by interval height
    yIntervals.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    minY = yIntervals[0].start;
    maxY = yIntervals[0].end;
  }

  if (maxX >= minX && maxY >= minY) {
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;
    return { x: minX, y: minY, w: cropW, h: cropH };
  }

  // Fallback to full screen if bounds calculation failed
  return { x: 0, y: startY, w: width, h: endY - startY };
}


// --- Tesseract Initializer & Core Helpers ---
let schedulerPromise = null;
async function getTesseractScheduler() {
  if (schedulerPromise) return schedulerPromise;
  schedulerPromise = (async () => {
    const s = Tesseract.createScheduler();
    const numCPUs = os.cpus().length;
    const numWorkers = Math.max(1, Math.min(4, numCPUs - 1));
    console.log(`[Tesseract] Initializing scheduler with ${numWorkers} workers...`);
    for (let i = 0; i < numWorkers; i++) {
      const worker = await Tesseract.createWorker("eng");
      s.addWorker(worker);
    }
    return s;
  })();
  return schedulerPromise;
}

// Perform fast background OCR for a single file if uncached
async function ensureOcrCached(filename, filePath) {
  const cachePath = path.join(ocrCacheDir, `${filename}.json`);
  const currentMtime = fs.statSync(filePath).mtimeMs;
  let cachedText = null;
  let cachedIsTextPage = null;

  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (cached.mtime === currentMtime) {
        cachedText = cached.text;
        cachedIsTextPage = cached.isTextPage;
      }
    } catch (e) {
      // Corrupt cache file, re-run
    }
  }

  // If fully cached (text + classification), return both
  if (cachedText !== null && cachedIsTextPage !== undefined) {
    return { text: cachedText, isTextPage: cachedIsTextPage };
  }

  // If text is cached but missing classification, perform color analysis and write back to cache
  if (cachedText !== null && cachedIsTextPage === undefined) {
    let isText = false;
    try {
      const image = await Jimp.read(filePath);
      isText = checkHeaderColors(image);
    } catch (err) {
      console.error(`Error checking header colors for ${filename}:`, err);
    }
    fs.writeFileSync(cachePath, JSON.stringify({ text: cachedText, isTextPage: isText, mtime: currentMtime }), "utf8");
    return { text: cachedText, isTextPage: isText };
  }

  console.log(`[OCR Cache Miss] Running OCR & pixel analysis for: ${filename}`);
  const activeScheduler = await getTesseractScheduler();
  const { data: { text } } = await activeScheduler.addJob("recognize", filePath);

  let isText = false;
  try {
    const image = await Jimp.read(filePath);
    isText = checkHeaderColors(image);
  } catch (err) {
    console.error(`Error checking header colors for ${filename}:`, err);
  }

  fs.writeFileSync(cachePath, JSON.stringify({ text, isTextPage: isText, mtime: currentMtime }), "utf8");
  return { text, isTextPage: isText };
}

// --- Background OCR Queue & Progress Tracking ---
let isOcrRunning = false;
let ocrTotal = 0;
let ocrProcessed = 0;

async function runBackgroundOcr() {
  if (isOcrRunning) return;
  isOcrRunning = true;
  
  try {
    while (true) {
      if (!fs.existsSync(screenshotsDir)) break;
      const files = fs.readdirSync(screenshotsDir).filter((f) => /\.(jpe?g|png)$/i.test(f));
      
      const uncachedFiles = [];
      for (const file of files) {
        const filePath = path.join(screenshotsDir, file);
        const cachePath = path.join(ocrCacheDir, `${file}.json`);
        let needsOcr = true;
        
        if (fs.existsSync(cachePath)) {
          try {
            const currentMtime = fs.statSync(filePath).mtimeMs;
            const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
            if (cached.mtime === currentMtime) {
              needsOcr = false;
            }
          } catch (e) {
            // Corrupt cache
          }
        }
        
        if (needsOcr) {
          uncachedFiles.push({ file, path: filePath });
        }
      }
      
      if (uncachedFiles.length === 0) break;
      
      ocrTotal = uncachedFiles.length;
      ocrProcessed = 0;
      console.log(`[Background OCR] Starting background processing of ${ocrTotal} screenshots...`);
      
      await Promise.all(uncachedFiles.map(async (item) => {
        try {
          await ensureOcrCached(item.file, item.path);
          ocrProcessed++;
          console.log(`[Background OCR] Progress: ${ocrProcessed}/${ocrTotal} (${item.file})`);
        } catch (err) {
          console.error(`[Background OCR] Error for ${item.file}:`, err);
          ocrProcessed++;
        }
      }));
    }
  } catch (err) {
    console.error("[Background OCR] Fatal error in runner:", err);
  } finally {
    isOcrRunning = false;
    ocrTotal = 0;
    ocrProcessed = 0;
    console.log(`[Background OCR] Background OCR runner exited.`);
  }
}

// --- Gemini Retries & API Config ---

// Tries for a reply that ARRIVED and came back unusable — empty, or not the
// JSON the caller asked for. Kept separate from the transient budget on
// purpose: resending a prompt the model answers badly is not weather, and a
// busy server said nothing at all about the prompt.
const CONTENT_RETRIES = 3;

const GEMINI_MODEL = "gemini-flash-latest";

// `scrubSecrets` comes from `lib/keyRing` so the CLI applies the same guard.
// It lived here for a while, which meant `processScreenshots.js` wrote raw
// error text into the same stats file — a guard half the callers apply.

/**
 * Send one prompt, waiting out a busy server and rotating off a dry key.
 *
 * Replaces a loop that retried five times on `2000 * 2**attempt` — 2s, 4s, 8s,
 * 16s, THIRTY SECONDS of patience — and that fed 503 and 429 through one
 * branch on one budget. The two faults want opposite moves: a 503 clears if you
 * wait, and a 429 on a free key never does, because the ceiling it names resets
 * tomorrow. See `lib/geminiRetry.js` for the table.
 *
 * `meta.validate` optionally takes the reply text and returns a complaint
 * string when it reads as unusable. That draws on `CONTENT_RETRIES`, never on
 * the transient budget.
 */
async function generateContentWithRetry(prompt, onStatusUpdate = null, meta = {}) {
  const note = (message) => {
    console.log(`[Gemini API] ${message}`);
    if (onStatusUpdate) onStatusUpdate(message);
  };

  let activeKey = keys.key() || process.env.GEMINI_API_KEY || "";
  if (!activeKey) {
    throw new Error("No GEMINI_API_KEY found. Add one in Settings, or put it in .env.");
  }
  const buildModel = (key) =>
    new GoogleGenerativeAI(key).getGenerativeModel({ model: GEMINI_MODEL });
  let model = buildModel(activeKey);

  // Each OTHER key in the ring gets one shot at this call before the ring
  // gives up. A ring of one still waits out a 503; it just cannot rotate.
  const patience = new geminiRetry.Patience(Math.max(1, keys.size()));
  const startTime = Date.now();
  let contentAttempt = 0;

  note(keys.size() > 1
    ? `Contacting Gemini (key "${(keys.active() || {}).label}", ${keys.size()} in the ring)...`
    : "Contacting Gemini API...");

  while (true) {
    // -- pace first, and outside the timing below -------------------------
    // The wait belongs to us, not to the model, and folding it into the
    // recorded duration would report every call as suddenly slower. A RETRY
    // pays it too: a retry is a request, and the window counting them does not
    // care why it went out.
    //
    // An anticipatory rotation deliberately does NOT spend a `rotations`
    // budget. That budget means "each key gets one shot at THIS call"; charging
    // it for a rotation that happened because a key filled up, between two
    // calls that both worked, would eat a call's error headroom before the call
    // had even been sent.
    const keyId = fingerprint(activeKey);
    if (pace.dueForRotation(keyId)) {
      const spentOnKey = pace.spent(keyId);
      const next = keys.rotate({ exhausted: activeKey, skip: Array.from(deadKeys) });
      if (next) {
        pace.clearKey(keyId);
        activeKey = next.key;
        model = buildModel(activeKey);
        note(`Rotated ahead of the ceiling — ${spentOnKey} calls on the last key, now on "${next.label}".`);
      }
    }
    // Wait for the slot and claim it in one step. Two streams reading the
    // clock separately could each decide the window was clear and fire
    // together; `reserve` queues them instead.
    await pace.reserve(fingerprint(activeKey), (owed) => {
      if (owed > 500) note(`Holding ${Math.round(owed / 1000)}s for the rate window.`);
    });

    const keyLabel = (keys.active() || {}).label || null;
    patience.sent();

    let result = null;
    let responseText = "";
    let usage = {};
    let apiError = null;
    try {
      result = await model.generateContent(prompt);
      // `.text()` throws on a blocked or empty candidate, which classifies
      // FATAL and stops — correct, since a safety block does not clear by
      // being asked again.
      responseText = result.response ? result.response.text() : "";
      usage = (result.response && result.response.usageMetadata) || {};
    } catch (error) {
      apiError = error;
    }

    // -- the call broke -----------------------------------------------------
    if (apiError) {
      const status = geminiRetry.statusOf(apiError);
      let move = patience.consider(apiError);

      if (move === geminiRetry.Patience.ROTATE) {
        if (KeyRing.isDeadKeyError(apiError)) {
          note(`Key "${keyLabel}" (${fingerprint(activeKey)}) refused this call — skipping it for this run.`);
          deadKeys.add(activeKey);
        } else {
          note(`Key "${keyLabel}" is out of room (${status || "429"}) — rotating rather than waiting out a ceiling that resets tomorrow.`);
        }
        const next = keys.rotate({ exhausted: activeKey, skip: Array.from(deadKeys) });
        if (next) {
          activeKey = next.key;
          model = buildModel(activeKey);
          // Deliberately NOT clearing any pace count here. An earlier version
          // cleared `fingerprint(activeKey)` AFTER the reassignment, which
          // wiped the count of the key being rotated ONTO — so a key already
          // part-spent this session got a fresh 20-call budget and sailed past
          // the ceiling the pacer exists to anticipate. The old key's count
          // does not matter (it is dry); the new key's very much does.
          patience.rotated();
          continue;                       // retry AT ONCE, spending no transient try
        }
        move = geminiRetry.Patience.STOP;  // ring walked, nothing left to try
      }

      if (move === geminiRetry.Patience.WAIT && patience.afford(apiError)) {
        note(patience.waitingLine(apiError));
        await patience.rest();
        continue;
      }

      const durationMs = Date.now() - startTime;
      note(patience.closingLine(apiError));
      recordGeminiCall({
        type: meta.type || "general",
        model: GEMINI_MODEL,
        durationMs,
        durationSec: parseFloat((durationMs / 1000).toFixed(2)),
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: 0,
        totalTokens: Math.ceil(prompt.length / 4),
        timestamp: new Date().toISOString(),
        itemCount: meta.itemCount || 1,
        status: "error",
        error: scrubSecrets(apiError.message),
        httpStatus: status || null,
        attempts: patience.transient + 1,
        requests: patience.requests,
        rotations: patience.rotations,
        keyFingerprint: fingerprint(activeKey),
      });
      throw apiError;
    }

    // -- a reply arrived; is it usable? -------------------------------------
    if (typeof meta.validate === "function") {
      const complaint = meta.validate(responseText);
      if (complaint) {
        contentAttempt += 1;
        if (contentAttempt < CONTENT_RETRIES) {
          note(`Gemini returned an unusable reply (${complaint}) — attempt ${contentAttempt + 1}/${CONTENT_RETRIES}.`);
          await geminiRetry.sleep(2000 * contentAttempt);
          continue;
        }
        const durationMs = Date.now() - startTime;
        const giveUp = new Error(`Gemini returned an unusable reply after ${CONTENT_RETRIES} attempts: ${complaint}`);
        recordGeminiCall({
          type: meta.type || "general",
          model: GEMINI_MODEL,
          durationMs,
          durationSec: parseFloat((durationMs / 1000).toFixed(2)),
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: Math.ceil(responseText.length / 4),
          totalTokens: Math.ceil((prompt.length + responseText.length) / 4),
          timestamp: new Date().toISOString(),
          itemCount: meta.itemCount || 1,
          status: "error",
          error: scrubSecrets(giveUp.message),
          attempts: contentAttempt,
          requests: patience.requests,
          rotations: patience.rotations,
          keyFingerprint: fingerprint(activeKey),
        });
        throw giveUp;
      }
    }

    const durationMs = Date.now() - startTime;
    const durationSec = parseFloat((durationMs / 1000).toFixed(2));
    note(`Response received in ${durationSec}s.`);

    const inputTokens = usage.promptTokenCount !== undefined ? usage.promptTokenCount : Math.ceil(prompt.length / 4);
    const outputTokens = usage.candidatesTokenCount !== undefined ? usage.candidatesTokenCount : Math.ceil(responseText.length / 4);
    const totalTokens = usage.totalTokenCount !== undefined ? usage.totalTokenCount : (inputTokens + outputTokens);

    const callStat = {
      type: meta.type || "general",
      model: GEMINI_MODEL,
      durationMs,
      durationSec,
      inputTokens,
      outputTokens,
      totalTokens,
      timestamp: new Date().toISOString(),
      itemCount: meta.itemCount || 1,
      status: "success",
      attempts: patience.transient + contentAttempt + 1,
      // Every HTTP request this call really sent. `attempts` counts what the
      // GUI shows a person; THIS is what Google's meter counted, and reading
      // one as the other is how a 20-request day showed as 4 calls.
      requests: patience.requests,
      rotations: patience.rotations,
      // The fingerprint, never the label: a label is editable in `.env` and two
      // could collide, merging two keys' budgets into one counter.
      keyFingerprint: fingerprint(activeKey),
    };

    recordGeminiCall(callStat);
    return { result, responseText, durationMs, callStat };
  }
}

// Fuzzy overlap check logic
function fuzzRatio(s1, s2) {
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;
  
  const maxLen = len2 + 1;
  let prev = new Int32Array(maxLen);
  let curr = new Int32Array(maxLen);
  
  for (let j = 0; j <= len2; j++) {
    prev[j] = j * 2;
  }
  
  for (let i = 1; i <= len1; i++) {
    curr[0] = i * 2;
    const char1 = s1[i - 1];
    for (let j = 1; j <= len2; j++) {
      const cost = char1 === s2[j - 1] ? 0 : 2;
      curr[j] = Math.min(
        curr[j - 1] + 2,
        prev[j] + 2,
        prev[j - 1] + cost
      );
    }
    const temp = prev;
    prev = curr;
    curr = temp;
  }
  
  const distance = prev[len2];
  return Math.round(((len1 + len2 - distance) / (len1 + len2)) * 100);
}

function findOverlapFuzzy(previousText, newText, anchorWordCount = 12, threshold = 80) {
  const prevWords = previousText.replace(/\s+/g, " ").trim().split(" ");
  const newWords = newText.replace(/\s+/g, " ").trim().split(" ");

  if (prevWords.length < 8 || newWords.length < 8) {
    const normPrev = prevWords.join(" ").toLowerCase();
    const normNew = newWords.join(" ").toLowerCase();
    if (normPrev.includes(normNew)) {
      return { isDuplicate: true, score: 100 };
    }
    return null;
  }

  let bestScore = 0;
  let bestJ = 0, bestK = 0, bestL = 0;
  const maxJ = Math.min(newWords.length - anchorWordCount, 25);
  const maxK = Math.min(prevWords.length - anchorWordCount, 35);

  for (let k = 0; k <= maxK; k++) {
    const anchorWords = prevWords.slice(prevWords.length - k - anchorWordCount, prevWords.length - k);
    const anchorStr = anchorWords.join(" ");

    for (let j = 0; j <= maxJ; j++) {
      const minL = Math.max(3, anchorWordCount - 3);
      const maxL = Math.min(newWords.length - j, anchorWordCount + 3);

      for (let L = minL; L <= maxL; L++) {
        const candidateStr = newWords.slice(j, j + L).join(" ");
        const score = fuzzRatio(anchorStr, candidateStr);

        if (score > bestScore) {
          bestScore = score;
          bestJ = j;
          bestK = k;
          bestL = L;
        }
      }
    }
  }

  if (bestScore >= threshold) {
    const overlapEndInNew = bestJ + bestL + bestK;
    const remainingWords = newWords.length - overlapEndInNew;
    if (remainingWords <= 4) {
      return { isDuplicate: true, score: bestScore };
    }
    const trimmedPreviousText = prevWords.slice(0, prevWords.length - bestK).join(" ");
    const trimmedNewText = newWords.slice(bestJ + bestL).join(" ");

    return {
      isDuplicate: false,
      trimmedPreviousText,
      newText: trimmedNewText,
      score: bestScore
    };
  }
  return null;
}

// --- Endpoints ---

// Serve raw screenshots (checks the input folder first, then archived batches)
app.get("/api/screenshot/:name", (req, res) => {
  const filePath = findScreenshotPath(req.params.name, req.query.date || null);
  if (filePath) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("File not found");
  }
});

// Serve cropped images (supports live final output folder preview)
app.get("/api/cropped/:date/:name", (req, res) => {
  const filePath = path.join(outputDir, `${req.params.date} Extracted Images`, req.params.name);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("Cropped image not found");
  }
});

// Get overall status: settings, screenshots list and types
app.get("/api/status", async (req, res) => {
  try {
    const meta = readMeta();
    const files = fs.existsSync(screenshotsDir) 
      ? fs.readdirSync(screenshotsDir).filter((f) => /\.(jpe?g|png)$/i.test(f))
      : [];
    
    // Group files by date
    const dailyGroups = {};
    for (const file of files) {
      const dt = parseDateTimeFromFilename(file);
      if (!dt) continue;
      if (!dailyGroups[dt.date]) dailyGroups[dt.date] = [];
      dailyGroups[dt.date].push({ file, path: path.join(screenshotsDir, file), time: dt.time });
    }

    const dates = Object.keys(dailyGroups).sort();
    const resultGroups = {};
    const datesInfo = [];
    let totalUncached = 0;

    for (const date of dates) {
      const batch = dailyGroups[date];
      batch.sort((a, b) => a.file.localeCompare(b.file));
      
      const totalFiles = batch.length;
      let ocrCachedCount = 0;

      const items = batch.map((item) => {
        const cachePath = path.join(ocrCacheDir, `${item.file}.json`);
        let type = "pending";
        let rawText = "";
        let isCached = false;
        
        if (fs.existsSync(cachePath)) {
          try {
            const currentMtime = fs.statSync(item.path).mtimeMs;
            const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
            if (cached.mtime === currentMtime && cached.isTextPage !== undefined) {
              rawText = cached.text;
              type = cached.isTextPage ? "text" : "image";
              isCached = true;
              ocrCachedCount++;
            }
          } catch (e) {
            // Corrupt cache
          }
        }
        
        if (!isCached) {
          totalUncached++;
        }

        const savedContext = meta.imageContexts[item.file] || "";
        return {
          file: item.file,
          time: item.time,
          type,
          rawText: rawText ? rawText.substring(0, 300) : "",
          savedContext,
          isPending: !isCached
        };
      });

      resultGroups[date] = items;

      // Determine batch status. Palette (UI): ocr_active = Analyzing (cyan pulse),
      // ocr_done = Ready (green/go), paused = Resume Draft (amber), completed = Finalized
      // (violet). Archived batches have no live screenshots and surface via archivedInfo.
      let status = "ocr_active";
      if (ocrCachedCount === totalFiles) {
        const cacheFilePath = path.join(pipelineCacheDir, `${date}.json`);
        const finalMdPath = path.join(outputDir, `${date}.md`);
        
        if (fs.existsSync(cacheFilePath)) {
          try {
            const cacheData = JSON.parse(fs.readFileSync(cacheFilePath, "utf8"));
            if (cacheData.status === "archived") {
              // Batch was archived/cleared previously, yet fresh screenshots exist for
              // this date again — treat it as a new, ready-to-process batch.
              status = "ocr_done";
            } else if (cacheData.status === "completed" && fs.existsSync(finalMdPath)) {
              status = "completed";
            } else if (cacheData.draftContent) {
              status = "paused";
            } else {
              status = "ocr_done";
            }
          } catch (e) {
            status = "ocr_done";
          }
        } else {
          status = "ocr_done";
        }
      }

      datesInfo.push({
        date,
        totalFiles,
        ocrCachedCount,
        status
      });
    }

    // Proactively run background OCR if there are uncached screenshots
    if (totalUncached > 0 && !isOcrRunning) {
      runBackgroundOcr().catch((err) => {
        console.error("Error in background OCR runner startup:", err);
      });
    }

    // Build the archived-batches list from pipeline caches whose screenshots have
    // already been cleared. Dates with live screenshots are excluded (active wins).
    const activeDatesSet = new Set(dates);
    const archivedInfo = [];
    if (fs.existsSync(pipelineCacheDir)) {
      for (const f of fs.readdirSync(pipelineCacheDir)) {
        if (!f.endsWith(".json")) continue;
        // `<date>.partial.json` holds resumable Gemini batches, not a day's
        // cache. It carries no `status`, so it fell through harmlessly — but a
        // date named `2026-08-27.partial` reads as a bug waiting to be found.
        if (f.endsWith(".partial.json")) continue;
        const d = f.replace(/\.json$/, "");
        if (activeDatesSet.has(d)) continue;
        try {
          const c = JSON.parse(fs.readFileSync(path.join(pipelineCacheDir, f), "utf8"));
          if (c.status === "archived") {
            archivedInfo.push({
              date: d,
              fileCount: c.fileCount || 0,
              mode: c.archiveMode || "archive",
              archivedAt: c.archivedAt || null,
              status: "archived"
            });
          }
        } catch (e) {
          // Skip unreadable cache
        }
      }
      archivedInfo.sort((a, b) => b.date.localeCompare(a.date));
    }

    const ring = keys.describe();
    const activeEntry = ring.find((e) => e.active) || ring[0] || null;
    const statsData = readGeminiStats();
    res.json({
      success: true,
      bookTitle: meta.bookTitle || "",
      recentBooks: Array.isArray(meta.recentBooks) ? meta.recentBooks : [],
      dailyQuotaTarget: meta.dailyQuotaTarget || 50,
      apiKeyPresent: ring.length > 0,
      // A LABEL and a FINGERPRINT, where this used to send
      // `key.slice(0,6) + "..." + key.slice(-4)`. Those ten characters of a
      // real key, published together, narrow a brute force more than nothing
      // does — and the label is the thing a person actually recognises.
      apiKeyMasked: activeEntry ? `${activeEntry.label} · ${activeEntry.fingerprint}` : "",
      keyRing: ring,
      dates,
      datesInfo,
      archivedInfo,
      groups: resultGroups,
      ocrActive: isOcrRunning || totalUncached > 0,
      ocrTotal: isOcrRunning ? ocrTotal : totalUncached,
      ocrProcessed: isOcrRunning ? ocrProcessed : 0,
      totalUncached,
      dailyQuotaTarget: meta.dailyQuotaTarget || 50,
      lastRunStats: statsData.lastRun || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint to fetch full Gemini API stats and 24hr UTC windows breakdown
app.get("/api/gemini-stats", (req, res) => {
  try {
    const stats = readGeminiStats();
    const meta = readMeta();
    res.json({ success: true, stats, dailyQuotaTarget: meta.dailyQuotaTarget || 50 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint to reset/clear Gemini stats history if desired by user in dev debug
app.post("/api/clear-gemini-stats", (req, res) => {
  try {
    writeGeminiStats({ lastRun: null, dailyStats: {}, history: [] });
    res.json({ success: true, message: "Gemini stats cleared successfully!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Load saved pipeline cache for a specific date batch
app.get("/api/load-cache", (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ success: false, error: "Missing date parameter" });
  }

  const cacheFilePath = path.join(pipelineCacheDir, `${date}.json`);
  if (fs.existsSync(cacheFilePath)) {
    try {
      const cacheData = JSON.parse(fs.readFileSync(cacheFilePath, "utf8"));
      res.json({ success: true, cache: cacheData });
    } catch (err) {
      res.status(500).json({ success: false, error: "Failed to parse cache: " + err.message });
    }
  } else {
    res.status(404).json({ success: false, error: "No cache found for date: " + date });
  }
});

// Update settings: global Book Title (meta.json), API Key (.env), and dailyQuotaTarget
app.post("/api/settings", (req, res) => {
  const { bookTitle, apiKey, dailyQuotaTarget } = req.body;
  
  try {
    const meta = readMeta();
    const newTitle = (bookTitle || "").trim();
    // Only overwrite the stored book when a non-empty title arrives. The settings
    // form re-sends the book field on every save (e.g. when saving just an API
    // key), so writing an empty string here would silently wipe the book — that is
    // exactly how it got lost before. A blank field now leaves the book untouched.
    if (newTitle) {
      meta.bookTitle = newTitle;
      const recent = Array.isArray(meta.recentBooks) ? meta.recentBooks : [];
      const filtered = recent.filter((b) => b && b.toLowerCase() !== newTitle.toLowerCase());
      filtered.unshift(newTitle);
      meta.recentBooks = filtered.slice(0, 3);
    }

    if (dailyQuotaTarget && !isNaN(Number(dailyQuotaTarget)) && Number(dailyQuotaTarget) > 0) {
      meta.dailyQuotaTarget = Number(dailyQuotaTarget);
    }
    writeMeta(meta);

    // An UPSERT into the key ring, never a rewrite of `.env`.
    //
    // This line used to be `writeFileSync(".env", "GEMINI_API_KEY=" + key)`,
    // which replaced the whole file with one line — every commented-out spare
    // in the ring destroyed, on a save the user meant as "use this key".
    // `setKey` activates the key when the ring already knows it and appends a
    // labelled entry when it does not.
    if (apiKey && apiKey.trim().length > 0) {
      keys.setKey(apiKey.trim(), (req.body.apiKeyLabel || "").trim() || null);
    }

    // A changed daily target changes when the pacer rotates ahead of a ceiling.
    pace.configure({ callsPerKey: meta.dailyQuotaTarget });
    
    res.json({ success: true, message: "Settings saved successfully!" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save image contexts typed by the user
app.post("/api/save-contexts", (req, res) => {
  const { contexts } = req.body;
  try {
    const meta = readMeta();
    meta.imageContexts = { ...meta.imageContexts, ...contexts };
    writeMeta(meta);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Upload a single screenshot file (JSON payload with base64)
app.post("/api/upload", async (req, res) => {
  const { name, data } = req.body;
  if (!name || !data) {
    return res.status(400).json({ success: false, error: "Missing name or base64 data" });
  }

  try {
    const base64Data = data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    const outPath = path.join(screenshotsDir, name);
    fs.writeFileSync(outPath, buffer);

    // Run quick background OCR immediately so it's ready and cached
    await ensureOcrCached(name, outPath);
    
    res.json({ success: true, message: `Uploaded and OCR'd ${name}` });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// SSE Endpoint for tracking batch processing state
app.get("/api/process-stream", async (req, res) => {
  const date = req.query.date;
  if (!date) {
    return res.status(400).send("Missing date parameter");
  }

  const stage2StartTime = Date.now();
  const processCallStats = [];

  // Setup Server-Sent Events headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type, message, extra = {}) => {
    res.write(`data: ${JSON.stringify({ type, message, ...extra })}\n\n`);
  };

  // SINGLE FLIGHT per date. Two tabs on the same batch would each load
  // `<date>.partial.json` into their own object and then write the whole file
  // back — so each one's finished batches erase the other's, and both pay
  // Gemini for work the other already did. One run per date at a time removes
  // the race rather than trying to merge around it.
  if (runningDates.has(date)) {
    sendEvent("error", `A run for ${date} is already in progress. Wait for it to finish, or reload once it completes.`);
    return res.end();
  }
  runningDates.add(date);
  res.on("close", () => runningDates.delete(date));

  try {
    // The RING decides which key runs, not the environment: a rotation written
    // to `.env` by an earlier run has to take effect without a restart.
    if (!keys.size() && !process.env.GEMINI_API_KEY) {
      sendEvent("error", "No Gemini API key found. Please save a valid key in the settings panel.");
      return res.end();
    }
    if (keys.size() > 1) {
      sendEvent("log", `Key ring: ${keys.size()} keys, starting on "${(keys.active() || {}).label}".`);
    }

    sendEvent("log", `Initializing batch process for ${date}...`);
    const meta = readMeta();
    const files = fs.readdirSync(screenshotsDir).filter((f) => /\.(jpe?g|png)$/i.test(f));

    const dayFiles = [];
    for (const file of files) {
      const dt = parseDateTimeFromFilename(file);
      if (dt && dt.date === date) {
        dayFiles.push({ file, path: path.join(screenshotsDir, file), time: dt.time });
      }
    }

    if (dayFiles.length === 0) {
      sendEvent("error", `No screenshots found matching date ${date}.`);
      return res.end();
    }

    dayFiles.sort((a, b) => a.file.localeCompare(b.file));
    sendEvent("log", `Found ${dayFiles.length} screenshots to process.`);

    // Step 1: Resolve OCR (should be 100% cached at this stage due to status page precaching)
    sendEvent("log", "Step 1: Reading OCR cache results...");
    const ocrStartTime = Date.now();
    let ocrHits = 0;
    let ocrMisses = 0;
    const ocrItems = [];
    for (let i = 0; i < dayFiles.length; i++) {
      const item = dayFiles[i];
      const cachePath = path.join(ocrCacheDir, `${item.file}.json`);
      const isCachedBefore = fs.existsSync(cachePath);
      const { text, isTextPage } = await ensureOcrCached(item.file, item.path);
      if (isCachedBefore) ocrHits++; else ocrMisses++;
      const type = isTextPage ? "text" : "image";
      ocrItems.push({ ...item, rawText: text, type });
      sendEvent("progress", `OCR read: ${i + 1}/${dayFiles.length}`, { value: Math.round(((i + 1) / dayFiles.length) * 30) });
    }
    const ocrDurationMs = Date.now() - ocrStartTime;
    const ocrHitRatePct = dayFiles.length > 0 ? parseFloat(((ocrHits / dayFiles.length) * 100).toFixed(1)) : 100;

    // Step 2: Gemini Contextual Naming mappings (Illustration placeholders)
    sendEvent("log", "Step 2: Naming illustrations via Gemini...");
    const imageItems = ocrItems.filter(item => item.type === "image");
    
    if (imageItems.length > 0) {
      sendEvent("log", `Found ${imageItems.length} illustrations. Bundling into a single Gemini naming query...`);
      
      const illustrationsPromptData = [];
      let tempIllIndex = 1;
      
      for (let i = 0; i < ocrItems.length; i++) {
        const item = ocrItems[i];
        if (item.type === "image") {
          // Find surrounding text context
          let prevText = "";
          for (let p = i - 1; p >= 0; p--) {
            if (ocrItems[p].type === "text") {
              prevText = ocrItems[p].rawText;
              break;
            }
          }
          let nextText = "";
          for (let n = i + 1; n < ocrItems.length; n++) {
            if (ocrItems[n].type === "text") {
              nextText = ocrItems[n].rawText;
              break;
            }
          }
          
          const customDescription = meta.imageContexts[item.file] || "";
          
          illustrationsPromptData.push({
            index: tempIllIndex++,
            file: item.file,
            time: item.time,
            prevText: prevText.substring(0, 1000),
            nextText: nextText.substring(0, 1000),
            userNotes: customDescription
          });
        }
      }
      
      const illustrationsListFormatted = illustrationsPromptData.map(d => {
        return `ILLUSTRATION #${d.index}:
- FILENAME: "${d.file}"
- TIME: "${d.time}"
- PREVIOUS TEXT CONTEXT: "${d.prevText}"
- NEXT TEXT CONTEXT: "${d.nextText}"
- USER NOTES/DESCRIPTION: "${d.userNotes || 'None'}"
---`;
      }).join("\n\n");

      const bookTitleHeader = meta.bookTitle ? `GLOBAL BOOK TITLE PROVIDED BY USER: "${meta.bookTitle}"\n` : "";

      const prompt = `You are a book illustration archivist. I have a batch of full-screen illustration screenshots taken from an e-reader on the date ${date}.

I need you to generate a descriptive, Windows-safe filename for EACH illustration. I am providing the surrounding text context and any user-provided notes for each illustration.

${bookTitleHeader}
Here is the list of illustrations to process:
===
${illustrationsListFormatted}
===

Based on this context, please identify for EACH illustration:
1. The title of the book (shortened to a clean, brief format, e.g. "Cosmic Trigger III"). If the book title was provided in the prompt context, use it.
2. A very short, descriptive description of what this illustration is showing based on the context and user description (e.g. "TV Parable" or "Anna OOTE"). Make sure it is safe for Windows filenames (no colons, slashes, backslashes, asterisks, question marks, quotes, or pipe characters, maximum 4-5 words).

Return ONLY a JSON array of objects with this exact structure (no markdown fences, no formatting, just raw JSON array):
[
  {
    "file": "Screenshot_filename.jpg",
    "bookTitle": "Shortened Book Title",
    "description": "Short Description",
    "filename": "YYYY MM DD Shortened Book Title Short Description.jpg"
  }
]`;

      try {
        // The reply has to parse as a JSON array. Checking it HERE, through
        // `validate`, means a malformed reply draws on its own budget of three
        // and gets resent — where before, one bad reply threw straight out of
        // `JSON.parse` and killed the whole run.
        const cleanJson = (text) => text.replace(/```json/g, "").replace(/```/g, "").trim();
        const { responseText, callStat } = await generateContentWithRetry(prompt, (statusMsg) => {
          sendEvent("log", `  [Gemini Naming] ${statusMsg}`);
          sendEvent("progress", `Gemini Naming: ${statusMsg}`, { value: 30 });
        }, {
          type: "naming",
          itemCount: imageItems.length,
          validate: (text) => {
            const cleaned = cleanJson(text);
            if (!cleaned) return "empty reply";
            try {
              return Array.isArray(JSON.parse(cleaned)) ? null : "not a JSON array";
            } catch (e) {
              return `invalid JSON: ${e.message}`;
            }
          },
        });

        if (callStat) processCallStats.push(callStat);
        const suggestedList = JSON.parse(cleanJson(responseText));
        
        // Map suggested names back to items
        const suggestionMap = {};
        if (Array.isArray(suggestedList)) {
          suggestedList.forEach(s => {
            if (s.file) suggestionMap[s.file] = s;
          });
        }
        
        let illIndex = 1;
        for (let i = 0; i < ocrItems.length; i++) {
          const item = ocrItems[i];
          if (item.type === "image") {
            const suggestion = suggestionMap[item.file];
            const sanitize = (s) => s.replace(/[\/\\?%*:|"<>]/g, "").replace(/\s+/g, " ").trim();
            
            let finalName = "";
            if (suggestion && (suggestion.filename || (suggestion.bookTitle && suggestion.description))) {
              const bookTitle = sanitize(suggestion.bookTitle || meta.bookTitle || "Book");
              const description = sanitize(suggestion.description || `Illustration ${illIndex}`);
              finalName = `${date.replace(/-/g, " ")} ${bookTitle} ${description}.jpg`;
            } else {
              const bookFallback = meta.bookTitle ? meta.bookTitle.replace(/[\/\\?%*:|"<>]/g, "") : "Book";
              finalName = `${date.replace(/-/g, " ")} ${bookFallback} Illustration ${illIndex}.jpg`;
            }
            
            item.illustrationFilename = finalName;
            sendEvent("log", `  → Suggested for ${item.file}: "${finalName}"`);
            item.rawText = `[IMAGE: ${item.illustrationFilename}]`;
            illIndex++;
          }
        }
      } catch (err) {
        sendEvent("log", `⚠️ Failed to batch name via Gemini: ${err.message}. Using sequential fallbacks.`);
        console.error("Batch naming error:", err);
        
        let illIndex = 1;
        for (let i = 0; i < ocrItems.length; i++) {
          const item = ocrItems[i];
          if (item.type === "image") {
            const bookFallback = meta.bookTitle ? meta.bookTitle.replace(/[\/\\?%*:|"<>]/g, "") : "Book";
            const finalName = `${date.replace(/-/g, " ")} ${bookFallback} Illustration ${illIndex}.jpg`;
            item.illustrationFilename = finalName;
            item.rawText = `[IMAGE: ${item.illustrationFilename}]`;
            illIndex++;
          }
        }
      }
    }

    // Step 3: Fuzzy Overlap Deduplication on Text Pages
    sendEvent("log", "Step 3: Performing fuzzy deduplication on text overlap screenshots...");
    const textOcrItems = ocrItems.filter(item => item.type === "text");
    const mergedTextItems = [];
    let duplicatesDiscarded = 0;
    let trimmedChars = 0;
    const rawTextTotalChars = textOcrItems.reduce((sum, item) => sum + item.rawText.length, 0);

    for (const item of textOcrItems) {
      if (mergedTextItems.length === 0) {
        mergedTextItems.push(item);
        continue;
      }
      const lastItem = mergedTextItems[mergedTextItems.length - 1];
      const originalItemLength = item.rawText.length;
      const mergeResult = findOverlapFuzzy(lastItem.rawText, item.rawText);

      if (mergeResult) {
        if (mergeResult.isDuplicate) {
          duplicatesDiscarded++;
          trimmedChars += originalItemLength;
          sendEvent("log", `  → Discarded duplicate text screenshot: ${item.file} (similarity: ${mergeResult.score || 'N/A'}%)`);
        } else {
          const trimmedLen = mergeResult.newText.length;
          trimmedChars += Math.max(0, originalItemLength - trimmedLen);
          sendEvent("log", `  → Trimmed text overlap from ${item.file} (similarity: ${mergeResult.score}%)`);
          if (mergeResult.trimmedPreviousText) {
            lastItem.rawText = mergeResult.trimmedPreviousText;
          }
          item.rawText = mergeResult.newText;
          mergedTextItems.push(item);
        }
      } else {
        mergedTextItems.push(item);
      }
    }

    const finalDedupTextChars = mergedTextItems.reduce((sum, item) => sum + item.rawText.length, 0);
    const dedupReductionPct = rawTextTotalChars > 0 
      ? parseFloat((((rawTextTotalChars - finalDedupTextChars) / rawTextTotalChars) * 100).toFixed(1))
      : 0;

    // Chronologically weave text and image slots
    const mergedOcrItems = [...mergedTextItems, ...ocrItems.filter(item => item.type === "image")];
    mergedOcrItems.sort((a, b) => a.file.localeCompare(b.file));

    // Step 4: Batch Hand-off to Gemini
    sendEvent("log", "Step 4: Submitting OCR texts to Gemini for cleaning and formatting...");
    const ocrResults = mergedOcrItems.map(item => `[TIMESTAMP: ${item.time}]\n${item.rawText}\n---`);
    
    const GEMINI_BATCH_SIZE = 50;
    const formattedTextParts = [];

    // Batches that already came back, from this date's earlier run.
    //
    // The pipeline cache only ever got written after the whole loop, so a
    // failure on batch 3 of 4 threw away batches 1 and 2 and the rerun paid for
    // them again — at fifty pages a batch, the single most expensive thing a
    // 503 could do here. Each finished batch now lands on disk at once, keyed
    // by a hash of its own chunk so edited content re-runs and untouched
    // content does not.
    const partialPath = path.join(pipelineCacheDir, `${date}.partial.json`);
    let partial = { date, batches: {} };
    try {
      if (fs.existsSync(partialPath)) {
        const loaded = JSON.parse(fs.readFileSync(partialPath, "utf8"));
        if (loaded && loaded.batches) partial = loaded;
      }
    } catch (err) {
      console.error("[Gemini Batch] Unreadable partial cache, starting fresh:", err.message);
    }
    const chunkKey = (text) =>
      require("crypto").createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
    const savePartial = () => {
      try {
        fs.writeFileSync(partialPath, JSON.stringify(partial, null, 2), "utf8");
      } catch (err) {
        console.error("[Gemini Batch] Could not save partial progress:", err.message);
      }
    };

    for (let i = 0; i < ocrResults.length; i += GEMINI_BATCH_SIZE) {
      const chunk = ocrResults.slice(i, i + GEMINI_BATCH_SIZE).join('\n');
      const cacheKey = chunkKey(chunk);
      const batchLabel = Math.floor(i / GEMINI_BATCH_SIZE) + 1;

      if (partial.batches[cacheKey]) {
        formattedTextParts.push(partial.batches[cacheKey]);
        sendEvent("log", `  → Batch ${batchLabel} already formatted on an earlier run — reusing it, no API call.`);
        sendEvent("progress", `Gemini batch ${batchLabel}: reused`, { value: 30 + Math.round((Math.min(i + GEMINI_BATCH_SIZE, ocrResults.length) / ocrResults.length) * 50) });
        continue;
      }

      sendEvent("log", `  → Contacting Gemini for batch ${batchLabel}...`);

      const prompt = `You are an OCR cleanup and formatting assistant for e-reader screenshots. I have a batch of texts for a specific day, and your task is to clean them up and format them.

For each text entry provided, follow these rules:
1.  **Cleanup:** Remove all OCR errors, stray characters, and any user interface elements (like page numbers, battery icons, or clock times) that are not part of the main text.
2.  **Formatting:**
    *   The entire passage for a single screenshot should be on one line, with no internal newlines, UNLESS it is dialogue or a list.
    *   Preserve line breaks for dialogue (e.g., lines starting with "-") and for list items.
    *   Join paragraphs that were split across multiple lines into a single line.
3.  **Output Structure:**
    *   The timestamp must be on its own line and in **bold** (e.g., **HH:MM:SS**).
    *   The cleaned-up text must start on the very next line.
    *   Separate each complete entry (timestamp and text) with a single blank line.
4.  **Special Entries:** If an entry contains "[IMAGE: filename.jpg]", preserve this line exactly as "[IMAGE: filename.jpg]" under its bold timestamp. Do not remove, translate, or alter it.

Here is the batch of texts for the date ${date}. Each entry is separated by "---" and includes a timestamp.
---
${chunk}
---
Return ONLY the formatted text. Do not add any extra titles, commentary, or introductions.`;

      try {
        const { responseText, callStat } = await generateContentWithRetry(prompt, (statusMsg) => {
          sendEvent("log", `  [Gemini Batch ${batchLabel}] ${statusMsg}`);
          sendEvent("progress", `Gemini Batch ${batchLabel}: ${statusMsg}`, { value: 30 + Math.round((i / ocrResults.length) * 50) });
        }, {
          type: "transcription",
          itemCount: Math.min(GEMINI_BATCH_SIZE, ocrResults.length - i),
          validate: (text) => (text && text.trim() ? null : "empty reply"),
        });

        if (callStat) processCallStats.push(callStat);
        const text = responseText.trim();
        formattedTextParts.push(text);
        // Banked before the next batch goes out, so whatever kills batch N+1
        // cannot take batch N with it.
        partial.batches[cacheKey] = text;
        savePartial();
        sendEvent("progress", `Gemini batch: ${batchLabel} done`, { value: 30 + Math.round((Math.min(i + GEMINI_BATCH_SIZE, ocrResults.length) / ocrResults.length) * 50) });
      } catch (err) {
        const done = Object.keys(partial.batches).length;
        sendEvent("error", done
          ? `Gemini formatting error on batch ${batchLabel}: ${err.message} — ${done} finished batch(es) kept, so a rerun resumes from here instead of paying for them again.`
          : `Gemini formatting error: ${err.message}`);
        return res.end();
      }
    }

    const formattedOutput = formattedTextParts.join('\n\n');

    // Every batch landed, so the resume file has nothing left to protect.
    // Leaving it would make the next run reuse this day's text after the user
    // edited the screenshots behind it.
    try {
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    } catch (err) {
      console.error("[Gemini Batch] Could not clear the partial cache:", err.message);
    }

    sendEvent("log", "Process completed. Forwarding to review...");

    // Compute final Stage 2 timing & token metrics summary
    const stage2TotalDurationMs = Date.now() - stage2StartTime;
    const totalGeminiMs = processCallStats.reduce((sum, c) => sum + c.durationMs, 0);
    const totalInputTokens = processCallStats.reduce((sum, c) => sum + c.inputTokens, 0);
    const totalOutputTokens = processCallStats.reduce((sum, c) => sum + c.outputTokens, 0);
    const totalTokens = processCallStats.reduce((sum, c) => sum + c.totalTokens, 0);

    // Yield & Word Count Metrics
    const totalWords = formattedOutput.split(/\s+/).filter(Boolean).length;
    const wordsPerPage = textOcrItems.length > 0 ? parseFloat((totalWords / textOcrItems.length).toFixed(1)) : 0;
    const tokensPer100Words = totalWords > 0 ? Math.round((totalTokens / totalWords) * 100) : 0;

    // Daily Quota Tracking (1,500 RPD)
    const statsHistory = readGeminiStats();
    const utcDateToday = new Date().toISOString().split("T")[0];
    const todayStats = (statsHistory.dailyStats && statsHistory.dailyStats[utcDateToday]) || {};
    const callsTodayCount = (todayStats.totalCalls || 0);
    // REQUESTS, not calls — see `recordGeminiCall`. Falls back to the call
    // count for days recorded before the meter learned the difference.
    const requestsTodayCount = (todayStats.totalRequests !== undefined
      ? todayStats.totalRequests
      : callsTodayCount);
    // Single source of truth: the user-configured daily target (Dev Stats meter).
    // Free-tier RPD for gemini-flash-latest is per-project and low since the
    // Dec-2025 cuts, so the authoritative number lives in the AI Studio console —
    // we track against the target the user set rather than a hardcoded 1,500.
    const freeTierQuotaLimit = meta.dailyQuotaTarget || 50;
    const quotaUsedPct = parseFloat(((requestsTodayCount / freeTierQuotaLimit) * 100).toFixed(2));

    const lastRunSummary = {
      date,
      timestamp: new Date().toISOString(),
      stage2TotalDurationMs,
      stage2TotalDurationSec: parseFloat((stage2TotalDurationMs / 1000).toFixed(2)),
      geminiDurationMs: totalGeminiMs,
      geminiDurationSec: parseFloat((totalGeminiMs / 1000).toFixed(2)),
      callsCount: processCallStats.length,
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      ocrStats: {
        totalScreenshots: dayFiles.length,
        hits: ocrHits,
        misses: ocrMisses,
        hitRatePct: ocrHitRatePct,
        durationMs: ocrDurationMs
      },
      dedupStats: {
        textPagesCount: textOcrItems.length,
        duplicatesDiscarded,
        trimmedChars,
        rawTextChars: rawTextTotalChars,
        finalTextChars: finalDedupTextChars,
        reductionPct: dedupReductionPct
      },
      yieldStats: {
        totalWords,
        wordsPerPage,
        tokensPer100Words
      },
      quotaStats: {
        callsToday: callsTodayCount,
        requestsToday: requestsTodayCount,
        quotaLimit: freeTierQuotaLimit,
        quotaUsedPct
      },
      keyRing: keys.describe(),
      calls: processCallStats
    };
    recordLastRunStats(lastRunSummary);

    // Send final structure containing proposed filenames, draft content, crop coordinates, and timing summary
    const illustrationsList = [];
    for (const item of ocrItems.filter(item => item.type === "image")) {
      let suggestedCrop = null;
      let width = 0;
      let height = 0;
      try {
        const imgPath = path.join(screenshotsDir, item.file);
        const image = await Jimp.read(imgPath);
        width = image.bitmap.width;
        height = image.bitmap.height;
        suggestedCrop = getAutoCropCoordinates(image);
      } catch (err) {
        console.error(`Error calculating pre-crop for ${item.file}:`, err);
      }
      illustrationsList.push({
        originalFile: item.file,
        suggestedName: item.illustrationFilename,
        time: item.time,
        suggestedCrop,
        originalWidth: width,
        originalHeight: height
      });
    }

    const reviewData = {
      date,
      draftContent: formattedOutput,
      illustrations: illustrationsList
    };

    // Save initial pipeline cache to allow resumption
    try {
      const cacheData = {
        date,
        bookTitle: meta.bookTitle || "",
        draftContent: formattedOutput,
        illustrations: illustrationsList,
        status: "paused",
        lastRunSummary
      };
      fs.writeFileSync(path.join(pipelineCacheDir, `${date}.json`), JSON.stringify(cacheData, null, 2), "utf8");
    } catch (err) {
      console.error(`Error writing pipeline cache for ${date}:`, err);
    }

    sendEvent("complete", "Batch analyzed successfully!", { reviewData, lastRunSummary });
    res.end();
  } catch (err) {
    console.error("SSE Error:", err);
    sendEvent("error", `An internal server error occurred: ${err.message}`);
    res.end();
  } finally {
    // Release the date whichever way the run ended. `res.on("close")` covers a
    // browser that walks away mid-stream; this covers everything else, and
    // deleting twice costs nothing.
    runningDates.delete(date);
  }
});

// Finalize Reviewed Filenames, Crop Images, & Generate Daily Note Chronologically
app.post("/api/finalize", async (req, res) => {
  const { date, draftContent, illustrations } = req.body;
  if (!date || !draftContent) {
    return res.status(400).json({ success: false, error: "Missing date or draft content" });
  }

  try {
    const meta = readMeta(); // needed for bookTitle in cache update
    const testOutputDir = path.join(outputDir, `${date} Extracted Images`);
    if (illustrations && illustrations.length > 0) {
      if (!fs.existsSync(testOutputDir)) {
        fs.mkdirSync(testOutputDir, { recursive: true });
      }
    }

    // 1. Process & Crop Illustrations sequentially
    // The user wants crops stored in YYYY-MM-DD Extracted Images/ finalizedName.jpg
    console.log(`[Finalize] Processing crops and naming for ${date}...`);
    
    // We map illustrations in order to replace placeholders in markdown
    let finalMarkdownContent = draftContent;

    for (let i = 0; i < illustrations.length; i++) {
      const item = illustrations[i];
      // Resolve from the input folder, or the archive if this batch was already cleared.
      const srcPath = findScreenshotPath(item.originalFile, date) || path.join(screenshotsDir, item.originalFile);
      const outPath = path.join(testOutputDir, item.finalizedName);

      // Perform Cropping using Jimp
      try {
        const image = await Jimp.read(srcPath);
        const width = image.bitmap.width;
        const height = image.bitmap.height;

        let finalCrop = null;

        if (item.crop && typeof item.crop.x === 'number' && typeof item.crop.y === 'number' && typeof item.crop.w === 'number' && typeof item.crop.h === 'number') {
          // Use user-provided crop coordinates
          finalCrop = {
            x: Math.max(0, Math.min(width - 1, Math.round(item.crop.x))),
            y: Math.max(0, Math.min(height - 1, Math.round(item.crop.y))),
            w: Math.max(1, Math.min(width, Math.round(item.crop.w))),
            h: Math.max(1, Math.min(height, Math.round(item.crop.h)))
          };
        } else {
          // Fall back to auto-crop calculation
          finalCrop = getAutoCropCoordinates(image);
        }

        if (finalCrop) {
          // Clamp crop dimensions to make sure we don't exceed image boundaries
          if (finalCrop.x + finalCrop.w > width) {
            finalCrop.w = width - finalCrop.x;
          }
          if (finalCrop.y + finalCrop.h > height) {
            finalCrop.h = height - finalCrop.y;
          }
          image.crop({ x: finalCrop.x, y: finalCrop.y, w: finalCrop.w, h: finalCrop.h });
        }
        
        // Write the cropped file
        await image.write(outPath);
        console.log(`[Finalize] Cropped and saved: ${item.finalizedName}`);
      } catch (err) {
        console.error(`[Finalize] Error cropping ${item.originalFile}, copying original:`, err);
        fs.copyFileSync(srcPath, outPath);
      }

      // Replace placeholder in the draft markdown text
      // Draft has [IMAGE: YYYY MM DD Shortened Book Title suggested.jpg]
      // We replace it with Obsidian embed ![[finalizedName.jpg]]
      const placeholderRegex = new RegExp(`\\[IMAGE: [^\\]]+\\]`, "i");
      finalMarkdownContent = finalMarkdownContent.replace(placeholderRegex, `![[${item.finalizedName}]]`);

      // Write sequential files spacing by 100ms to guarantee correct Windows creation ordering
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // 2. Format and Write final Markdown File
    const finalMdPath = path.join(outputDir, `${date}.md`);
    let finalFileContent = `# Reading – [[${date}]]\n\n`;

    if (fs.existsSync(finalMdPath)) {
      const existing = fs.readFileSync(finalMdPath, "utf8");
      const expectedHeader = `# Reading – [[${date}]]\n\n`;
      if (existing.startsWith(expectedHeader)) {
        const body = existing.substring(expectedHeader.length);
        if (body.trim().length > 0) finalFileContent += body.trimEnd() + "\n\n";
      } else {
        if (existing.trim().length > 0) finalFileContent += existing.trimEnd() + "\n\n";
      }
    }

    finalFileContent += finalMarkdownContent;
    fs.writeFileSync(finalMdPath, finalFileContent, "utf8");

    // Update pipeline cache status to completed
    try {
      const cacheFilePath = path.join(pipelineCacheDir, `${date}.json`);
      let existingCache = {};
      if (fs.existsSync(cacheFilePath)) {
        existingCache = JSON.parse(fs.readFileSync(cacheFilePath, "utf8"));
      }

      // Merge incoming finalized illustrations names and crop coordinates back into the cache
      const mergedIllustrations = (existingCache.illustrations || []).map(existingItem => {
        const incomingItem = illustrations.find(item => item.originalFile === existingItem.originalFile);
        if (incomingItem) {
          return {
            ...existingItem,
            suggestedName: incomingItem.finalizedName,
            crop: incomingItem.crop
          };
        }
        return existingItem;
      });

      const cacheData = {
        date,
        bookTitle: meta.bookTitle || existingCache.bookTitle || "",
        draftContent: draftContent,
        illustrations: mergedIllustrations.length > 0 ? mergedIllustrations : illustrations,
        status: "completed"
      };
      fs.writeFileSync(cacheFilePath, JSON.stringify(cacheData, null, 2), "utf8");
    } catch (err) {
      console.error(`Error updating pipeline cache to completed for ${date}:`, err);
    }

    res.json({ success: true, message: `Perfect sequential finalize complete! Written: output/${date}.md` });
  } catch (err) {
    console.error("Finalize error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Open a project folder in Windows File Explorer (output | input | archive)
app.post("/api/open-explorer", (req, res) => {
  try {
    const targets = { output: outputDir, input: screenshotsDir, archive: archiveDir };
    const target = targets[req.body && req.body.target] || outputDir;
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    console.log(`[System Command] Opening folder in explorer: ${target}`);
    exec(`explorer.exe "${target}"`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SSE endpoint: archive (move to archive/<date>/) or delete (Recycle Bin) a batch's
// raw screenshots once it has been finalized, streaming a live heartbeat of progress.
app.get("/api/archive-stream", async (req, res) => {
  const date = req.query.date;
  const mode = req.query.mode === "delete" ? "delete" : "archive";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type, message, extra = {}) => {
    res.write(`data: ${JSON.stringify({ type, message, ...extra })}\n\n`);
  };

  try {
    if (!date) {
      sendEvent("error", "Missing date parameter.");
      return res.end();
    }

    const allFiles = fs.existsSync(screenshotsDir)
      ? fs.readdirSync(screenshotsDir).filter((f) => /\.(jpe?g|png)$/i.test(f))
      : [];
    const dayFiles = allFiles
      .filter((f) => {
        const dt = parseDateTimeFromFilename(f);
        return dt && dt.date === date;
      })
      .sort((a, b) => a.localeCompare(b));

    const verb = mode === "delete" ? "Deleting" : "Archiving";

    if (dayFiles.length === 0) {
      // Nothing left in the input folder — treat as already cleared and just stamp it.
      sendEvent("log", `No raw screenshots found in the input folder for ${date} (already cleared).`);
      markBatchArchived(date, mode, 0);
      sendEvent("complete", "Batch already cleared.", { date, mode, count: 0 });
      return res.end();
    }

    sendEvent("log", `${verb} ${dayFiles.length} raw screenshots for ${date}...`);

    let processed = 0;

    if (mode === "archive") {
      const destDir = path.join(archiveDir, date);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      for (const f of dayFiles) {
        const src = path.join(screenshotsDir, f);
        const dest = path.join(destDir, f);
        try {
          fs.renameSync(src, dest);
        } catch (e) {
          // Cross-device or locked file — fall back to copy + unlink.
          try {
            fs.copyFileSync(src, dest);
            fs.unlinkSync(src);
          } catch (e2) {
            sendEvent("log", `  ⚠️ Could not move ${f}: ${e2.message}`);
          }
        }
        processed++;
        sendEvent("progress", `Archiving ${processed}/${dayFiles.length}`, {
          value: Math.round((processed / dayFiles.length) * 100),
          processed,
          total: dayFiles.length
        });
        await sleep(60); // brief pause keeps the heartbeat visible
      }
      sendEvent("log", `Moved ${processed} screenshots into archive/${date}/`);
    } else {
      sendEvent("progress", `Sending ${dayFiles.length} files to the Recycle Bin...`, {
        value: 40,
        processed: 0,
        total: dayFiles.length
      });
      const paths = dayFiles.map((f) => path.join(screenshotsDir, f));
      await recycleFilesToBin(paths);
      processed = dayFiles.length;
      sendEvent("progress", `Recycled ${processed}/${dayFiles.length}`, {
        value: 100,
        processed,
        total: dayFiles.length
      });
      sendEvent("log", `Sent ${processed} screenshots to the Recycle Bin.`);
    }

    markBatchArchived(date, mode, processed);
    const doneVerb = mode === "delete" ? "Deleted" : "Archived";
    sendEvent("complete", `${doneVerb} ${processed} screenshots.`, { date, mode, count: processed });
    res.end();
  } catch (err) {
    console.error("Archive stream error:", err);
    sendEvent("error", `Cleanup failed: ${err.message}`);
    res.end();
  }
});

// Start express server
app.listen(PORT, () => {
  console.log(`================================================`);
  console.log(` E-Reader Screenshot Transcriber GUI Online     `);
  console.log(` Server active on: http://localhost:${PORT}      `);
  console.log(`================================================`);

  // Trigger open browser on Windows automatically (set NO_AUTO_OPEN=1 to skip, e.g. headless testing)
  if (!process.env.NO_AUTO_OPEN) {
    exec(`start http://localhost:${PORT}`);
  }
});
