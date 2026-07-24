/**
 * YouTube Downloader Backend - Complete Production Version
 * Provides /api/info and /api/download endpoints with full error handling
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { mergeVideoAudio } = require('./ffmpeg');

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 10000;
const YT_API_URL = process.env.YT_API_URL;

// Create temporary directory using system temp folder (Render.com safe)
const TMP_DIR = path.join(os.tmpdir(), 'yt-downloader');
fs.ensureDirSync(TMP_DIR);
console.log(`[Init] Temp directory created at: ${TMP_DIR}`);

// ------------------------------------------------------------------
// Middleware Setup
// ------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------------
// Utility Helper Functions
// ------------------------------------------------------------------

/**
 * Converts YouTube Shorts URL to standard watch URL to prevent API errors.
 */
function normalizeYoutubeUrl(url) {
  if (!url) return url;
  if (url.includes('/shorts/')) {
    const videoId = url.split('/shorts/')[1].split(/[?#]/)[0];
    const normalized = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[Normalize] Converted Shorts URL: ${normalized}`);
    return normalized;
  }
  return url;
}

/**
 * Formats duration seconds into MM:SS format.
 */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Extracts numeric bitrate from quality string (e.g., "256KBPS" -> 256).
 */
function bitrateFromQuality(quality) {
  if (!quality) return 0;
  const match = quality.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Safely deletes multiple files. Used for automatic cleanup.
 */
async function cleanupFiles(...paths) {
  for (const filePath of paths) {
    try {
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        console.log(`[Cleanup] Successfully deleted: ${filePath}`);
      }
    } catch (err) {
      console.warn(`[Cleanup] Failed to delete ${filePath}: ${err.message}`);
    }
  }
}

// ------------------------------------------------------------------
// 1. Keep-Alive Endpoint (Prevent Render Sleep)
// ------------------------------------------------------------------
app.get('/keep-alive', (req, res) => {
  console.log('[KeepAlive] Ping received from frontend.');
  res.status(200).send('OK');
});

// ------------------------------------------------------------------
// 2. API: Fetch Video Information (/api/info)
// ------------------------------------------------------------------
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  console.log(`[Info] Received URL: ${url}`);

  // Validation 1: URL exists
  if (!url) {
    console.error('[Info] Error: URL is empty.');
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    // Normalize URL (fix shorts)
    const normalizedUrl = normalizeYoutubeUrl(url);
    const apiUrl = `${YT_API_URL}${encodeURIComponent(normalizedUrl)}`;
    
    // Headers for the API request (to prevent bot blocking)
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    console.log(`[Info] Fetching metadata from: ${apiUrl}`);
    const response = await axios.get(apiUrl, { headers, timeout: 15000 });
    const data = response.data;

    // Validation 2: Check if video exists
    const videoInfo = data.video_info || {};
    if (!videoInfo.title) {
      console.error('[Info] Error: Video not found or unavailable.');
      return res.status(404).json({ error: 'Video not found or unavailable' });
    }

    // Extract metadata
    const title = videoInfo.title;
    const thumbnail = videoInfo.thumbnail;
    const duration = formatDuration(videoInfo.duration_seconds);
    const channelName = data.channel_info?.title || 'Unknown Channel';
    const stats = data.statistics || {};
    const views = stats.viewCount || 0;
    const likes = stats.likeCount || 0;

    // Extract available video qualities
    const vidssave = data.download_links?.vidssave || [];
    const videoStreams = vidssave.filter(item => item.type === 'video');
    const qualities = videoStreams
      .map(item => item.quality)
      .filter((q, index, self) => self.indexOf(q) === index)
      .sort((a, b) => parseInt(a) - parseInt(b));

    console.log(`[Info] Success. Found qualities: ${qualities.join(', ')}`);

    // Send response to frontend
    res.json({
      title,
      thumbnail,
      duration,
      channelName,
      views,
      likes,
      qualities
    });

  } catch (error) {
    console.error('[Info] Exception caught:', error.message);

    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Request to external API timed out. Please try again.' });
    }
    if (error.response) {
      console.error(`[Info] External API responded with ${error.response.status}`);
      return res.status(error.response.status).json({ error: `External API error (${error.response.status})` });
    }

    res.status(500).json({ error: 'Internal server error while fetching info.' });
  }
});

// ------------------------------------------------------------------
// 3. API: Download and Merge Video (/api/download)
// ------------------------------------------------------------------
app.post('/api/download', async (req, res) => {
  const { url, quality } = req.body;
  console.log(`[Download] Request received. Quality: ${quality}, URL: ${url}`);

  // Validation 1: Check inputs
  if (!url || !quality) {
    console.error('[Download] Error: Missing URL or Quality.');
    return res.status(400).json({ error: 'URL and quality are required' });
  }

  // Setup temporary file paths
  const timestamp = Date.now();
  const videoFile = path.join(TMP_DIR, `video_${timestamp}.tmp`);
  const audioFile = path.join(TMP_DIR, `audio_${timestamp}.tmp`);
  const outputFile = path.join(TMP_DIR, `merged_${timestamp}.mp4`);

  try {
    // Normalize URL
    const normalizedUrl = normalizeYoutubeUrl(url);
    const apiUrl = `${YT_API_URL}${encodeURIComponent(normalizedUrl)}`;

    // ==========================================================
    // Step 1: Fetch download links from external API
    // ==========================================================
    console.log(`[Download] Fetching download links from: ${apiUrl}`);
    
    // Browser-like headers to bypass Google CDN 403 Forbidden error
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
      'Accept-Encoding': 'identity', // Critical: prevents gzip compression issues with stream download
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.youtube.com/',
      'Origin': 'https://www.youtube.com',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'video',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'cross-site'
    };

    const response = await axios.get(apiUrl, { headers: browserHeaders, timeout: 15000 });
    const data = response.data;
    const vidssave = data.download_links?.vidssave || [];

    // Validation 2: Check if links exist
    if (!vidssave || vidssave.length === 0) {
      console.error('[Download] Error: No download links found in API response.');
      return res.status(404).json({ error: 'No download links found for this video.' });
    }

    // ==========================================================
    // Step 2: Find exact Video and Audio streams
    // ==========================================================
    const videoStream = vidssave.find(item => item.type === 'video' && item.quality === quality);
    if (!videoStream) {
      console.error(`[Download] Error: Quality "${quality}" not available.`);
      return res.status(404).json({ error: `Quality "${quality}" is not available for this video.` });
    }

    const audioStreams = vidssave.filter(item => item.type === 'audio');
    if (!audioStreams || audioStreams.length === 0) {
      console.error('[Download] Error: No audio streams available.');
      return res.status(404).json({ error: 'No audio streams available for this video.' });
    }

    // Sort audio streams by bitrate (256kbps > 128kbps > 48kbps)
    audioStreams.sort((a, b) => bitrateFromQuality(b.quality) - bitrateFromQuality(a.quality));
    const bestAudio = audioStreams[0];

    console.log(`[Download] Selected Video: ${videoStream.quality} (${videoStream.size} bytes)`);
    console.log(`[Download] Selected Audio: ${bestAudio.quality} (${bestAudio.size} bytes)`);

    // ==========================================================
    // Step 3: Download Video and Audio Simultaneously
    // ==========================================================
    console.log('[Download] Starting parallel downloads...');
    const downloadPromises = [
      axios({
        method: 'get',
        url: videoStream.url,
        responseType: 'stream',
        timeout: 120000, // 2 minutes timeout for large files (like 1080p)
        headers: browserHeaders,
        maxRedirects: 5
      }).then(resp => {
        const writer = fs.createWriteStream(videoFile);
        resp.data.pipe(writer);
        return new Promise((resolve, reject) => {
          writer.on('finish', () => {
            console.log('[Download] Video download finished.');
            resolve();
          });
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
          writer.on('finish', () => {
            console.log('[Download] Audio download finished.');
            resolve();
          });
          writer.on('error', reject);
        });
      })
    ];

    // Wait for both downloads to finish
    await Promise.all(downloadPromises);
    console.log('[Download] Both streams downloaded successfully.');

    // ==========================================================
    // Step 4: Merge using FFmpeg (from ffmpeg.js)
    // ==========================================================
    console.log('[FFmpeg] Starting merge process...');
    await mergeVideoAudio(videoFile, audioFile, outputFile);
    console.log('[FFmpeg] Merge completed successfully.');

    // ==========================================================
    // Step 5: Send Merged File to Client
    // ==========================================================
    const stat = await fs.stat(outputFile);
    const fileName = `${data.video_info?.title || 'video'}.mp4`;
    
    console.log(`[Download] Streaming file: ${fileName} (${stat.size} bytes)`);
    
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);

    const readStream = fs.createReadStream(outputFile);
    readStream.pipe(res);

    // Cleanup after the file is fully sent to the client
    readStream.on('end', async () => {
      console.log('[Download] File sent successfully. Cleaning up temporary files...');
      await cleanupFiles(videoFile, audioFile, outputFile);
    });

    readStream.on('error', async (err) => {
      console.error('[Download] Stream error while sending file:', err.message);
      // Attempt cleanup even if streaming fails
      await cleanupFiles(videoFile, audioFile, outputFile);
    });

  } catch (error) {
    console.error('[Download] Critical Error:', error.message);
    
    // Always clean up on failure
    await cleanupFiles(videoFile, audioFile, outputFile);

    // Detailed error handling for external API
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Request to external API or download timed out. Please try again.' });
    }

    if (error.response) {
      console.error(`[Download] External API error details: ${error.response.status}`);
      const externalMsg = error.response.data?.message || error.response.statusText || 'Unknown external error';
      return res.status(error.response.status).json({
        error: `External API error (${error.response.status}): ${externalMsg}`
      });
    }

    // If headers haven't been sent yet, return a 500 error
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Internal server error during download.' });
    }
  }
});

// ------------------------------------------------------------------
// 4. Start Server
// ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 YouTube Downloader is running on port ${PORT}`);
});

// ------------------------------------------------------------------
// 5. Background Keep-Alive for External API
// ------------------------------------------------------------------
const API_PING_INTERVAL = 5 * 60 * 1000; // 5 Minutes
if (YT_API_URL) {
  // Using a known dummy video (Rick Astley) to keep the external API awake
  const dummyUrl = encodeURIComponent('https://youtube.com/watch?v=dQw4w9WgXcQ');
  const pingHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  setInterval(() => {
    axios.get(YT_API_URL + dummyUrl, { headers: pingHeaders })
      .then(() => {
        console.log('[KeepAlive] Successfully pinged external API.');
      })
      .catch((err) => {
        // Ignore errors, we just want to keep the connection alive
        // console.warn('[KeepAlive] Ping failed (ignored):', err.message);
      });
  }, API_PING_INTERVAL);

  console.log('[KeepAlive] External API ping scheduled every 5 minutes.');
}
