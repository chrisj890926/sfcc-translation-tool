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

  // Track selected files as an array
  let selectedFiles = [];

  // Handle Drag and Drop
  dropZone.addEventListener('click', () => fileInput.click());

  // Handle XML Format Selection UI Toggles
  const formatOptions = document.querySelectorAll('.format-option');
  formatOptions.forEach(option => {
    option.addEventListener('click', () => {
      formatOptions.forEach(opt => opt.classList.remove('active'));
      option.classList.add('active');
    });
  });

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

    const payload = {
      xmlContents: fileContents,
      targetLanguages,
      protectedTerms,
      mode,
      xmlFormat // kept for backward compatibility
    };

    // Update UI state
    const fileCount = selectedFiles.length;
    translateBtn.disabled = true;
    btnText.textContent = fileCount > 1
      ? `Translating ${fileCount} files...`
      : 'Translating...';
    spinner.classList.remove('hidden');
    errorArea.classList.add('hidden');
    resultArea.classList.add('hidden');

    try {
      const response = await fetch('/api/translate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Translation failed.');
      }

      // Handle file download
      const blob = new Blob([data.xmlContent], { type: 'application/xml' });
      const url = window.URL.createObjectURL(blob);
      
      downloadLink.href = url;

      // Determine download filename
      let downloadName;
      if (fileCount > 1) {
        downloadName = xmlFormat === 'product-section'
          ? 'merged-translated.xml'
          : 'merged-xdefault-cloned.xml';
        resultMsg.textContent = `${fileCount} files translated and merged into one XML file.`;
      } else {
        const originalName = selectedFiles[0].name;
        const suffix = xmlFormat === 'product-section' ? '.translated.xml' : '.xdefault-cloned.xml';
        downloadName = originalName.replace('.xml', suffix);
        resultMsg.textContent = 'Your translated XML file is ready.';
      }
      downloadLink.download = downloadName;
      
      resultArea.classList.remove('hidden');

    } catch (error) {
      showError(error.message);
    } finally {
      // Reset UI state
      translateBtn.disabled = false;
      btnText.textContent = 'Translate XML';
      spinner.classList.add('hidden');
    }
  });

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
      reader.readAsText(file);
    });
  }

  resetBtn.addEventListener('click', () => {
    form.reset();
    selectedFiles = [];
    updateFileListUI();
    resultArea.classList.add('hidden');
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
