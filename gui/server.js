// gui/server.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const os = require("os");
const Tesseract = require("tesseract.js");
const { Jimp } = require("jimp");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Load initial environment
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const app = express();
const PORT = 3301;

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

// Ensure baseline directories exist
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
if (!fs.existsSync(ocrCacheDir)) fs.mkdirSync(ocrCacheDir, { recursive: true });

// --- Persistent State Helpers ---
function readMeta() {
  if (fs.existsSync(metaFilePath)) {
    try {
      return JSON.parse(fs.readFileSync(metaFilePath, "utf8"));
    } catch (err) {
      console.error("Error reading meta.json, resetting:", err);
    }
  }
  return { bookTitle: "", imageContexts: {} };
}

function writeMeta(data) {
  fs.writeFileSync(metaFilePath, JSON.stringify(data, null, 2), "utf8");
}

function parseDateTimeFromFilename(filename) {
  const match = filename.match(/^Screenshot_(\d{8})_(\d{6})/);
  if (!match) return null;
  const [, yyyymmdd, hhmmss] = match;
  const date = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  const time = `${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}`;
  return { date, time };
}

function hasReaderHeader(text) {
  return /Evie/i.test(text) || /Contents/i.test(text) || /Sleep/i.test(text) || /Read/i.test(text);
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

  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (cached.mtime === currentMtime) {
        return cached.text;
      }
    } catch (e) {
      // Corrupt cache file, re-run
    }
  }

  console.log(`[OCR Cache Miss] Running OCR for: ${filename}`);
  const activeScheduler = await getTesseractScheduler();
  const { data: { text } } = await activeScheduler.addJob("recognize", filePath);
  fs.writeFileSync(cachePath, JSON.stringify({ text, mtime: currentMtime }), "utf8");
  return text;
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
async function generateContentWithRetry(apiKey, prompt, onStatusUpdate = null, maxRetries = 5, initialDelayMs = 2000) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
  
  let attempt = 0;
  if (onStatusUpdate) onStatusUpdate("Contacting Gemini API...");
  while (true) {
    try {
      const result = await model.generateContent(prompt);
      if (onStatusUpdate) onStatusUpdate("Response received successfully.");
      return result;
    } catch (error) {
      attempt++;
      if (attempt >= maxRetries) throw error;
      const isTransient = error.status === 503 || error.status === 429 || 
                          (error.message && (error.message.includes("503") || error.message.includes("429") || error.message.includes("high demand") || error.message.includes("overloaded")));
      if (isTransient) {
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        const warnMsg = `Transient error (${error.status || '503'}). Retrying attempt ${attempt}/${maxRetries} in ${Math.round(delay / 1000)}s...`;
        console.warn(`[Gemini API] ${warnMsg}`);
        if (onStatusUpdate) onStatusUpdate(warnMsg);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
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

// Serve raw screenshots
app.get("/api/screenshot/:name", (req, res) => {
  const filePath = path.join(screenshotsDir, req.params.name);
  if (fs.existsSync(filePath)) {
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
    let totalUncached = 0;

    for (const date of dates) {
      const batch = dailyGroups[date];
      batch.sort((a, b) => a.file.localeCompare(b.file));
      
      const items = batch.map((item) => {
        const cachePath = path.join(ocrCacheDir, `${item.file}.json`);
        let type = "pending";
        let rawText = "";
        let isCached = false;
        
        if (fs.existsSync(cachePath)) {
          try {
            const currentMtime = fs.statSync(item.path).mtimeMs;
            const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
            if (cached.mtime === currentMtime) {
              rawText = cached.text;
              type = hasReaderHeader(rawText) ? "text" : "image";
              isCached = true;
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
    }

    // Proactively run background OCR if there are uncached screenshots
    if (totalUncached > 0 && !isOcrRunning) {
      runBackgroundOcr().catch((err) => {
        console.error("Error in background OCR runner startup:", err);
      });
    }

    const apiKey = process.env.GEMINI_API_KEY || "";
    res.json({
      success: true,
      bookTitle: meta.bookTitle || "",
      apiKeyPresent: apiKey.length > 0,
      apiKeyMasked: apiKey.length > 0 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "",
      dates,
      groups: resultGroups,
      ocrActive: isOcrRunning || totalUncached > 0,
      ocrTotal: isOcrRunning ? ocrTotal : totalUncached,
      ocrProcessed: isOcrRunning ? ocrProcessed : 0,
      totalUncached
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update settings: global Book Title (meta.json) and API Key (.env)
app.post("/api/settings", (req, res) => {
  const { bookTitle, apiKey } = req.body;
  
  try {
    const meta = readMeta();
    meta.bookTitle = bookTitle || "";
    writeMeta(meta);

    if (apiKey && apiKey.trim().length > 0) {
      fs.writeFileSync(path.join(projectRoot, ".env"), `GEMINI_API_KEY=${apiKey.trim()}\n`, "utf8");
      process.env.GEMINI_API_KEY = apiKey.trim();
    }
    
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

  // Setup Server-Sent Events headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type, message, extra = {}) => {
    res.write(`data: ${JSON.stringify({ type, message, ...extra })}\n\n`);
  };

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      sendEvent("error", "No Gemini API key found. Please save a valid key in the settings panel.");
      return res.end();
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
    const ocrItems = [];
    for (let i = 0; i < dayFiles.length; i++) {
      const item = dayFiles[i];
      const text = await ensureOcrCached(item.file, item.path);
      const type = hasReaderHeader(text) ? "text" : "image";
      ocrItems.push({ ...item, rawText: text, type });
      sendEvent("progress", `OCR read: ${i + 1}/${dayFiles.length}`, { value: Math.round(((i + 1) / dayFiles.length) * 30) });
    }

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
        const result = await generateContentWithRetry(apiKey, prompt, (statusMsg) => {
          sendEvent("log", `  [Gemini Naming] ${statusMsg}`);
          sendEvent("progress", `Gemini Naming: ${statusMsg}`, { value: 30 });
        });
        const responseText = result.response.text();
        const cleanedText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
        const suggestedList = JSON.parse(cleanedText);
        
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

    for (const item of textOcrItems) {
      if (mergedTextItems.length === 0) {
        mergedTextItems.push(item);
        continue;
      }
      const lastItem = mergedTextItems[mergedTextItems.length - 1];
      const mergeResult = findOverlapFuzzy(lastItem.rawText, item.rawText);

      if (mergeResult) {
        if (mergeResult.isDuplicate) {
          sendEvent("log", `  → Discarded duplicate text screenshot: ${item.file} (similarity: ${mergeResult.score || 'N/A'}%)`);
        } else {
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

    // Chronologically weave text and image slots
    const mergedOcrItems = [...mergedTextItems, ...ocrItems.filter(item => item.type === "image")];
    mergedOcrItems.sort((a, b) => a.file.localeCompare(b.file));

    // Step 4: Batch Hand-off to Gemini
    sendEvent("log", "Step 4: Submitting OCR texts to Gemini for cleaning and formatting...");
    const ocrResults = mergedOcrItems.map(item => `[TIMESTAMP: ${item.time}]\n${item.rawText}\n---`);
    
    const GEMINI_BATCH_SIZE = 50;
    const formattedTextParts = [];

    for (let i = 0; i < ocrResults.length; i += GEMINI_BATCH_SIZE) {
      const chunk = ocrResults.slice(i, i + GEMINI_BATCH_SIZE).join('\n');
      sendEvent("log", `  → Contacting Gemini for batch ${Math.floor(i / GEMINI_BATCH_SIZE) + 1}...`);
      
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
        const batchNum = Math.floor(i / GEMINI_BATCH_SIZE) + 1;
        const result = await generateContentWithRetry(apiKey, prompt, (statusMsg) => {
          sendEvent("log", `  [Gemini Batch ${batchNum}] ${statusMsg}`);
          sendEvent("progress", `Gemini Batch ${batchNum}: ${statusMsg}`, { value: 30 + Math.round((i / ocrResults.length) * 50) });
        });
        const text = result.response.text().trim();
        formattedTextParts.push(text);
        sendEvent("progress", `Gemini batch: ${Math.floor(i / GEMINI_BATCH_SIZE) + 1} done`, { value: 30 + Math.round(((i + chunk.length) / ocrResults.length) * 50) });
      } catch (err) {
        sendEvent("error", `Gemini formatting error: ${err.message}`);
        return res.end();
      }
    }

    const formattedOutput = formattedTextParts.join('\n\n');
    sendEvent("log", "Process completed. Forwarding to review...");

    // Send final structure containing proposed filenames and draft content
    const reviewData = {
      date,
      draftContent: formattedOutput,
      illustrations: ocrItems.filter(item => item.type === "image").map(item => ({
        originalFile: item.file,
        suggestedName: item.illustrationFilename,
        time: item.time
      }))
    };

    sendEvent("complete", "Batch analyzed successfully!", { reviewData });
    res.end();
  } catch (err) {
    console.error("SSE Error:", err);
    sendEvent("error", `An internal server error occurred: ${err.message}`);
    res.end();
  }
});

// Finalize Reviewed Filenames, Crop Images, & Generate Daily Note Chronologically
app.post("/api/finalize", async (req, res) => {
  const { date, draftContent, illustrations } = req.body;
  if (!date || !draftContent) {
    return res.status(400).json({ success: false, error: "Missing date or draft content" });
  }

  try {
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
      const srcPath = path.join(screenshotsDir, item.originalFile);
      const outPath = path.join(testOutputDir, item.finalizedName);

      // Perform Cropping using Jimp
      try {
        const image = await Jimp.read(srcPath);
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
          image.crop({ x: minX, y: minY, w: cropW, h: cropH });
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

    res.json({ success: true, message: `Perfect sequential finalize complete! Written: output/${date}.md` });
  } catch (err) {
    console.error("Finalize error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Open Output Folder in Windows File Explorer
app.post("/api/open-explorer", (req, res) => {
  try {
    console.log(`[System Command] Opening folder in explorer: ${outputDir}`);
    exec(`explorer.exe "${outputDir}"`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start express server
app.listen(PORT, () => {
  console.log(`================================================`);
  console.log(` E-Reader Screenshot Transcriber GUI Online     `);
  console.log(` Server active on: http://localhost:${PORT}      `);
  console.log(`================================================`);
  
  // Trigger open browser on Windows automatically
  exec(`start http://localhost:${PORT}`);
});
