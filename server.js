const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { mergeVideoAudio } = require('./ffmpeg');

const app = express();
const PORT = process.env.PORT || 10000;
const YT_API_URL = 'https://rohit-youtube-download-info-api.onrender.com/yt_all_in_one?url=';

const TMP_DIR = path.join(os.tmpdir(), 'yt-downloader');
fs.ensureDirSync(TMP_DIR);
console.log(`[Init] Temp directory created at: ${TMP_DIR}`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function bitrateFromQuality(quality) {
  if (!quality) return 0;
  const match = quality.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

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

app.get('/keep-alive', (req, res) => {
  console.log('[KeepAlive] Ping received from frontend.');
  res.status(200).send('OK');
});

app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  console.log(`[Info] Received URL: ${url}`);

  if (!url) {
    console.error('[Info] Error: URL is empty.');
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const normalizedUrl = normalizeYoutubeUrl(url);
    const apiUrl = `${YT_API_URL}${encodeURIComponent(normalizedUrl)}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };

    console.log(`[Info] Fetching metadata from: ${apiUrl}`);
    const response = await axios.get(apiUrl, { headers, timeout: 15000 });
    const data = response.data;
    const videoInfo = data.video_info || {};

    if (!videoInfo.title) {
      console.error('[Info] Error: Video not found or unavailable.');
      return res.status(404).json({ error: 'Video not found or unavailable' });
    }

    const title = videoInfo.title;
    const thumbnail = videoInfo.thumbnail;
    const duration = formatDuration(videoInfo.duration_seconds);
    const channelName = data.channel_info?.title || 'Unknown Channel';
    const stats = data.statistics || {};
    const views = stats.viewCount || 0;
    const likes = stats.likeCount || 0;

    const vidssave = data.download_links?.vidssave || [];
    const videoStreams = vidssave.filter(item => item.type === 'video');
    const qualities = videoStreams
      .map(item => item.quality)
      .filter((q, index, self) => self.indexOf(q) === index)
      .sort((a, b) => parseInt(a) - parseInt(b));

    console.log(`[Info] Success. Found qualities: ${qualities.join(', ')}`);

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

app.post('/api/download', async (req, res) => {
  const { url, quality } = req.body;
  console.log(`[Download] Request received. Quality: ${quality}, URL: ${url}`);

  if (!url || !quality) {
    console.error('[Download] Error: Missing URL or Quality.');
    return res.status(400).json({ error: 'URL and quality are required' });
  }

  const timestamp = Date.now();
  const videoFile = path.join(TMP_DIR, `video_${timestamp}.tmp`);
  const audioFile = path.join(TMP_DIR, `audio_${timestamp}.tmp`);
  const outputFile = path.join(TMP_DIR, `merged_${timestamp}.mp4`);

  try {
    const normalizedUrl = normalizeYoutubeUrl(url);
    const apiUrl = `${YT_API_URL}${encodeURIComponent(normalizedUrl)}`;

    console.log(`[Download] Fetching download links from: ${apiUrl}`);
    
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
      'Accept-Encoding': 'identity',
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

    if (!vidssave || vidssave.length === 0) {
      console.error('[Download] Error: No download links found in API response.');
      return res.status(404).json({ error: 'No download links found for this video.' });
    }

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

    audioStreams.sort((a, b) => bitrateFromQuality(b.quality) - bitrateFromQuality(a.quality));
    const bestAudio = audioStreams[0];

    console.log(`[Download] Selected Video: ${videoStream.quality} (${videoStream.size} bytes)`);
    console.log(`[Download] Selected Audio: ${bestAudio.quality} (${bestAudio.size} bytes)`);

    console.log('[Download] Starting parallel downloads...');
    const downloadPromises = [
      axios({
        method: 'get',
        url: videoStream.url,
        responseType: 'stream',
        timeout: 120000,
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

    await Promise.all(downloadPromises);
    console.log('[Download] Both streams downloaded successfully.');

    console.log('[FFmpeg] Starting merge process...');
    await mergeVideoAudio(videoFile, audioFile, outputFile);
    console.log('[FFmpeg] Merge completed successfully.');

    const stat = await fs.stat(outputFile);
    const fileName = `${data.video_info?.title || 'video'}.mp4`;
    console.log(`[Download] Streaming file: ${fileName} (${stat.size} bytes)`);
    
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);

    const readStream = fs.createReadStream(outputFile);
    readStream.pipe(res);

    readStream.on('end', async () => {
      console.log('[Download] File sent successfully. Cleaning up temporary files...');
      await cleanupFiles(videoFile, audioFile, outputFile);
    });

    readStream.on('error', async (err) => {
      console.error('[Download] Stream error while sending file:', err.message);
      await cleanupFiles(videoFile, audioFile, outputFile);
    });

  } catch (error) {
    console.error('[Download] Critical Error:', error.message);
    await cleanupFiles(videoFile, audioFile, outputFile);

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

    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Internal server error during download.' });
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 YouTube Downloader running on port ${PORT}`);
});

const API_PING_INTERVAL = 5 * 60 * 1000;
if (YT_API_URL) {
  const dummyUrl = encodeURIComponent('https://youtube.com/watch?v=dQw4w9WgXcQ');
  const pingHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  setInterval(() => {
    axios.get(YT_API_URL + dummyUrl, { headers: pingHeaders })
      .then(() => {
        console.log('[KeepAlive] Successfully pinged external API.');
      })
      .catch(() => { });
  }, API_PING_INTERVAL);

  console.log('[KeepAlive] External API ping scheduled every 5 minutes.');
}
