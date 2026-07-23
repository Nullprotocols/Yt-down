/**
 * Frontend logic for YouTube Downloader
 */

const urlInput = document.getElementById('urlInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const loader = document.getElementById('loader');
const results = document.getElementById('results');
const thumbnail = document.getElementById('thumbnail');
const videoTitle = document.getElementById('videoTitle');
const channelName = document.getElementById('channelName');
const duration = document.getElementById('duration');
const views = document.getElementById('views');
const likes = document.getElementById('likes');
const qualityCards = document.getElementById('qualityCards');

// Helper: format numbers with commas
function formatNumber(num) {
  if (!num) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Helper: format file size (bytes to MB)
function formatSize(bytes) {
  if (!bytes) return 'Unknown';
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(1) + ' MB';
}

// Show loader, hide results, disable button
function setLoading(state) {
  if (state) {
    loader.classList.remove('hidden');
    results.classList.add('hidden');
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analyzing...';
  } else {
    loader.classList.add('hidden');
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = 'Analyze';
  }
}

// Display error message
function showError(message) {
  alert('Error: ' + message);
  setLoading(false);
}

// Handle analyze button click
async function handleAnalyze() {
  const url = urlInput.value.trim();
  if (!url) {
    showError('Please enter a valid YouTube URL.');
    return;
  }

  setLoading(true);

  try {
    const response = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch video info');
    }

    // Populate video info
    thumbnail.src = data.thumbnail || '';
    videoTitle.textContent = data.title || 'Untitled';
    channelName.textContent = data.channelName || 'Unknown';
    duration.textContent = data.duration || '0:00';
    views.textContent = formatNumber(data.views) + ' views';
    likes.textContent = '❤️ ' + formatNumber(data.likes);

    // Render quality cards
    qualityCards.innerHTML = '';
    if (data.qualities && data.qualities.length > 0) {
      data.qualities.forEach((q) => {
        const card = document.createElement('div');
        card.className = 'quality-card';
        card.innerHTML = `
          <div class="resolution">${q}</div>
          <div class="size">Size: Unknown</div>
          <button class="download-btn" data-quality="${q}">Download</button>
        `;
        qualityCards.appendChild(card);
      });

      // Attach download event listeners
      document.querySelectorAll('.download-btn').forEach((btn) => {
        btn.addEventListener('click', handleDownload);
      });
    } else {
      qualityCards.innerHTML = '<p style="color:#aaa;">No video qualities available.</p>';
    }

    results.classList.remove('hidden');
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
}

// Handle download button click
async function handleDownload(event) {
  const btn = event.target;
  const quality = btn.dataset.quality;
  const url = urlInput.value.trim();

  btn.disabled = true;
  btn.textContent = 'Downloading...';

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, quality }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Download failed');
    }

    // Create a blob from the response and trigger download
    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `video_${quality}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(downloadUrl);

    btn.textContent = 'Downloaded!';
    setTimeout(() => {
      btn.textContent = 'Download';
      btn.disabled = false;
    }, 3000);
  } catch (error) {
    alert('Download error: ' + error.message);
    btn.textContent = 'Download';
    btn.disabled = false;
  }
}

// Event listeners
analyzeBtn.addEventListener('click', handleAnalyze);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    analyzeBtn.click();
  }
});

// On page load, focus input
window.addEventListener('load', () => {
  urlInput.focus();
});

/* ==================================================
   KEEP ALIVE: Ping server every 5 minutes
   ================================================== */
setInterval(() => {
  fetch('/keep-alive')
    .then(() => console.log('[KeepAlive] Pinged server'))
    .catch(() => { /* ignore */ });
}, 5 * 60 * 1000);
