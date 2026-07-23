// processScreenshots.js
require("dotenv").config();

if (!process.env.GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY not found in .env file. Please create a .env file in the project root with GEMINI_API_KEY=YOUR_API_KEY.");
  process.exit(1);
}

const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Tesseract = require("tesseract.js");
const os = require("os");
const { Jimp } = require("jimp");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

// Parse filenames like: Screenshot_20251202_190647_Evie.jpg
function parseDateTimeFromFilename(filename) {
  const match = filename.match(/^Screenshot_(\d{8})_(\d{6})/);
  if (!match) return null;

  const [, yyyymmdd, hhmmss] = match;

  const date = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${
    yyyymmdd.slice(
      6,
      8
    )
  }`;
  const time = `${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(
    4,
    6
  )}`;

  return { date, time };
}

// Computes the Levenshtein distance ratio between two strings (0-100)
// Uses standard fuzzywuzzy ratio behavior (substitution cost = 2)
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
        curr[j - 1] + 2, // insertion
        prev[j] + 2,     // deletion
        prev[j - 1] + cost // substitution
      );
    }
    // Swap arrays
    const temp = prev;
    prev = curr;
    curr = temp;
  }
  
  const distance = prev[len2];
  return Math.round(((len1 + len2 - distance) / (len1 + len2)) * 100);
}

// Slide an anchor window from the end of the previous text (with small trailing offsets to bypass mangled OCR lines)
// to locate the exact overlap start in the new text
function findOverlapFuzzy(previousText, newText, anchorWordCount = 12, threshold = 80) {
  // Normalize whitespace to spaces and split into words
  const prevWords = previousText.replace(/\s+/g, " ").trim().split(" ");
  const newWords = newText.replace(/\s+/g, " ").trim().split(" ");

  // Fallback check: if either string is very short
  if (prevWords.length < 8 || newWords.length < 8) {
    const normPrev = prevWords.join(" ").toLowerCase();
    const normNew = newWords.join(" ").toLowerCase();
    if (normPrev.includes(normNew)) {
      return { isDuplicate: true, score: 100 };
    }
    return null;
  }

  let bestScore = 0;
  let bestJ = 0;
  let bestK = 0;
  let bestL = 0;

  // j: start index in newWords (garbage prefix offset at start of new screenshot, e.g. 0 to 25 words)
  const maxJ = Math.min(newWords.length - anchorWordCount, 25);
  // k: offset from the end of prevWords (mangled bottom-line offset, e.g. 0 to 35 words)
  const maxK = Math.min(prevWords.length - anchorWordCount, 35);

  for (let k = 0; k <= maxK; k++) {
    // Determine the anchor from previous words (sliding away from the end by k words)
    const anchorWords = prevWords.slice(prevWords.length - k - anchorWordCount, prevWords.length - k);
    const anchorStr = anchorWords.join(" ");

    for (let j = 0; j <= maxJ; j++) {
      // Compare to candidate strings of similar size in newWords
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
    // Unique new words start after the matched anchor + equivalent of skipped mangled words
    const overlapEndInNew = bestJ + bestL + bestK;
    const remainingWords = newWords.length - overlapEndInNew;

    // If 4 or fewer words are new, treat the entire page as a duplicate
    if (remainingWords <= 4) {
      return { isDuplicate: true, score: bestScore };
    }

    // Trim the mangled bottom-line words from previous text
    const trimmedPreviousText = prevWords.slice(0, prevWords.length - bestK).join(" ");
    // Start new text after the matched anchor (preserving the clean version of the mangled words in the new text)
    const trimmedNewText = newWords.slice(bestJ + bestL).join(" ");

    return {
      isDuplicate: false,
      trimmedPreviousText: trimmedPreviousText,
      newText: trimmedNewText,
      score: bestScore
    };
  }

  return null;
}

// Group screenshot paths by date
function groupScreenshotsByDate(screenshotsDir) {
  const files = fs
    .readdirSync(screenshotsDir)
    .filter((f) => /\.(jpe?g|png)$/i.test(f));

  const dailyBatches = {};

  for (const file of files) {
    const meta = parseDateTimeFromFilename(file);
    if (!meta) {
      console.log(`Skipping ${file} (unexpected filename pattern)`);
      continue;
    }

    if (!dailyBatches[meta.date]) {
      dailyBatches[meta.date] = [];
    }
    dailyBatches[meta.date].push({
      file,
      path: path.join(screenshotsDir, file),
      time: meta.time,
    });
  }
  return dailyBatches;
}

const geminiStatsFilePath = path.join(__dirname, "gemini_stats.json");

function recordGeminiCallCLI(callDetail) {
  try {
    let stats = { lastRun: null, dailyStats: {}, history: [] };
    if (fs.existsSync(geminiStatsFilePath)) {
      try { stats = JSON.parse(fs.readFileSync(geminiStatsFilePath, "utf8")); } catch (e) {}
    }
    const utcDate = new Date().toISOString().split("T")[0];
    if (!stats.dailyStats) stats.dailyStats = {};
    if (!stats.dailyStats[utcDate]) {
      stats.dailyStats[utcDate] = {
        utcDate,
        totalCalls: 0,
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

    fs.writeFileSync(geminiStatsFilePath, JSON.stringify(stats, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to record CLI Gemini call stats:", err);
  }
}

// Wrapper to handle Gemini API transient errors (e.g. 503 Service Unavailable, 429 Rate Limit Exceeded)
async function generateContentWithRetry(prompt, maxRetries = 5, initialDelayMs = 2000, meta = {}) {
  let attempt = 0;
  const startTime = Date.now();
  const modelName = "gemini-flash-latest";
  while (true) {
    try {
      const result = await model.generateContent(prompt);
      const durationMs = Date.now() - startTime;
      const durationSec = parseFloat((durationMs / 1000).toFixed(2));
      
      const responseText = result.response ? result.response.text() : "";
      const usage = (result.response && result.response.usageMetadata) || {};
      const inputTokens = usage.promptTokenCount !== undefined ? usage.promptTokenCount : Math.ceil(prompt.length / 4);
      const outputTokens = usage.candidatesTokenCount !== undefined ? usage.candidatesTokenCount : Math.ceil(responseText.length / 4);
      const totalTokens = usage.totalTokenCount !== undefined ? usage.totalTokenCount : (inputTokens + outputTokens);

      recordGeminiCallCLI({
        type: meta.type || "general",
        model: modelName,
        durationMs,
        durationSec,
        inputTokens,
        outputTokens,
        totalTokens,
        timestamp: new Date().toISOString(),
        itemCount: meta.itemCount || 1,
        status: "success",
        attempts: attempt + 1
      });

      return result;
    } catch (error) {
      attempt++;
      if (attempt >= maxRetries) {
        const durationMs = Date.now() - startTime;
        recordGeminiCallCLI({
          type: meta.type || "general",
          model: modelName,
          durationMs,
          durationSec: parseFloat((durationMs / 1000).toFixed(2)),
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: 0,
          totalTokens: Math.ceil(prompt.length / 4),
          timestamp: new Date().toISOString(),
          itemCount: meta.itemCount || 1,
          status: "error",
          error: error.message,
          attempts: attempt
        });
        throw error;
      }
      const isTransient = error.status === 503 || error.status === 429 || 
                          (error.message && (error.message.includes("503") || error.message.includes("429") || error.message.includes("high demand") || error.message.includes("overloaded")));
      if (isTransient) {
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        console.warn(`    ⚠️ Gemini API request failed (${error.status || 'Transient Error'}). Retrying attempt ${attempt}/${maxRetries} in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
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

async function getIllustrationFilename(date, prevText, nextText, index) {
  const trimmedPrev = prevText ? prevText.substring(0, 1500) : "No preceding text.";
  const trimmedNext = nextText ? nextText.substring(0, 1500) : "No succeeding text.";
  
  const prompt = `You are a book illustration archivist. I have a full-screen illustration screenshot taken from an e-reader between these two text passages:

PREVIOUS TEXT:
"${trimmedPrev}"

NEXT TEXT:
"${trimmedNext}"

The date this screenshot was taken is ${date}.
Based on this context, please identify:
1. The title of the book (shortened to a clean, brief format, e.g. "Cosmic Trigger III").
2. A very short, descriptive description of what this illustration is showing based on the context (e.g. "TV Parable" or "Anna OOTE"). Make sure it is safe for Windows filenames (no colons, slashes, backslashes, asterisks, question marks, quotes, or pipe characters, maximum 4-5 words).

Return ONLY a JSON object with this exact structure (no markdown fences, no formatting, just raw JSON):
{
  "bookTitle": "Shortened Book Title",
  "description": "Short Description",
  "filename": "YYYY MM DD Shortened Book Title Short Description.jpg"
}`;

  try {
    const result = await generateContentWithRetry(prompt);
    const responseText = result.response.text();
    const cleanedText = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
    const json = JSON.parse(cleanedText);
    
    const sanitize = (s) => s.replace(/[\/\\?%*:|"<>]/g, "").replace(/\s+/g, " ").trim();
    const bookTitle = sanitize(json.bookTitle || "Book");
    const description = sanitize(json.description || `Illustration ${index}`);
    
    const dateFormatted = date.replace(/-/g, " ");
    return `${dateFormatted} ${bookTitle} ${description}.jpg`;
  } catch (err) {
    console.error(`  - Failed to generate descriptive filename via Gemini: ${err.message}. Using fallback.`);
    return `${date.replace(/-/g, " ")} Book Illustration ${index}.jpg`;
  }
}

async function getFormattedTranscriptions(date, textBatch) {
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
${textBatch}
---
Return ONLY the formatted text. Do not add any extra titles, bullet points, commentary, or introductions.`;

  const result = await generateContentWithRetry(prompt);
  const response = await result.response;
  return response.text().trim();
}

async function main() {
  const baseDir = __dirname;
  const screenshotsDir = path.join(baseDir, "screenshots");
  const outputDir     = path.join(baseDir, "output");
  const ocrCacheDir   = path.join(baseDir, ".ocr_cache");

  // --- Start: Gemini API Key & Connectivity Diagnostic ---
  try {
    console.log("Verifying Gemini API key and connectivity...");
    const testPrompt = "Hello, Gemini!";
    const result = await generateContentWithRetry(testPrompt);
    const response = await result.response;
    if (response.text().length > 0) {
      console.log("Gemini API key and connectivity confirmed.");
    } else {
      console.error("Error: Gemini API test call failed to return content. Check your API key and network.");
      process.exit(1);
    }
  } catch (error) {
    console.error("Error during Gemini API key and connectivity diagnostic:");
    console.error(error);
    process.exit(1);
  }
  // --- End: Gemini API Key & Connectivity Diagnostic ---

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  if (!fs.existsSync(ocrCacheDir)) fs.mkdirSync(ocrCacheDir);

  // Initialize Tesseract scheduler and workers once
  const scheduler = Tesseract.createScheduler();
  const numCPUs = os.cpus().length;
  const numWorkers = Math.max(1, Math.min(4, numCPUs - 1));
  console.log(`Initializing Tesseract scheduler with ${numWorkers} workers (system has ${numCPUs} CPUs)...`);
  for (let i = 0; i < numWorkers; i++) {
    const worker = await Tesseract.createWorker('eng');
    scheduler.addWorker(worker);
  }
  console.log("Tesseract workers ready.");

  // Helper to get cache file path
  const getOcrCachePath = (filename) =>
    path.join(ocrCacheDir, `${filename}.json`);

  // Helper to get file modification time
  const getFileMtime = (filePath) => fs.statSync(filePath).mtimeMs;

  console.log("Grouping screenshots by date...");
  const dailyBatches = groupScreenshotsByDate(screenshotsDir);
  const dates = Object.keys(dailyBatches).sort();

  for (const date of dates) {
    const batch = dailyBatches[date];
    // Sort screenshots chronologically by filename (starts with Screenshot_YYYYMMDD_HHMMSS)
    batch.sort((a, b) => a.file.localeCompare(b.file));
    console.log(`\nProcessing ${batch.length} screenshots for ${date}...`);

    const ocrPromises = batch.map(async (item) => {
        const cachePath = getOcrCachePath(item.file);
        const currentMtime = getFileMtime(item.path);

        if (fs.existsSync(cachePath)) {
            try {
                const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
                if (cachedData.mtime === currentMtime) {
                    if (cachedData.isTextPage !== undefined) {
                        console.log(`  (Cached) OCR for ${item.file}`);
                        return { ...item, rawText: cachedData.text, isTextPage: cachedData.isTextPage };
                    } else {
                        // Text cached but missing color classification, compute and update cache
                        console.log(`  (Cached OCR, updating color check) for ${item.file}`);
                        let isText = false;
                        try {
                            const image = await Jimp.read(item.path);
                            isText = checkHeaderColors(image);
                        } catch (err) {
                            console.error(`Error checking header colors for ${item.file}:`, err);
                        }
                        fs.writeFileSync(cachePath, JSON.stringify({ text: cachedData.text, isTextPage: isText, mtime: currentMtime }), 'utf8');
                        return { ...item, rawText: cachedData.text, isTextPage: isText };
                    }
                }
            } catch (e) {
                // Corrupt cache file
            }
        }

        console.log(`  (New OCR) scheduling for ${item.file}...`);
        const { data: { text: ocrResult } } = await scheduler.addJob('recognize', item.path);
        
        let isText = false;
        try {
            const image = await Jimp.read(item.path);
            isText = checkHeaderColors(image);
        } catch (err) {
            console.error(`Error checking header colors for ${item.file}:`, err);
        }
        
        fs.writeFileSync(cachePath, JSON.stringify({ text: ocrResult, isTextPage: isText, mtime: currentMtime }), 'utf8');
        console.log(`  (New OCR) completed for ${item.file}`);
        return { ...item, rawText: ocrResult, isTextPage: isText };
    });

    const ocrItems = await Promise.all(ocrPromises);

    // Classify screenshots chronologically using the cached header-color result
    for (const item of ocrItems) {
      item.type = item.isTextPage ? "text" : "image";
    }

    // Process and crop image screenshots locally
    let imageIndex = 1;
    for (let i = 0; i < ocrItems.length; i++) {
      const item = ocrItems[i];
      if (item.type === "image") {
        console.log(`  - Found illustration screenshot: ${item.file}`);

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

        // Get descriptive filename via Gemini
        const filename = await getIllustrationFilename(date, prevText, nextText, imageIndex++);
        console.log(`    → Gemini generated filename: "${filename}"`);
        item.illustrationFilename = filename;

        // Perform local bounding box cropping
        const testOutputDir = path.join(outputDir, `${date} Extracted Images`);
        if (!fs.existsSync(testOutputDir)) {
          fs.mkdirSync(testOutputDir, { recursive: true });
        }

        try {
          const image = await Jimp.read(item.path);
          const width = image.bitmap.width;
          const height = image.bitmap.height;

          // Sample corners
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
            const outPath = path.join(testOutputDir, filename);
            await image.write(outPath);
            console.log(`    → Saved cropped illustration to: output/${date} Extracted Images/${filename}`);
          } else {
            console.warn(`    ⚠️ Bounding box not detected for ${item.file}. Saving original image.`);
            const outPath = path.join(testOutputDir, filename);
            await image.write(outPath);
          }
        } catch (err) {
          console.error(`    ⚠️ Cropping error for ${item.file}:`, err);
        }

        // Set the raw text of this item to the IMAGE placeholder
        item.rawText = `[IMAGE: ${filename}]`;
      }
    }

    // Merge duplicates and overlapping text screenshots sequentially using fuzzy matching
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
          console.log(`  → Discarded duplicate text screenshot: ${item.file} (similarity: ${mergeResult.score || 'N/A'}%)`);
        } else {
          console.log(`  → Trimmed text overlap from ${item.file} (similarity: ${mergeResult.score}%)`);
          if (mergeResult.trimmedPreviousText) {
            lastItem.rawText = mergeResult.trimmedPreviousText;
          }
          // Replace item's raw text with just the non-overlapping portion,
          // keeping it as its own timestamped entry.
          item.rawText = mergeResult.newText;
          mergedTextItems.push(item);
        }
      } else {
        mergedTextItems.push(item);
      }
    }

    // Chronologically weave text items and image items back together
    const mergedOcrItems = [...mergedTextItems, ...ocrItems.filter(item => item.type === "image")];
    mergedOcrItems.sort((a, b) => a.file.localeCompare(b.file));

    const ocrResults = mergedOcrItems.map(item => `[TIMESTAMP: ${item.time}]\n${item.rawText}\n---`);
    
    console.log(`  → All screenshots for this date OCR'd. Sending to Gemini in batches (max 50) for formatting...`);

    const GEMINI_BATCH_SIZE = 50;
    let formattedTextParts = [];

    for (let i = 0; i < ocrResults.length; i += GEMINI_BATCH_SIZE) {
      const batchStartIndex = i;
      const batchEndIndex = Math.min(i + GEMINI_BATCH_SIZE, ocrResults.length);
      const batchCount = batchEndIndex - batchStartIndex;
      const currentBatch = ocrResults.slice(batchStartIndex, batchEndIndex).join('\n');
      
      console.log(`    → Sending batch ${Math.floor(i / GEMINI_BATCH_SIZE) + 1} (${batchCount} screenshots)...`);
      const formattedBatch = await getFormattedTranscriptions(date, currentBatch);
      formattedTextParts.push(formattedBatch);
    }

    const formattedText = formattedTextParts.join('\n\n');

    // Replace the [IMAGE: filename.jpg] placeholder with Obsidian markdown image embed
    const finalFormattedText = formattedText.replace(/\[IMAGE: ([^\]]+)\]/g, "![[$1]]");

    const outPath = path.join(outputDir, `${date}.md`);
    let fileContent = `# Reading – [[${date}]]\n\n`; // Always start with the header

    if (fs.existsSync(outPath)) {
      const existingRawContent = fs.readFileSync(outPath, "utf8");
      // Check if the existing content *already* starts with the expected header.
      const expectedHeader = `# Reading – [[${date}]]\n\n`;
      if (existingRawContent.startsWith(expectedHeader)) {
        // If it already has the header, take everything after it.
        // Trim existing newlines at the end to control spacing before appending new content.
        const contentAfterHeader = existingRawContent.substring(expectedHeader.length);
        if (contentAfterHeader.trim().length > 0) {
            fileContent += contentAfterHeader.trimEnd() + "\n\n";
        }
      } else {
        // If it doesn't have the header, just append the whole existing content after our new header
        // and ensure there's a newline separation if it's not empty.
        if (existingRawContent.trim().length > 0) {
            fileContent += existingRawContent.trimEnd() + "\n\n";
        }
      }
    }

    // Now append the newly formatted text from Gemini
    fileContent += finalFormattedText;

    fs.writeFileSync(outPath, fileContent);
    console.log(`  → Formatted content appended to ${path.basename(outPath)}`);
  }

  // Terminate Tesseract scheduler
  await scheduler.terminate();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("An error occurred:", err);
  process.exit(1);
});