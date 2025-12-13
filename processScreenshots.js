// processScreenshots.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const Tesseract = require("tesseract.js");

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

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  console.log("Grouping screenshots by date...");
  const dailyBatches = groupScreenshotsByDate(screenshotsDir);
  const dates = Object.keys(dailyBatches).sort();

  for (const date of dates) {
    const batch = dailyBatches[date];
    console.log(`\nProcessing ${batch.length} screenshots for ${date}...`);

    let ocrTextBatch = "";
    const worker = await Tesseract.createWorker('eng');
    
    for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        console.log(`  (${i + 1}/${batch.length}) OCR for ${item.file}...`);
        const { data: { text } } = await worker.recognize(item.path);
        
        ocrTextBatch += `[TIMESTAMP: ${item.time}]\n${text}\n---\n`;
    }
    await worker.terminate();

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