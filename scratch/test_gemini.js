// scratch/test_gemini.js
const { GoogleGenerativeAI } = require("@google/generative-ai");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const apiKey = process.env.GEMINI_API_KEY;
console.log("Configured API Key:", apiKey ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "None");

if (!apiKey) {
  console.error("Error: No GEMINI_API_KEY found in .env");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

async function testModel(modelName) {
  console.log(`\nTesting model: "${modelName}"...`);
  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const response = await model.generateContent("Say hello!");
    console.log(`Success with "${modelName}":`, response.response.text());
    return true;
  } catch (err) {
    console.error(`Failed with "${modelName}":`);
    console.error(`- Message: ${err.message}`);
    console.error(`- Status: ${err.status}`);
    if (err.status) {
      console.error(`- Status Code: ${err.status}`);
    }
    return false;
  }
}

async function main() {
  const models = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
  for (const m of models) {
    const ok = await testModel(m);
    if (ok) {
      console.log(`\nRecommended working model: "${m}"`);
      break;
    }
  }
}

main().catch(console.error);
