/**
 * YouTube Downloader Backend
 * Provides /api/info and /api/download endpoints
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { mergeVideoAudio } = require('./ffmpeg');

const app = express();
const PORT = process.env.PORT || 10000;
const YT_API_URL = process.env.YT_API_URL;

// Use system temp folder (Render-safe)
const TMP_DIR = path.join(os.tmpdir(), 'yt-downloader');
fs.ensureDirSync(TMP_DIR);

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: Normalize YouTube URL (Convert shorts to watch)
function normalizeYoutubeUrl(url) {
  if (url.includes('/shorts/')) {
    const videoId = url.split('/shorts/')[1].split(/[?#]/)[0];
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return url;
}

// Helper: format duration (seconds -> mm:ss)
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Helper: extract numeric bitrate from quality string (e.g. "256KBPS" -> 256)
function bitrateFromQuality(quality) {
  const match = quality.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

// Helper: clean up files
async function cleanupFiles(...paths) {
  for (const filePath of paths) {
    try {
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        console.log(`[Cleanup] Deleted ${filePath}`);
      }
    } catch (err) {
      console.warn(`[Cleanup] Failed to delete ${filePath}: ${err.message}`);
    }
  }
}

/**
 * GET /keep-alive - Simple endpoint to keep server awake
 */
app.get('/keep-alive', (req, res) => {
  res.status(200).send('OK');
});

/**
 * POST /api/info
 * Body: { url }
 */
app.post('/api/info', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    // Normalize URL and set browser user-agent to avoid 403 on API
    const normalizedUrl = normalizeYoutubeUrl(url);
    const apiUrl = `${YT_API_URL}${encodeURIComponent(normalizedUrl)}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    console.log(`[Info] Fetching: ${apiUrl}`);
    const response = await axios.get(apiUrl, { headers, timeout: 15000 });
    const data = response.data;

    // Validate response structure
    const videoInfo = data.video_info || {};
    if (!videoInfo.title) {
      return res.status(404).json({ error: 'Video not found or unavailable' });
    }

    // Extract metadata
    const title = videoInfo.title;
    const thumbnail = videoInfo.thumbnail;
    const durationSec = videoInfo.duration_seconds;
    const duration = formatDuration(durationSec);

    // Channel info
    const channelInfo = data.channel_info || {};
    const channelName = channelInfo.title || 'Unknown';

    // Statistics
    const stats = data.statistics || {};
    const views = stats.viewCount || 0;
    const likes = stats.likeCount || 0;

    // Parse download links
    const downloadLinks = data.download_links || {};
    const vidssave = downloadLinks.vidssave || [];
    const videoStreams = vidssave.filter(item => item.type === 'video');

    // Extract unique video qualities
    const qualities = videoStreams
      .map(item => item.quality)
      .filter((q, index, self) => self.indexOf(q) === index)
      .sort((a, b) => {
        const numA = parseInt(a, 10);
        const numB = parseInt(b, 10);
        return numA - numB;
      });

    // Prepare response
    const result = {
      title,
      thumbnail,
      duration,
      channelName,
      views,
      likes,
      qualities,
    };

    res.json(result);
  } catch (error) {
    console.error('[Info] Error:', error.message);

    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Request to video info API timed out' });
    }

    if (error.response) {
      return res.status(error.response.status).json({ error: 'External API error' });
    }

    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/download
 * Body: { url, quality }
 */
app.post('/api/download', async (req, res) => {
  const { url, quality } = req.body;

  if (!url || !quality) {
    return res.status(400).json({ error: 'URL and quality are required' });
  }

  // Prepare temporary file paths
  const timestamp = Date.now();
  const videoFile = path.join(TMP_DIR, `video_${timestamp}.tmp`);
  const audioFile = path.join(TMP_DIR, `audio_${timestamp}.tmp`);
  const outputFile = path.join(TMP_DIR, `merged_${timestamp}.mp4`);

  try {
    // Normalize URL
    const normalizedUrl = normalizeYoutubeUrl(url);
    const apiUrl = `${YT_API_URL}${encodeURIComponent(normalizedUrl)}`;
    
    // Real browser headers to bypass Google CDN 403 Forbidden
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
      'Accept-Encoding': 'identity', // Prevents gzip issues with stream
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.youtube.com/',
      'Origin': 'https://www.youtube.com',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'video',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site'
    };

    console.log(`[Download] Fetching API metadata: ${apiUrl}`);
    const response = await axios.get(apiUrl, { headers: browserHeaders, timeout: 15000 });
    const data = response.data;

    const vidssave = data.download_links?.vidssave || [];
    if (!vidssave.length) {
      return res.status(404).json({ error: 'No download links found' });
    }

    // Find video stream matching quality
    const videoStream = vidssave.find(item => item.type === 'video' && item.quality === quality);
    if (!videoStream) {
      return res.status(404).json({ error: `Quality "${quality}" not available` });
    }

    // Find highest available audio stream
    const audioStreams = vidssave.filter(item => item.type === 'audio');
    if (!audioStreams.length) {
      return res.status(404).json({ error: 'No audio streams available' });
    }

    // Sort by bitrate descending
    audioStreams.sort((a, b) => {
      const aBit = bitrateFromQuality(a.quality);
      const bBit = bitrateFromQuality(b.quality);
      return bBit - aBit;
    });
    const bestAudio = audioStreams[0];

    console.log('[Download] Downloading video:', videoStream.quality, videoStream.size);
    console.log('[Download] Downloading audio:', bestAudio.quality, bestAudio.size);

    // Download video and audio simultaneously with full browser headers
    const downloadPromises = [
      axios({
        method: 'get',
        url: videoStream.url,
        responseType: 'stream',
        timeout: 120000, // 2 minutes for large videos
        headers: browserHeaders,
        maxRedirects: 5
      }).then(resp => {
        const writer = fs.createWriteStream(videoFile);
        resp.data.pipe(writer);
        return new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
      }),
      axios({
        method: 'get',
        url: bestAudio.url,
        responseType: 'stream',
        timeout: 120000,
        headers: browserHeaders,
        maxRedirects: 5
      }).then(resp => {
        const writer = fs.createWriteStream(audioFile);
        resp.data.pipe(writer);
        return new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
      }),
    ];

    await Promise.all(downloadPromises);
    console.log('[Download] Both streams downloaded.');

    // Merge using FFmpeg
    await mergeVideoAudio(videoFile, audioFile, outputFile);

    // Stream the merged file to client
    const stat = await fs.stat(outputFile);
    const fileName = `${data.video_info?.title || 'video'}.mp4`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);

    const readStream = fs.createReadStream(outputFile);
    readStream.pipe(res);

    // Cleanup after streaming completes
    readStream.on('end', async () => {
      console.log('[Download] File sent, cleaning up.');
      await cleanupFiles(videoFile, audioFile, outputFile);
    });

    readStream.on('error', async (err) => {
      console.error('[Download] Stream error:', err.message);
      await cleanupFiles(videoFile, audioFile, outputFile);
    });

  } catch (error) {
    console.error('[Download] Error:', error.message);
    if (error.response) {
      console.error('[Download] External API Status:', error.response.status);
      console.error('[Download] External API Data:', error.response.data);
    }
    await cleanupFiles(videoFile, audioFile, outputFile);

    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Request to external API or download timed out. Please try again.' });
    }

    if (error.response) {
      const externalMsg = error.response.data?.message || error.response.statusText || 'Unknown external error';
      return res.status(error.response.status).json({ 
        error: `External API error (${error.response.status}): ${externalMsg}` 
      });
    }

    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 YouTube Downloader running on port ${PORT}`);
});

/* ==================================================
   KEEP ALIVE FEATURES
   ================================================== */

const API_PING_INTERVAL = 5 * 60 * 1000;
if (YT_API_URL) {
  const dummyUrl = encodeURIComponent('https://youtube.com/watch?v=dQw4w9WgXcQ');
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  setInterval(() => {
    axios.get(YT_API_URL + dummyUrl, { headers })
      .then(() => console.log('[KeepAlive] Pinged external API successfully'))
      .catch(() => { /* ignore errors */ });
  }, API_PING_INTERVAL);
  console.log('[KeepAlive] External API ping scheduled every 5 minutes.');
}
