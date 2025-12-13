# E-Reader Screenshot Transcriber

This project is a Node.js CLI tool that uses a combination of local OCR and the Google Gemini API to transcribe text from e-reader screenshots. It processes image files, extracts the raw text, sends it to Gemini for cleanup and formatting, and organizes the final transcriptions into daily Markdown files.

## Features

*   **Two-Step Transcription:** Uses Tesseract.js for fast, local OCR, and then leverages the Gemini API for intelligent text cleanup and formatting.
*   **Batch Processing:** Groups all screenshots for a given day and processes them in a single run, making it efficient.
*   **Automated Daily Notes:** Organizes transcriptions by date into cleanly formatted Markdown files, perfect for a personal knowledge base or reading journal.

## Technologies Used

*   **Node.js**: Runtime environment.
*   **Tesseract.js**: For local Optical Character Recognition (OCR).
*   **@google/generative-ai**: Official Google Gemini API client library.
*   **dotenv**: For environment variable management.

## Project Structure

```
Reading Transcriptions/
  screenshots/      <-- Drop raw phone screenshots here (e.g., Screenshot_YYYYMMDD_HHMMSS_*.jpg)
  output/           <-- Daily .md files end up here (e.g., YYYY-MM-DD.md)
  .env              <-- Holds your GEMINI_API_KEY
  package.json      <-- Node.js project configuration and dependencies
  processScreenshots.js <-- The main script to process screenshots
```

## Getting Started

### Prerequisites

*   Node.js installed (LTS recommended).
*   A Google Gemini API key. You can obtain one from [Google AI Studio](https://aistudio.google.com/).

### Setup

1.  **Clone or Download:**
    Clone this repository or download and unzip the source code to your local machine.
    ```bash
    git clone https://github.com/DyllonWright/E-Reader-Screenshot-Transcriber
    cd e-reader-transcriber
    ```

2.  **Install Dependencies:**
    Run the following command in the project directory:
    ```powershell
    npm install
    ```

3.  **Configure API Key:**
    Create a file named `.env` in the root of your project and add your Gemini API key like this:
    ```
    GEMINI_API_KEY=YOUR_REAL_API_KEY_HERE
    ```
    Replace `YOUR_REAL_API_KEY_HERE` with your actual key. The `.gitignore` file is already set up to prevent this file from being committed.

## Usage

1.  **Add Screenshots:**
    Place your e-reader screenshots into the `screenshots/` directory. They must follow the naming convention `Screenshot_YYYYMMDD_HHMMSS_*.jpg` or `.png` for the script to extract the date and time correctly.

2.  **Run the Transcriber:**
    Execute the script from the project's root directory:
    ```powershell
    node processScreenshots.js
    ```
The script will log its progress to the console as it performs local OCR and then sends the batched text to Gemini for formatting.

### Output Format

The script will create or update Markdown files in the `output/` directory. Each file is named with the date (e.g., `2025-12-13.md`) and contains all transcriptions for that day. The format is designed for clarity and readability:

```markdown
# Reading – [[2025-12-13]]

**10:30:05**
This is the first passage of cleaned-up text. Paragraphs that were split across multiple lines in the screenshot are automatically joined into a single line.

**10:32:15**
This is the second passage. It follows the same formatting rules, separated from the previous entry by a blank line.
```
