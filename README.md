# Eevie Audiobook Screenshot Transcriptions

This project is a Node.js CLI tool designed to transcribe text from e-reader screenshots using the Google Gemini API. It processes image files (JPG/PNG) from a `screenshots/` directory, extracts the text content, and then organizes these transcriptions into daily Markdown files in an `output/` directory.

## Features

*   **Automated Transcription:** Transcribes text directly from e-reader screenshots.
*   **Daily Organization:** Groups transcriptions by date into easily readable Markdown files.
*   **Gemini API Integration:** Leverages the `gemini-2.5-flash` model for efficient and accurate text extraction.

## Technologies Used

*   **Node.js**: Runtime environment.
*   **dotenv**: For environment variable management.
*   **@google/generative-ai**: Official Google Gemini API client library.

## Project Structure

```
Eevie Audiobook Screenshot Transcriptions/
  screenshots/      <-- Drop raw phone screenshots here (e.g., Screenshot_YYYYMMDD_HHMMSS_*.jpg)
  output/           <-- Daily .md files end up here (e.g., YYYY-MM-DD.md)
  .env              <-- Holds GEMINI_API_KEY
  package.json      <-- Node.js project configuration and dependencies
  processScreenshots.js <-- The main script to process screenshots
```

## Getting Started

### Prerequisites

*   Node.js installed (LTS recommended).
*   A Google Gemini API key. You can obtain one from [Google AI Studio](https://aistudio.google.com/).

### Setup

1.  **Clone the repository:**
    If you haven't already, clone this repository to your local machine:
    ```bash
    git clone https://github.com/YOUR_GITHUB_USERNAME/Eevie-Audiobook-Screenshot-Transcriptions.git
    cd Eevie-Audiobook-Screenshot-Transcriptions
    ```
    *(Replace `YOUR_GITHUB_USERNAME` with your GitHub username)*

2.  **Install Dependencies:**
    Run the following command in the project directory:
    ```powershell
    npm install
    ```

3.  **Configure API Key:**
    Create a `.env` file in the root of your project and add your Gemini API key:
    ```
    GEMINI_API_KEY=YOUR_REAL_API_KEY_HERE
    ```
    Replace `YOUR_REAL_API_KEY_HERE` with your actual Gemini API key.

## Usage

### Workflow

1.  **Add Screenshots:**
    Place your e-reader screenshots (following the `Screenshot_YYYYMMDD_HHMMSS_*.jpg` or `.png` naming convention) into the `screenshots/` directory.

2.  **Run the Transcriber:**
    Execute the script from the project's root directory:
    ```powershell
    node processScreenshots.js
    ```

### Output

The script will:
*   Read all `.jpg` / `.png` files in `screenshots/`.
*   Call the Gemini API to transcribe text from each image.
*   Group transcriptions by date into Markdown files in the `output/` directory (e.g., `output/2025-12-12.md`).
*   Each Markdown file will have a daily header (e.g., `# Reading – [[YYYY-MM-DD]]`) and each transcribed passage will be a bullet point with a timestamp.

## Development Conventions

*   **Filename Pattern:** Screenshots are expected to follow `Screenshot_YYYYMMDD_HHMMSS_*.jpg` or `.png` for date and time extraction.
*   **Gemini Model:** Uses `gemini-2.5-flash` by default. This can be adjusted in `processScreenshots.js`.
*   **Transcription Prompt:** The prompt is designed to extract only the main text passage, preserving line breaks and avoiding UI elements.
