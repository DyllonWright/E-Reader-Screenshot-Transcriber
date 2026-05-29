// gui/public/app.js

document.addEventListener("DOMContentLoaded", () => {
  // --- Application State ---
  let appState = {
    bookTitle: "",
    apiKeyPresent: false,
    dates: [],
    groups: {},
    selectedDate: "",
    draftContent: "",
    illustrations: [] // From AI: { originalFile, suggestedName, time }
  };

  // --- DOM Elements ---
  const stepConfig = document.getElementById("step-ind-config");
  const stepProcess = document.getElementById("step-ind-process");
  const stepReview = document.getElementById("step-ind-review");
  const stepSuccess = document.getElementById("step-ind-success");

  const panelConfig = document.getElementById("panel-config");
  const panelProcess = document.getElementById("panel-process");
  const panelReview = document.getElementById("panel-review");
  const panelSuccess = document.getElementById("panel-success");

  const selectDate = document.getElementById("select-date-batch");
  const statWrapper = document.getElementById("stat-cards-wrapper");
  const statTotal = document.getElementById("stat-total-screens");
  const statText = document.getElementById("stat-text-pages");
  const statImage = document.getElementById("stat-illustrations");
  
  const formSettings = document.getElementById("form-settings");
  const inputBookTitle = document.getElementById("input-book-title");
  const inputApiKey = document.getElementById("input-api-key");
  const btnToggleKey = document.getElementById("btn-toggle-key");
  const keyStatusText = document.getElementById("key-status-text");

  const dropzone = document.getElementById("upload-dropzone");
  const filePicker = document.getElementById("input-file-picker");
  const uploadProgressContainer = document.getElementById("upload-progress-container");
  const uploadProgressFill = document.getElementById("upload-progress-bar");
  const uploadProgressLabel = document.getElementById("upload-progress-label");
  const uploadProgressPercent = document.getElementById("upload-progress-percent");

  const illustrationsList = document.getElementById("illustration-helpers-list");
  const btnStart = document.getElementById("btn-start-processing");

  // Processing elements
  const processStepTitle = document.getElementById("process-step-title");
  const processPercent = document.getElementById("process-percentage");
  const processBarFill = document.getElementById("process-progress-bar");
  const consoleLogs = document.getElementById("terminal-logs");

  // Review elements
  const reviewGrid = document.getElementById("review-list-grid");
  const btnSaveFinalize = document.getElementById("btn-save-finalize");
  const btnBackConfig = document.getElementById("btn-back-to-config");

  // Success elements
  const outputMdName = document.getElementById("success-output-md");
  const outputImgFolderName = document.getElementById("success-output-img-folder");
  const btnExplorerFinal = document.getElementById("btn-show-in-explorer-final");
  const btnExplorerHeader = document.getElementById("btn-show-explorer-header");
  const btnResetPipeline = document.getElementById("btn-reset-pipeline");

  // --- Initialization ---
  loadStatus();
  setupUploads();
  setupEventListeners();

  // --- API Integrations ---

  // 1. Fetch backend configuration, screens status and pre-OCR classifications
  async function loadStatus() {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      appState.bookTitle = data.bookTitle;
      appState.apiKeyPresent = data.apiKeyPresent;
      appState.dates = data.dates;
      appState.groups = data.groups;

      // Populate Settings Inputs
      inputBookTitle.value = data.bookTitle;
      if (data.apiKeyPresent) {
        keyStatusText.textContent = `Active Key: ${data.apiKeyMasked}`;
        keyStatusText.classList.remove("text-muted");
        keyStatusText.classList.add("text-brand-cyan");
      } else {
        keyStatusText.textContent = "No key configured. Create .env or enter above.";
        keyStatusText.classList.remove("text-brand-cyan");
        keyStatusText.classList.add("text-muted");
      }

      // Populate Dates Dropdown
      populateDatesDropdown();
    } catch (err) {
      alert(`Failed to load system status: ${err.message}`);
    }
  }

  // Populate date batch options
  function populateDatesDropdown() {
    const selected = selectDate.value;
    selectDate.innerHTML = "";

    if (appState.dates.length === 0) {
      selectDate.innerHTML = `<option value="" disabled selected>No screenshots found. Add image files to begin.</option>`;
      btnStart.disabled = true;
      statWrapper.classList.add("hidden");
      renderEmptyIllustrations();
      return;
    }

    selectDate.innerHTML = `<option value="" disabled ${!selected ? 'selected' : ''}>-- Select Date Batch to process --</option>`;
    appState.dates.forEach(date => {
      const count = appState.groups[date].length;
      const isSel = date === selected ? "selected" : "";
      selectDate.innerHTML += `<option value="${date}" ${isSel}>${date} (${count} screenshots)</option>`;
    });

    if (selected && appState.dates.includes(selected)) {
      selectDate.value = selected;
      updateSelectedBatchStats(selected);
    } else {
      btnStart.disabled = true;
      statWrapper.classList.add("hidden");
      renderEmptyIllustrations();
    }
  }

  // Handle batch selection change
  function updateSelectedBatchStats(date) {
    appState.selectedDate = date;
    const items = appState.groups[date] || [];

    const total = items.length;
    const images = items.filter(item => item.type === "image").length;
    const texts = total - images;

    statTotal.textContent = total;
    statText.textContent = texts;
    statImage.textContent = images;
    statWrapper.classList.remove("hidden");

    // Enable Run if there are items and API Key exists
    btnStart.disabled = total === 0;

    // Render illustrations list for metadata capture
    renderIllustrationsConfig(items.filter(item => item.type === "image"));
  }

  // Renders empty illustrations text
  function renderEmptyIllustrations() {
    illustrationsList.innerHTML = `
      <div class="empty-illustrations">
        <p>No illustrations detected in this batch, or no batch selected.</p>
      </div>
    `;
  }

  // Render illustration config cards
  function renderIllustrationsConfig(images) {
    if (images.length === 0) {
      illustrationsList.innerHTML = `
        <div class="empty-illustrations">
          <p>No full-screen illustrations detected for this day (all screenshots are text pages).</p>
        </div>
      `;
      return;
    }

    illustrationsList.innerHTML = "";
    images.forEach(img => {
      const tile = document.createElement("div");
      tile.className = "ill-config-tile";
      tile.innerHTML = `
        <div class="thumbnail-wrapper">
          <img src="/api/screenshot/${img.file}" class="thumbnail-img" alt="Screenshot illustration">
        </div>
        <div class="ill-config-content">
          <div class="ill-meta-header">
            <span class="ill-name" title="${img.file}">${img.file}</span>
            <span class="ill-time">${img.time}</span>
          </div>
          <div class="form-group">
            <label>Context Description (Optional)</label>
            <input type="text" class="ill-ctx-input" data-file="${img.file}" value="${img.savedContext || ''}" placeholder="e.g. Baphomet, Chaos Star Sigil, TV Parable" autocomplete="off">
          </div>
        </div>
      `;
      illustrationsList.appendChild(tile);
    });
  }

  // 2. Settings update
  formSettings.addEventListener("submit", async (e) => {
    e.preventDefault();
    const bookTitle = inputBookTitle.value.trim();
    const apiKey = inputApiKey.value.trim();

    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookTitle, apiKey })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      inputApiKey.value = ""; // Clear password input after saving
      alert("Settings saved successfully!");
      loadStatus();
    } catch (err) {
      alert(`Error saving settings: ${err.message}`);
    }
  });

  // Toggle API key view
  btnToggleKey.addEventListener("click", () => {
    if (inputApiKey.type === "password") {
      inputApiKey.type = "text";
      btnToggleKey.textContent = "Hide";
    } else {
      inputApiKey.type = "password";
      btnToggleKey.textContent = "Show";
    }
  });

  // 3. HTML5 Multi-image selector upload
  function setupUploads() {
    // Click dropzone triggers file picker
    dropzone.addEventListener("click", () => filePicker.click());

    // File picker selection
    filePicker.addEventListener("change", () => {
      const files = Array.from(filePicker.files);
      if (files.length > 0) uploadFiles(files);
    });

    // Drag and Drop
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    });

    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("dragover");
    });

    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
      const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
      if (files.length > 0) uploadFiles(files);
    });
  }

  // Upload sequential batch files via AJAX Base64
  async function uploadFiles(files) {
    uploadProgressContainer.classList.remove("hidden");
    let uploadedCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      uploadProgressLabel.textContent = `Uploading file ${i + 1} of ${files.length}: ${file.name}`;
      
      try {
        const base64Data = await readFileAsBase64(file);
        
        const res = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, data: base64Data })
        });
        const result = await res.json();
        if (!result.success) throw new Error(result.error);

        uploadedCount++;
        const percent = Math.round((uploadedCount / files.length) * 100);
        uploadProgressFill.style.width = `${percent}%`;
        uploadProgressPercent.textContent = `${percent}%`;
      } catch (err) {
        console.error(`Failed uploading ${file.name}:`, err);
        alert(`Failed uploading ${file.name}: ${err.message}`);
      }
    }

    uploadProgressLabel.textContent = `Upload completed! Parsed ${uploadedCount} screenshots.`;
    setTimeout(() => {
      uploadProgressContainer.classList.add("hidden");
      uploadProgressFill.style.width = "0%";
      uploadProgressPercent.textContent = "0%";
      // Reload stats and drop list
      loadStatus();
    }, 1800);
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = (e) => reject(e);
      reader.readAsDataURL(file);
    });
  }

  // 4. Run the OCR & Gemini streams
  btnStart.addEventListener("click", async () => {
    const date = selectDate.value;
    if (!date) return;

    // Collect custom inputs first and save them in state
    const inputs = document.querySelectorAll(".ill-ctx-input");
    const contexts = {};
    inputs.forEach(inp => {
      contexts[inp.dataset.file] = inp.value.trim();
    });

    try {
      // Save current contexts
      await fetch("/api/save-contexts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contexts })
      });

      // Switch to Processing panel
      setStepActive(stepProcess, panelProcess);
      consoleLogs.innerHTML = "";
      processBarFill.style.width = "0%";
      processPercent.textContent = "0%";
      processStepTitle.textContent = "Connecting to Pipeline...";

      // Open SSE logging Stream
      const sse = new EventSource(`/api/process-stream?date=${encodeURIComponent(date)}`);
      
      sse.addEventListener("message", (e) => {
        const data = JSON.parse(e.data);
        
        if (data.type === "log") {
          appendLog(data.message, "info");
        } 
        else if (data.type === "progress") {
          processStepTitle.textContent = data.message;
          if (data.value !== undefined) {
            processBarFill.style.width = `${data.value}%`;
            processPercent.textContent = `${data.value}%`;
          }
        } 
        else if (data.type === "error") {
          appendLog(`ERROR: ${data.message}`, "error");
          processStepTitle.textContent = "Process Failed";
          sse.close();
          // Add standard back button in console for visual ease
          const backBtn = document.createElement("button");
          backBtn.className = "btn btn-secondary";
          backBtn.style.marginTop = "14px";
          backBtn.textContent = "Go back to Configuration";
          backBtn.onclick = () => setStepActive(stepConfig, panelConfig);
          consoleLogs.appendChild(backBtn);
        } 
        else if (data.type === "complete") {
          appendLog("AI Analysis Success!", "success");
          sse.close();

          appState.draftContent = data.reviewData.draftContent;
          appState.illustrations = data.reviewData.illustrations;

          // Shift to review screen after a short 1s delay
          setTimeout(() => {
            renderReviewPanel();
          }, 1000);
        }
      });

      sse.onerror = (err) => {
        console.error("SSE Error:", err);
        appendLog("System stream connectivity failed. Pipeline terminated.", "error");
        sse.close();
      };

    } catch (err) {
      alert(`Process initialization error: ${err.message}`);
    }
  });

  function appendLog(msg, type = "info") {
    const p = document.createElement("p");
    p.className = `log-${type}`;
    p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    consoleLogs.appendChild(p);
    consoleLogs.scrollTop = consoleLogs.scrollHeight; // Auto-scroll
  }

  // 5. Review & Finalize Form Renders
  function renderReviewPanel() {
    setStepActive(stepReview, panelReview);
    reviewGrid.innerHTML = "";

    if (appState.illustrations.length === 0) {
      reviewGrid.innerHTML = `
        <div class="empty-illustrations" style="grid-column: 1 / -1;">
          <p>No full-screen illustrations were detected. You are ready to finalize and save the daily Markdown note directly!</p>
        </div>
      `;
      return;
    }

    appState.illustrations.forEach((ill, idx) => {
      const tile = document.createElement("div");
      tile.className = "review-tile";
      tile.innerHTML = `
        <div class="review-thumb-wrapper">
          <img src="/api/screenshot/${ill.originalFile}" class="review-thumb-img" alt="Review Illustration">
        </div>
        <div class="review-tile-content">
          <div class="review-meta-row">
            <span class="review-tag">Illustration ${idx + 1}</span>
            <span class="review-time">${ill.time}</span>
          </div>
          <div class="form-group">
            <label>Final Filename (.jpg)</label>
            <textarea class="review-name-input" rows="2" data-orig="${ill.originalFile}" style="resize: none;">${ill.suggestedName}</textarea>
            <small class="form-help text-muted">Original: ${ill.originalFile}</small>
          </div>
        </div>
      `;
      reviewGrid.appendChild(tile);
    });
  }

  // 6. Submit final reviewed filenames to backend for crop generation
  btnSaveFinalize.addEventListener("click", async () => {
    btnSaveFinalize.disabled = true;
    btnSaveFinalize.textContent = "Processing sequential crops...";

    const inputs = document.querySelectorAll(".review-name-input");
    const illustrationsMapping = [];
    inputs.forEach(inp => {
      illustrationsMapping.push({
        originalFile: inp.dataset.orig,
        finalizedName: inp.value.trim()
      });
    });

    try {
      const res = await fetch("/api/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: appState.selectedDate,
          draftContent: appState.draftContent,
          illustrations: illustrationsMapping
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      // Populate step 4 completed labels
      outputMdName.textContent = `${appState.selectedDate}.md`;
      outputImgFolderName.textContent = `${appState.selectedDate} Extracted Images/`;

      setStepActive(stepSuccess, panelSuccess);
    } catch (err) {
      alert(`Finalize failed: ${err.message}`);
    } finally {
      btnSaveFinalize.disabled = false;
      btnSaveFinalize.textContent = "Finalize Notes & Save Sequential Crops";
    }
  });

  // Go back to config from review
  btnBackConfig.addEventListener("click", () => {
    setStepActive(stepConfig, panelConfig);
  });

  // Reset Pipeline back to config screen
  btnResetPipeline.addEventListener("click", () => {
    selectDate.value = "";
    statWrapper.classList.add("hidden");
    renderEmptyIllustrations();
    setStepActive(stepConfig, panelConfig);
    loadStatus();
  });

  // Open System Explorer
  const openSystemExplorer = async () => {
    try {
      await fetch("/api/open-explorer", { method: "POST" });
    } catch (err) {
      console.error("Explorer command error:", err);
    }
  };
  btnExplorerFinal.addEventListener("click", openSystemExplorer);
  btnExplorerHeader.addEventListener("click", openSystemExplorer);

  // --- Helper: UI step visual navigation controller ---
  function setStepActive(stepIndicator, targetPanel) {
    // Reset all step labels
    [stepConfig, stepProcess, stepReview, stepSuccess].forEach(ind => {
      ind.classList.remove("active", "completed");
    });
    
    // Set completed states
    if (stepIndicator === stepProcess) {
      stepConfig.classList.add("completed");
    } else if (stepIndicator === stepReview) {
      stepConfig.classList.add("completed");
      stepProcess.classList.add("completed");
    } else if (stepIndicator === stepSuccess) {
      stepConfig.classList.add("completed");
      stepProcess.classList.add("completed");
      stepReview.classList.add("completed");
    }
    
    stepIndicator.classList.add("active");

    // Toggle panels visibility
    [panelConfig, panelProcess, panelReview, panelSuccess].forEach(panel => {
      panel.classList.remove("active");
    });
    targetPanel.classList.add("active");
  }

  function setupEventListeners() {
    // Select batch dropdown listener
    selectDate.addEventListener("change", (e) => {
      updateSelectedBatchStats(e.target.value);
    });
  }

});
