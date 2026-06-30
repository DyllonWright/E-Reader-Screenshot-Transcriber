// gui/public/app.js

document.addEventListener("DOMContentLoaded", () => {
  // --- Application State ---
  let appState = {
    bookTitle: "",
    apiKeyPresent: false,
    dates: [],
    datesInfo: [],
    groups: {},
    selectedDate: "",
    draftContent: "",
    illustrations: [] // From AI: { originalFile, suggestedName, time }
  };
  let ocrPollTimeout = null;
  let geminiTimerId = null;

  // --- DOM Elements ---
  const stepConfig = document.getElementById("step-ind-config");
  const stepProcess = document.getElementById("step-ind-process");
  const stepReview = document.getElementById("step-ind-review");
  const stepSuccess = document.getElementById("step-ind-success");

  const panelConfig = document.getElementById("panel-config");
  const panelProcess = document.getElementById("panel-process");
  const panelReview = document.getElementById("panel-review");
  const panelSuccess = document.getElementById("panel-success");

  const batchListContainer = document.getElementById("batch-list-container");
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
      appState.datesInfo = data.datesInfo || [];
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
 
      // Handle Background OCR Progress Heartbeat Widget
      const ocrCard = document.getElementById("ocr-progress-card");
      const ocrLabel = document.getElementById("ocr-count-label");
      const ocrFill = document.getElementById("ocr-progress-fill");
 
      if (data.ocrActive) {
        if (ocrCard) ocrCard.classList.remove("hidden");
        if (ocrLabel) ocrLabel.textContent = `${data.ocrProcessed} / ${data.ocrTotal}`;
        if (ocrFill) {
          const percent = data.ocrTotal > 0 ? Math.round((data.ocrProcessed / data.ocrTotal) * 100) : 0;
          ocrFill.style.width = `${percent}%`;
        }
        
        // Schedule next poll
        if (ocrPollTimeout) clearTimeout(ocrPollTimeout);
        ocrPollTimeout = setTimeout(loadStatus, 1500);
      } else {
        if (ocrCard) ocrCard.classList.add("hidden");
        if (ocrPollTimeout) {
          clearTimeout(ocrPollTimeout);
          ocrPollTimeout = null;
        }
      }
 
      // Render Batches List
      renderBatchList();
    } catch (err) {
      console.error("Failed to load system status:", err);
    }
  }

  // Render batches interactive cards list
  function renderBatchList() {
    const selected = appState.selectedDate;
    batchListContainer.innerHTML = "";

    if (appState.datesInfo.length === 0) {
      batchListContainer.innerHTML = `
        <div class="batch-loading-placeholder">
          No screenshots found. Drag/drop image files to import.
        </div>
      `;
      btnStart.disabled = true;
      statWrapper.classList.add("hidden");
      renderEmptyIllustrations();
      return;
    }

    appState.datesInfo.forEach(info => {
      const card = document.createElement("div");
      card.className = `batch-card${info.date === selected ? ' selected' : ''}`;
      card.dataset.date = info.date;

      let statusBadgeHtml = "";
      let progressBarHtml = "";

      if (info.status === "completed") {
        statusBadgeHtml = `<span class="batch-status-badge batch-status-completed">🟢 Finalized</span>`;
      } else if (info.status === "paused") {
        statusBadgeHtml = `<span class="batch-status-badge batch-status-paused">🟡 Resume Draft</span>`;
      } else if (info.status === "ocr_done") {
        statusBadgeHtml = `<span class="batch-status-badge batch-status-ocr_done">🔴 OCR Ready</span>`;
      } else {
        statusBadgeHtml = `<span class="batch-status-badge batch-status-ocr_active">⚫ OCR Underway</span>`;
        const percent = info.totalFiles > 0 ? Math.round((info.ocrCachedCount / info.totalFiles) * 100) : 0;
        progressBarHtml = `
          <div class="batch-card-progress">
            <div class="batch-progress-info">
              <span>OCR Progress</span>
              <span>${info.ocrCachedCount} / ${info.totalFiles} (${percent}%)</span>
            </div>
            <div class="batch-progress-bar-bg">
              <div class="batch-progress-bar-fill" style="width: ${percent}%;"></div>
            </div>
          </div>
        `;
      }

      card.innerHTML = `
        <div class="batch-card-header">
          <span class="batch-card-date">${info.date}</span>
          ${statusBadgeHtml}
        </div>
        <div class="batch-card-meta">
          <span>Total: ${info.totalFiles} screenshots</span>
        </div>
        ${progressBarHtml}
      `;

      card.addEventListener("click", () => {
        // Toggle selection
        document.querySelectorAll(".batch-card").forEach(c => c.classList.remove("selected"));
        card.classList.add("selected");
        updateSelectedBatchStats(info.date);
      });

      batchListContainer.appendChild(card);
    });

    if (selected && appState.dates.includes(selected)) {
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
    const texts = items.filter(item => item.type === "text").length;
    const pending = items.filter(item => item.type === "pending").length;

    statTotal.textContent = total;
    statText.textContent = texts;
    statImage.textContent = images;
    statWrapper.classList.remove("hidden");

    // Check status of selected date batch
    const dateInfo = appState.datesInfo.find(d => d.date === date);
    const hasPending = pending > 0;
    const warningEl = document.getElementById("batch-pending-warning");
    
    if (hasPending) {
      if (warningEl) warningEl.classList.remove("hidden");
    } else {
      if (warningEl) warningEl.classList.add("hidden");
    }

    if (dateInfo) {
      if (dateInfo.status === "completed") {
        btnStart.textContent = "Load Saved Batch (Review / Redo Crops)";
        btnStart.disabled = false;
      } else if (dateInfo.status === "paused") {
        btnStart.textContent = "Resume Saved Batch (Review & Finalize)";
        btnStart.disabled = false;
      } else if (dateInfo.status === "ocr_active") {
        btnStart.textContent = "OCR Processing...";
        btnStart.disabled = true;
      } else {
        btnStart.textContent = "Run AI Transcription & Extractor";
        btnStart.disabled = hasPending || total === 0;
      }
    } else {
      btnStart.textContent = "Run AI Transcription & Extractor";
      btnStart.disabled = hasPending || total === 0;
    }

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
            <input type="text" class="ill-ctx-input" data-file="${img.file}" value="${img.savedContext || ''}" placeholder="e.g. Chapter title illustration, map, character sketch" autocomplete="off">
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

  // 4. Run the OCR & Gemini streams or Resume Cache
  btnStart.addEventListener("click", async () => {
    const date = appState.selectedDate;
    if (!date) return;

    // Check if the selected batch can be loaded from cache directly
    const dateInfo = appState.datesInfo.find(d => d.date === date);
    const shouldLoadFromCache = dateInfo && (dateInfo.status === "completed" || dateInfo.status === "paused");

    if (shouldLoadFromCache) {
      try {
        btnStart.disabled = true;
        const res = await fetch(`/api/load-cache?date=${encodeURIComponent(date)}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);

        appState.draftContent = data.cache.draftContent;
        appState.illustrations = data.cache.illustrations.map(ill => ({
          ...ill,
          crop: ill.crop ? { ...ill.crop } : (ill.suggestedCrop ? { ...ill.suggestedCrop } : null)
        }));

        renderReviewPanel();
      } catch (err) {
        alert(`Failed to load cached pipeline: ${err.message}`);
      } finally {
        btnStart.disabled = false;
      }
      return;
    }

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
          const isGemini = data.message.includes("Gemini") || data.message.includes("Contacting") || data.message.includes("Retrying");
          if (isGemini) {
            startGeminiTimer(data.message, data.value);
          } else {
            stopGeminiTimer();
            processStepTitle.textContent = data.message;
            if (data.value !== undefined) {
              processBarFill.style.width = `${data.value}%`;
              processPercent.textContent = `${data.value}%`;
            }
          }
        } 
        else if (data.type === "error") {
          stopGeminiTimer();
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
          stopGeminiTimer();
          appendLog("AI Analysis Success!", "success");
          sse.close();

          appState.draftContent = data.reviewData.draftContent;
          appState.illustrations = data.reviewData.illustrations.map(ill => ({
            ...ill,
            crop: ill.suggestedCrop ? { ...ill.suggestedCrop } : null
          }));

          // Shift to review screen after a short 1s delay
          setTimeout(() => {
            renderReviewPanel();
          }, 1000);
        }
      });

      sse.onerror = (err) => {
        stopGeminiTimer();
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

  // Timer helpers for Gemini processing steps
  function startGeminiTimer(baseMessage, progressValue) {
    if (geminiTimerId) clearInterval(geminiTimerId);
    const startTime = Date.now();
    function updateMessage() {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      processStepTitle.textContent = `${baseMessage} (${elapsed}s)`;
    }
    updateMessage();
    geminiTimerId = setInterval(updateMessage, 1000);
    if (progressValue !== undefined) {
      processBarFill.style.width = `${progressValue}%`;
      processPercent.textContent = `${progressValue}%`;
    }
  }

  function stopGeminiTimer() {
    if (geminiTimerId) {
      clearInterval(geminiTimerId);
      geminiTimerId = null;
    }
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

      // Render the percentage-based crop outline preview
      let cropOverlayHtml = "";
      if (ill.crop && ill.originalWidth > 0 && ill.originalHeight > 0) {
        const left = (ill.crop.x / ill.originalWidth) * 100;
        const top = (ill.crop.y / ill.originalHeight) * 100;
        const width = (ill.crop.w / ill.originalWidth) * 100;
        const height = (ill.crop.h / ill.originalHeight) * 100;
        cropOverlayHtml = `
          <div class="crop-overlay-container">
            <div class="crop-box-outline" style="left: ${left}%; top: ${top}%; width: ${width}%; height: ${height}%;"></div>
          </div>
        `;
      }

      tile.innerHTML = `
        <div class="review-thumb-wrapper" data-idx="${idx}" title="Click to adjust crop region">
          <img src="/api/screenshot/${ill.originalFile}" class="review-thumb-img" alt="Review Illustration">
          ${cropOverlayHtml}
          <div class="crop-click-hint">Click to Crop</div>
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

      // Bind click handler to open crop modal
      const thumb = tile.querySelector(".review-thumb-wrapper");
      thumb.addEventListener("click", () => {
        openCropModal(idx);
      });

      reviewGrid.appendChild(tile);
    });
  }

  // --- Manual Crop Modal Logic ---
  const cropModal = document.getElementById("crop-modal");
  const cropImg = document.getElementById("crop-editor-img");
  const cropBox = document.getElementById("crop-editor-box");
  const btnCloseModal = document.getElementById("btn-close-modal");
  const btnCancelCrop = document.getElementById("btn-cancel-crop");
  const btnSaveCrop = document.getElementById("btn-save-crop");

  let cropState = {
    idx: -1,
    dispW: 0,
    dispH: 0,
    origW: 0,
    origH: 0,
    scaleX: 1,
    scaleY: 1,
    
    // Crop box coordinates in display pixels
    left: 0,
    top: 0,
    width: 0,
    height: 0,

    isDragging: false,
    isResizing: false,
    activeHandle: null,
    
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
    startWidth: 0,
    startHeight: 0
  };

  function openCropModal(idx) {
    const ill = appState.illustrations[idx];
    if (!ill) return;

    cropState.idx = idx;
    cropState.origW = ill.originalWidth || 1080;
    cropState.origH = ill.originalHeight || 1920;

    // Load illustration image into cropping workspace
    cropImg.src = `/api/screenshot/${ill.originalFile}`;
    cropModal.classList.remove("hidden");

    cropImg.onload = () => {
      cropState.dispW = cropImg.clientWidth;
      cropState.dispH = cropImg.clientHeight;
      
      cropState.scaleX = cropState.dispW / cropState.origW;
      cropState.scaleY = cropState.dispH / cropState.origH;

      // Set active crop coordinates
      const activeCrop = ill.crop || ill.suggestedCrop || { x: 0, y: Math.round(cropState.origH * 0.08), w: cropState.origW, h: Math.round(cropState.origH * 0.84) };

      cropState.left = activeCrop.x * cropState.scaleX;
      cropState.top = activeCrop.y * cropState.scaleY;
      cropState.width = activeCrop.w * cropState.scaleX;
      cropState.height = activeCrop.h * cropState.scaleY;

      updateCropBoxStyle();
    };
  }

  function closeCropModal() {
    cropModal.classList.add("hidden");
    cropImg.src = "";
    cropImg.onload = null;
  }

  function updateCropBoxStyle() {
    cropBox.style.left = `${cropState.left}px`;
    cropBox.style.top = `${cropState.top}px`;
    cropBox.style.width = `${cropState.width}px`;
    cropBox.style.height = `${cropState.height}px`;
  }

  function onDragStart(e) {
    const target = e.target;
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);

    if (target.classList.contains("crop-handle")) {
      cropState.isResizing = true;
      cropState.activeHandle = target.classList.contains("handle-tl") ? "tl" :
                               target.classList.contains("handle-tr") ? "tr" :
                               target.classList.contains("handle-bl") ? "bl" : "br";
    } else if (target === cropBox || cropBox.contains(target)) {
      cropState.isDragging = true;
    } else {
      return;
    }

    cropState.startX = clientX;
    cropState.startY = clientY;
    cropState.startLeft = cropState.left;
    cropState.startTop = cropState.top;
    cropState.startWidth = cropState.width;
    cropState.startHeight = cropState.height;

    e.preventDefault();
  }

  function onDragMove(e) {
    if (!cropState.isDragging && !cropState.isResizing) return;

    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);

    const dx = clientX - cropState.startX;
    const dy = clientY - cropState.startY;

    if (cropState.isDragging) {
      let newLeft = cropState.startLeft + dx;
      let newTop = cropState.startTop + dy;

      newLeft = Math.max(0, Math.min(cropState.dispW - cropState.width, newLeft));
      newTop = Math.max(0, Math.min(cropState.dispH - cropState.height, newTop));

      cropState.left = newLeft;
      cropState.top = newTop;
    } 
    else if (cropState.isResizing) {
      const minSize = 25; // min width/height in display pixels

      if (cropState.activeHandle === "br") {
        let newWidth = cropState.startWidth + dx;
        let newHeight = cropState.startHeight + dy;

        newWidth = Math.max(minSize, Math.min(cropState.dispW - cropState.startLeft, newWidth));
        newHeight = Math.max(minSize, Math.min(cropState.dispH - cropState.startTop, newHeight));

        cropState.width = newWidth;
        cropState.height = newHeight;
      } 
      else if (cropState.activeHandle === "tr") {
        let newTop = cropState.startTop + dy;
        let newHeight = cropState.startHeight - dy;
        let newWidth = cropState.startWidth + dx;

        if (newTop < 0) {
          newHeight = cropState.startTop + cropState.startHeight;
          newTop = 0;
        } else if (newHeight < minSize) {
          newHeight = minSize;
          newTop = cropState.startTop + cropState.startHeight - minSize;
        }

        newWidth = Math.max(minSize, Math.min(cropState.dispW - cropState.startLeft, newWidth));

        cropState.top = newTop;
        cropState.height = newHeight;
        cropState.width = newWidth;
      } 
      else if (cropState.activeHandle === "bl") {
        let newLeft = cropState.startLeft + dx;
        let newWidth = cropState.startWidth - dx;
        let newHeight = cropState.startHeight + dy;

        if (newLeft < 0) {
          newWidth = cropState.startLeft + cropState.startWidth;
          newLeft = 0;
        } else if (newWidth < minSize) {
          newWidth = minSize;
          newLeft = cropState.startLeft + cropState.startWidth - minSize;
        }

        newHeight = Math.max(minSize, Math.min(cropState.dispH - cropState.startTop, newHeight));

        cropState.left = newLeft;
        cropState.width = newWidth;
        cropState.height = newHeight;
      } 
      else if (cropState.activeHandle === "tl") {
        let newLeft = cropState.startLeft + dx;
        let newWidth = cropState.startWidth - dx;
        let newTop = cropState.startTop + dy;
        let newHeight = cropState.startHeight - dy;

        if (newLeft < 0) {
          newWidth = cropState.startLeft + cropState.startWidth;
          newLeft = 0;
        } else if (newWidth < minSize) {
          newWidth = minSize;
          newLeft = cropState.startLeft + cropState.startWidth - minSize;
        }

        if (newTop < 0) {
          newHeight = cropState.startTop + cropState.startHeight;
          newTop = 0;
        } else if (newHeight < minSize) {
          newHeight = minSize;
          newTop = cropState.startTop + cropState.startHeight - minSize;
        }

        cropState.left = newLeft;
        cropState.width = newWidth;
        cropState.top = newTop;
        cropState.height = newHeight;
      }
    }

    updateCropBoxStyle();
  }

  function onDragEnd() {
    cropState.isDragging = false;
    cropState.isResizing = false;
    cropState.activeHandle = null;
  }

  // Hook up event listeners for manual cropping modal
  cropBox.addEventListener("mousedown", onDragStart);
  cropBox.addEventListener("touchstart", onDragStart, { passive: false });

  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("touchmove", onDragMove, { passive: false });

  window.addEventListener("mouseup", onDragEnd);
  window.addEventListener("touchend", onDragEnd);

  btnCloseModal.addEventListener("click", closeCropModal);
  btnCancelCrop.addEventListener("click", closeCropModal);
  btnSaveCrop.addEventListener("click", () => {
    const ill = appState.illustrations[cropState.idx];
    if (ill) {
      // Convert display pixels back to original image space
      const newCrop = {
        x: Math.round(cropState.left / cropState.scaleX),
        y: Math.round(cropState.top / cropState.scaleY),
        w: Math.round(cropState.width / cropState.scaleX),
        h: Math.round(cropState.height / cropState.scaleY)
      };

      // Clamp values within original image space
      newCrop.x = Math.max(0, Math.min(cropState.origW - 1, newCrop.x));
      newCrop.y = Math.max(0, Math.min(cropState.origH - 1, newCrop.y));
      newCrop.w = Math.max(1, Math.min(cropState.origW - newCrop.x, newCrop.w));
      newCrop.h = Math.max(1, Math.min(cropState.origH - newCrop.y, newCrop.h));

      ill.crop = newCrop;
    }
    closeCropModal();
    renderReviewPanel(); // refresh crop outline visual on review thumbnails
  });

  // 6. Submit final reviewed filenames to backend for crop generation
  btnSaveFinalize.addEventListener("click", async () => {
    btnSaveFinalize.disabled = true;
    btnSaveFinalize.textContent = "Processing sequential crops...";

    const inputs = document.querySelectorAll(".review-name-input");
    const illustrationsMapping = [];
    inputs.forEach(inp => {
      const origFile = inp.dataset.orig;
      const ill = appState.illustrations.find(i => i.originalFile === origFile);
      illustrationsMapping.push({
        originalFile: origFile,
        finalizedName: inp.value.trim(),
        crop: ill ? ill.crop : null
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
      const imgFolderItem = document.getElementById("success-img-folder-item");
      if (appState.illustrations && appState.illustrations.length > 0) {
        outputImgFolderName.textContent = `${appState.selectedDate} Extracted Images/`;
        if (imgFolderItem) imgFolderItem.classList.remove("hidden");
      } else {
        if (imgFolderItem) imgFolderItem.classList.add("hidden");
      }

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
    appState.selectedDate = "";
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
    // Click listeners are added dynamically during card rendering
  }

});
