# E-Reader Screenshot Transcriber

This Node.js CLI tool processes e-reader screenshots. It transcribes text, formats it for readability, and organizes daily transcriptions into Markdown files. This solution offers an efficient method for managing reading notes and personal knowledge base entries.

## Capabilities

*   **Efficient Transcription:** Utilizes Tesseract.js for rapid, local Optical Character Recognition (OCR), then sends text to the Google Gemini API for intelligent cleanup and formatting.
*   **Parallel OCR Processing:** Processes multiple screenshots concurrently, leveraging multi-core processors to significantly accelerate OCR tasks while preserving screenshot sequence.
*   **OCR Caching:** Stores OCR results for each image. Subsequent runs reuse cached text for unchanged screenshots, drastically reducing processing time and API calls.
*   **Batch Processing:** Groups all screenshots for a specific day, processing them in a single, streamlined operation.
*   **Automated Daily Notes:** Organizes formatted transcriptions by date into clean Markdown files, ideal for a personal knowledge base or reading journal.

## Tools

*   **Node.js**: Runtime environment.
*   **Tesseract.js**: Local OCR engine.
*   **@google/generative-ai**: Official Google Gemini API client library.
*   **dotenv**: Environment variable management.
*   **p-limit**: Controls concurrency for parallel tasks.

## Project Layout

```
E-Reader-Screenshot-Transcriber/
  screenshots/      <-- Place raw phone screenshots here (e.g., Screenshot_YYYYMMDD_HHMMSS_*.jpg)
  output/           <-- Daily .md files reside here (e.g., YYYY-MM-DD.md)
  .ocr_cache/       <-- Stores cached OCR results for rapid reprocessing
  .env              <-- Holds your GEMINI_API_KEY
  package.json      <-- Node.js project configuration and dependencies
  processScreenshots.js <-- The main script for screenshot processing
```

## Setup Essentials

### Prerequisites

*   Node.js installed (LTS recommended).
*   A Google Gemini API key. Obtain one from [Google AI Studio](https://aistudio.google.com/).

### Installation

1.  **Obtain the Project:**
    Clone this repository or download and unzip the source code to your machine.
    ```bash
    git clone https://github.com/DyllonWright/E-Reader-Screenshot-Transcriber
    cd E-Reader-Screenshot-Transcriber
    ```

2.  **Install Dependencies:**
    Execute this command in the project directory:
    ```powershell
    npm install
    ```

3.  **Configure API Key:**
    Create a file named `.env` in the project root. Add your Gemini API key to it:
    ```
    GEMINI_API_KEY=YOUR_REAL_API_KEY_HERE
    ```
    Replace `YOUR_REAL_API_KEY_HERE` with your actual key. Git ignores `.env` to prevent accidental sharing.

## Operation

1.  **Add Screenshots:**
    Place e-reader screenshots into the `screenshots/` directory. Files must adhere to the naming convention `Screenshot_YYYYMMDD_HHMMSS_*.jpg` or `.png` for correct date and time extraction.

2.  **Run the Transcriber:**
    Execute the script from the project's root directory:
    ```powershell
    node processScreenshots.js
    ```
The script logs its progress, performing parallel local OCR, utilizing cached results when available, and then sending batched text to Gemini for formatting.

### Resulting Format

The script creates or updates Markdown files in the `output/` directory. Each file carries a date as its name (e.g., `2025-12-13.md`), containing all transcriptions for that day. The format prioritizes clarity and readability:

```markdown
# Reading – [[2025-12-13]]

**10:30:05**
This passage of cleaned text. Paragraphs split across multiple lines in the screenshot automatically join into a single line.

**10:32:15**
This second passage follows the same formatting rules, separated from the previous entry by a blank line.
```
