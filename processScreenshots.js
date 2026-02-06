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
const pLimit = require('p-limit').default;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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

Here is the batch of texts for the date ${date}. Each entry is separated by "---" and includes a timestamp.
---
${textBatch}
---
Return ONLY the formatted text. Do not add any extra titles, bullet points, commentary, or introductions.`;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  return response.text().trim();
}

async function main() {
  const baseDir = __dirname;
  const screenshotsDir = path.join(baseDir, "screenshots");
  const outputDir = path.join(baseDir, "output");
  const ocrCacheDir = path.join(baseDir, ".ocr_cache");

  // --- Start: Gemini API Key & Connectivity Diagnostic ---
  try {
    console.log("Verifying Gemini API key and connectivity...");
    const testPrompt = "Hello, Gemini!";
    const result = await model.generateContent(testPrompt);
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

  const limit = pLimit(6);

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
    console.log(`\nProcessing ${batch.length} screenshots for ${date}...`);

    let ocrTextBatch = "";

    const ocrPromises = batch.map((item) => limit(async () => {
        const cachePath = getOcrCachePath(item.file);
        const currentMtime = getFileMtime(item.path);
        let text = "";

        if (fs.existsSync(cachePath)) {
            const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cachedData.mtime === currentMtime) {
                text = cachedData.text;
                console.log(`  (Cached) OCR for ${item.file}`);
                return `[TIMESTAMP: ${item.time}]\n${text}\n---`;
            }
        }

        console.log(`  (New OCR) for ${item.file}...`);
        const worker = await Tesseract.createWorker('eng');
        const { data: { text: ocrResult } } = await worker.recognize(item.path);
        await worker.terminate();

        fs.writeFileSync(cachePath, JSON.stringify({ text: ocrResult, mtime: currentMtime }), 'utf8');
        return `[TIMESTAMP: ${item.time}]\n${ocrResult}\n---`;
    }));

    const ocrResults = await Promise.all(ocrPromises);
    ocrTextBatch = ocrResults.join('\n');

    console.log("  → All screenshots for this date OCR'd. Sending to Gemini for formatting...");

    const formattedText = await getFormattedTranscriptions(date, ocrTextBatch);

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
    fileContent += formattedText;

    fs.writeFileSync(outPath, fileContent);
    console.log(`  → Formatted content appended to ${path.basename(outPath)}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("An error occurred:", err);
  process.exit(1);
});