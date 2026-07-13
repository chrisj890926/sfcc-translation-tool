document.addEventListener('DOMContentLoaded', () => {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('xmlFile');
  const dropText = document.getElementById('dropText');
  const fileList = document.getElementById('fileList');
  const form = document.getElementById('translateForm');
  const translateBtn = document.getElementById('translateBtn');
  const btnText = document.querySelector('.btn-text');
  const spinner = document.querySelector('.spinner');
  const resultArea = document.getElementById('resultArea');
  const resultMsg = document.getElementById('resultMsg');
  const downloadLink = document.getElementById('downloadLink');
  const errorArea = document.getElementById('errorArea');
  const errorMsg = document.getElementById('errorMsg');
  const resetBtn = document.getElementById('resetBtn');

  // Progress UI elements
  const progressArea = document.getElementById('progressArea');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressPhase = document.getElementById('progressPhase');
  const progressPct = document.getElementById('progressPct');
  const progressComponent = document.getElementById('progressComponent');
  const progressLocale = document.getElementById('progressLocale');
  const statTranslated = document.getElementById('statTranslated');
  const statSkipped = document.getElementById('statSkipped');
  const statFailed = document.getElementById('statFailed');
  const statElapsed = document.getElementById('statElapsed');
  const statRemaining = document.getElementById('statRemaining');
  const statProvider = document.getElementById('statProvider');
  const statModel = document.getElementById('statModel');
  const statInputTokens = document.getElementById('statInputTokens');
  const statOutputTokens = document.getElementById('statOutputTokens');
  const statCost = document.getElementById('statCost');
  const extractionInfo = document.getElementById('extractionInfo');

  let pollTimer = null;

  function fmtDuration(seconds) {
    if (seconds == null || !isFinite(seconds)) return '—';
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  function renderProgress(status) {
    const pct = Math.max(0, Math.min(100, status.progress || 0));
    progressBarFill.style.width = `${pct}%`;
    progressPct.textContent = `${pct}%`;
    progressPhase.textContent = status.currentPhase || '…';
    progressComponent.textContent = status.currentComponent || '—';
    progressLocale.textContent = status.currentLocale || '—';
    statTranslated.textContent = status.translatedCount ?? 0;
    statSkipped.textContent = status.skippedCount ?? 0;
    statFailed.textContent = status.failedCount ?? 0;
    statElapsed.textContent = fmtDuration(status.elapsedSeconds);
    statProvider.textContent = status.provider || '—';
    statModel.textContent = status.model || '—';
    statInputTokens.textContent = (status.inputTokens ?? 0).toLocaleString();
    statOutputTokens.textContent = (status.outputTokens ?? 0).toLocaleString();
    statCost.textContent = `$${(status.estimatedCost ?? 0).toFixed(4)}`;

    // Estimated remaining = elapsed * (100 - pct) / pct (linear extrapolation).
    let remaining = null;
    if (pct > 0 && pct < 100 && status.elapsedSeconds > 0) {
      remaining = (status.elapsedSeconds * (100 - pct)) / pct;
    } else if (pct >= 100) {
      remaining = 0;
    }
    statRemaining.textContent = remaining == null ? '—' : fmtDuration(remaining);

    const ex = status.extraction;
    if (ex && ex.reducedContentCount != null) {
      extractionInfo.classList.remove('hidden');
      const label = ex.label || 'Reduced';
      const unit = ex.unit || 'items';
      let msg = `<span class="lbl">${label}:</span> ${ex.originalContentCount.toLocaleString()} → ${ex.reducedContentCount} ${unit}`;
      if (ex.includedIds && ex.includedIds.length) {
        msg += ` &nbsp;·&nbsp; <span class="lbl">ids:</span> ${ex.includedIds.join(', ')}`;
      }
      if (ex.missingSeeds && ex.missingSeeds.length) {
        msg += ` &nbsp;·&nbsp; <span class="lbl" style="color:#e0803a">not found:</span> ${ex.missingSeeds.join(', ')}`;
      }
      extractionInfo.innerHTML = msg;
    } else {
      extractionInfo.classList.add('hidden');
    }
  }

  // Track selected files as an array
  let selectedFiles = [];

  // Handle Drag and Drop
  dropZone.addEventListener('click', () => fileInput.click());

  // Handle XML Format Selection UI Toggles
  const formatOptions = document.querySelectorAll('.format-option');
  const productIdsGroup = document.getElementById('productIdsGroup');

  function syncProductIdsVisibility() {
    // Extraction now applies to both Page Designer libraries and Product catalogs.
    productIdsGroup.style.display = '';
  }

  formatOptions.forEach(option => {
    option.addEventListener('click', () => {
      formatOptions.forEach(opt => opt.classList.remove('active'));
      option.classList.add('active');
      const radio = option.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
      syncProductIdsVisibility();
    });
  });
  syncProductIdsVisibility();

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const newFiles = Array.from(dt.files).filter(f => f.name.endsWith('.xml'));
    if (newFiles.length) {
      addFiles(newFiles);
    }
  });

  fileInput.addEventListener('change', function() {
    const newFiles = Array.from(this.files).filter(f => f.name.endsWith('.xml'));
    if (newFiles.length) {
      addFiles(newFiles);
    }
    // Reset input so the same file(s) can be re-selected
    this.value = '';
  });

  function addFiles(newFiles) {
    // Add files, avoiding duplicates by name
    for (const file of newFiles) {
      const exists = selectedFiles.some(f => f.name === file.name);
      if (!exists) {
        selectedFiles.push(file);
      }
    }
    updateFileListUI();
    errorArea.classList.add('hidden');
  }

  function removeFile(index) {
    selectedFiles.splice(index, 1);
    updateFileListUI();
  }

  function updateFileListUI() {
    if (selectedFiles.length === 0) {
      dropText.textContent = 'Drag & drop your XML files here, or click to select';
      dropZone.classList.remove('has-file');
      fileList.classList.add('hidden');
      fileList.innerHTML = '';
      return;
    }

    const count = selectedFiles.length;
    dropText.textContent = `${count} file${count > 1 ? 's' : ''} selected — click to add more`;
    dropZone.classList.add('has-file');

    // Render file list
    fileList.classList.remove('hidden');
    fileList.innerHTML = selectedFiles.map((file, idx) => `
      <div class="file-item">
        <span class="file-item-icon">📄</span>
        <span class="file-item-name" title="${file.name}">${file.name}</span>
        <span class="file-item-size">${formatFileSize(file.size)}</span>
        <button type="button" class="file-item-remove" data-index="${idx}" title="Remove file">✕</button>
      </div>
    `).join('');

    // Attach remove handlers
    fileList.querySelectorAll('.file-item-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFile(parseInt(btn.dataset.index, 10));
      });
    });
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Handle Form Submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (selectedFiles.length === 0) {
      showError("Please select at least one XML file to translate.");
      return;
    }

    // Read all files as text
    const fileContents = await Promise.all(
      selectedFiles.map(file => readFileAsText(file).then(content => ({
        name: file.name,
        content
      })))
    );

    // Get other form values
    const formData = new FormData(form);
    const targetLanguages = formData.getAll('targetLanguages');
    const protectedTerms = formData.get('protectedTerms');
    const xmlFormat = formData.get('xmlFormat') || 'page-designer';
    // Map the UI format selector to the backend translator mode.
    const mode = xmlFormat === 'product-section' ? 'product' : 'page-designer';
    const productIds = (formData.get('productIds') || '').trim();
    const force = document.getElementById('forceRetranslate').checked;

    // Cost safety guard (mirrors the server). Without Product IDs the whole file
    // is translated — block clearly full catalog/library uploads before sending.
    if (!productIds) {
      let products = 0;
      let contents = 0;
      for (const f of fileContents) {
        products += (f.content.match(/<product product-id="/g) || []).length;
        contents += (f.content.match(/<content content-id="/g) || []).length;
      }
      if (products > 50 || contents > 200) {
        showError(
          'Product IDs is required for large full-catalog/library uploads to prevent accidental high API cost. ' +
            `(Detected ${products} products / ${contents} content blocks — enter Product IDs to extract, or split the file.)`
        );
        return;
      }
    }

    const payload = {
      xmlContents: fileContents,
      targetLanguages,
      protectedTerms,
      mode,
      xmlFormat, // kept for backward compatibility
      productIds, // comma-separated; server extracts the subtree(s) before translating
      force // overwrite existing target-locale values (fixes wrong-language)
    };

    // Determine download filename + completion message up front.
    const fileCount = selectedFiles.length;
    let downloadName;
    let completeMsg;
    if (fileCount > 1) {
      downloadName = xmlFormat === 'product-section' ? 'merged-translated.xml' : 'merged-xdefault-cloned.xml';
      completeMsg = `${fileCount} files translated and merged into one XML file.`;
    } else {
      const suffix = xmlFormat === 'product-section' ? '.translated.xml' : '.xdefault-cloned.xml';
      downloadName = selectedFiles[0].name.replace('.xml', suffix);
      completeMsg = 'Your translated XML file is ready.';
    }

    // Update UI state
    translateBtn.disabled = true;
    btnText.textContent = fileCount > 1 ? `Translating ${fileCount} files...` : 'Translating...';
    spinner.classList.remove('hidden');
    errorArea.classList.add('hidden');
    resultArea.classList.add('hidden');
    progressArea.classList.remove('hidden');
    renderProgress({ progress: 0, currentPhase: 'Starting…' });

    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Translation failed.');
      }
      pollJob(data.jobId, downloadName, completeMsg);
    } catch (error) {
      finishRun();
      showError(error.message);
    }
  });

  function finishRun() {
    translateBtn.disabled = false;
    btnText.textContent = 'Translate XML';
    spinner.classList.add('hidden');
  }

  function pollJob(jobId, downloadName, completeMsg) {
    if (pollTimer) clearInterval(pollTimer);

    const tick = async () => {
      let status;
      try {
        const res = await fetch(`/api/jobs/${jobId}`);
        status = await res.json();
        if (!res.ok) throw new Error(status.error || 'Failed to fetch job status.');
      } catch (err) {
        clearInterval(pollTimer);
        finishRun();
        showError(err.message);
        return;
      }

      renderProgress(status);

      if (status.status === 'completed') {
        clearInterval(pollTimer);
        try {
          const r = await fetch(`/api/jobs/${jobId}/result`);
          if (!r.ok) throw new Error('Failed to download translated XML.');
          const xml = await r.text();
          const blob = new Blob([xml], { type: 'application/xml' });
          downloadLink.href = window.URL.createObjectURL(blob);
          downloadLink.download = downloadName;
          resultMsg.textContent = completeMsg;
          progressArea.classList.add('hidden');
          resultArea.classList.remove('hidden');
        } catch (err) {
          showError(err.message);
        }
        finishRun();
      } else if (status.status === 'failed') {
        clearInterval(pollTimer);
        progressArea.classList.add('hidden');
        finishRun();
        showError(status.error || 'Translation failed.');
      }
    };

    tick();
    pollTimer = setInterval(tick, 1000);
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
      reader.readAsText(file);
    });
  }

  resetBtn.addEventListener('click', () => {
    if (pollTimer) clearInterval(pollTimer);
    form.reset();
    selectedFiles = [];
    updateFileListUI();
    resultArea.classList.add('hidden');
    progressArea.classList.add('hidden');
    extractionInfo.classList.add('hidden');
    errorArea.classList.add('hidden');
    fileInput.value = '';
    
    // Reset format selection to default
    formatOptions.forEach(opt => opt.classList.remove('active'));
    document.getElementById('label-pd').classList.add('active');
  });


  function showError(msg) {
    errorMsg.textContent = msg;
    errorArea.classList.remove('hidden');
  }
});
