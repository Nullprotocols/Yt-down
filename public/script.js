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
const downloadOverlay = document.getElementById('downloadOverlay');

function formatNumber(num) {
  if (!num && num !== 0) return '0';
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

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

function showError(message) {
  alert('Error: ' + message);
  setLoading(false);
}

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

    thumbnail.src = data.thumbnail || '';
    videoTitle.textContent = data.title || 'Untitled';
    channelName.textContent = data.channelName || 'Unknown Channel';
    duration.textContent = data.duration || '0:00';
    views.textContent = formatNumber(data.views) + ' views';
    likes.textContent = '❤️ ' + formatNumber(data.likes);

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

      document.querySelectorAll('.download-btn').forEach((btn) => {
        btn.addEventListener('click', handleDownload);
      });
    } else {
      qualityCards.innerHTML = '<p style="color:#aaa;">No video qualities available for this video.</p>';
    }

    results.classList.remove('hidden');
  } catch (error) {
    showError(error.message);
  } finally {
    setLoading(false);
  }
}

async function handleDownload(event) {
  const btn = event.target;
  const quality = btn.dataset.quality;
  const url = urlInput.value.trim();

  btn.disabled = true;
  downloadOverlay.classList.remove('hidden');

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, quality }),
    });

    downloadOverlay.classList.add('hidden');

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Download failed');
    }

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
    downloadOverlay.classList.add('hidden');
    alert('Download error: ' + error.message);
    btn.textContent = 'Download';
    btn.disabled = false;
  }
}

analyzeBtn.addEventListener('click', handleAnalyze);

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    analyzeBtn.click();
  }
});

window.addEventListener('load', () => {
  urlInput.focus();
});

setInterval(() => {
  fetch('/keep-alive')
    .then(() => console.log('[KeepAlive] Pinged server successfully'))
    .catch(() => { });
}, 5 * 60 * 1000);
