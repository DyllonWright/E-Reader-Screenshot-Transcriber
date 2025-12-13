// processScreenshots.js
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use a fast, cheap multimodal model; adjust if you want
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Turn an image file into a Gemini "part"
function imagePartFromPath(filePath) {
  const imageBytes = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : "image/jpeg";

  return {
    inlineData: {
      data: imageBytes.toString("base64"),
      mimeType,
    },
  };
}

// Call Gemini to transcribe one screenshot
async function transcribeScreenshot(filePath) {
  const prompt =
    "You are transcribing interesting passages from an e-reader screenshot. " +
    "Return ONLY the text passage that is clearly the main content (no UI text, " +
    "no page numbers, no device chrome). Preserve paragraphs, dialogue, and lists by using a double newline between them. Do not add any commentary.";

  const imagePart = imagePartFromPath(filePath);

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }, imagePart],
      },
    ],
  });

  const response = await result.response;
  // Replace single newlines with spaces, but keep double newlines as single newlines.
  const text = response.text().trim().replace(/(?<!\n)\n(?!\n)/g, ' ').replace(/\n\n/g, '\n');
  return text;
}

// Parse filenames like: Screenshot_20251202_190647_Evie.jpg
function parseDateTimeFromFilename(filename) {
  const match = filename.match(/^Screenshot_(\d{8})_(\d{6})/);
  if (!match) return null;

  const [, yyyymmdd, hhmmss] = match;

  const date = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(
    6,
    8
  )}`;
  const time = `${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}`;

  return { date, time };
}

async function main() {
  const baseDir = __dirname;
  const screenshotsDir = path.join(baseDir, "screenshots");
  const outputDir = path.join(baseDir, "output");
  const delay = 12000; // 12 seconds for 5 RPM

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  const files = fs
    .readdirSync(screenshotsDir)
    .filter((f) => /\.(jpe?g|png)$/i.test(f));

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const meta = parseDateTimeFromFilename(file);
    if (!meta) {
      console.log(`Skipping ${file} (unexpected filename pattern)`);
      continue;
    }

    const { date, time } = meta;
    const filePath = path.join(screenshotsDir, file);

    console.log(`Transcribing ${file} (${date} ${time})...
`);
    const text = await transcribeScreenshot(filePath);

    const outPath = path.join(outputDir, `${date}.md`);

    // Ensure file starts with your preferred daily header
    let existing = "";
    if (fs.existsSync(outPath)) {
      existing = fs.readFileSync(outPath, "utf8");
    } else {
      existing = `# Reading – [[${date}]]\n\n`;
    }

    const entry = `**${time}**\n${text}\n\n`; // bold timestamp on its own line

    fs.writeFileSync(outPath, existing + entry);

    console.log(`  → appended to ${path.basename(outPath)}`);

    if (i < files.length - 1) {
      console.log(`Waiting ${delay / 1000} seconds before next request...`);
      await sleep(delay);
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
