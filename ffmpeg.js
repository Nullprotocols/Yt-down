/**
 * FFmpeg merge utility
 * Uses ffmpeg-static to locate the binary
 */

const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs-extra');
const path = require('path');

/**
 * Merge video and audio streams into a single MP4 file.
 * Tries stream copy first; if that fails, falls back to re-encoding.
 *
 * @param {string} videoPath - Path to video file
 * @param {string} audioPath - Path to audio file
 * @param {string} outputPath - Path for the merged output
 * @returns {Promise<string>} - Resolves with outputPath on success
 */
function mergeVideoAudio(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Ensure input files exist
    if (!fs.existsSync(videoPath) || !fs.existsSync(audioPath)) {
      return reject(new Error('Input files for merging do not exist.'));
    }

    // First attempt: stream copy (fast, no re-encode)
    const args = [
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-shortest',           // Trim to the shortest stream duration
      '-y',                  // Overwrite output
      outputPath
    ];

    console.log(`[FFmpeg] Attempting stream copy: ffmpeg ${args.join(' ')}`);
    const ffmpeg = spawn(ffmpegPath, args);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        console.log('[FFmpeg] Stream copy succeeded.');
        return resolve(outputPath);
      }

      // Stream copy failed – fallback to re-encoding
      console.warn('[FFmpeg] Stream copy failed. Falling back to re-encoding.');
      console.warn('[FFmpeg] stderr: ' + stderr);

      const fallbackArgs = [
        '-i', videoPath,
        '-i', audioPath,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-shortest',
        '-y',
        outputPath
      ];

      console.log(`[FFmpeg] Fallback re-encode: ffmpeg ${fallbackArgs.join(' ')}`);
      const ffmpegFallback = spawn(ffmpegPath, fallbackArgs);

      let fallbackStderr = '';
      ffmpegFallback.stderr.on('data', (data) => {
        fallbackStderr += data.toString();
      });

      ffmpegFallback.on('close', (fallbackCode) => {
        if (fallbackCode === 0 && fs.existsSync(outputPath)) {
          console.log('[FFmpeg] Re-encoding succeeded.');
          return resolve(outputPath);
        }
        const errorMsg = `FFmpeg merge failed (exit ${fallbackCode}). Details: ${fallbackStderr}`;
        console.error('[FFmpeg] ' + errorMsg);
        reject(new Error(errorMsg));
      });

      ffmpegFallback.on('error', (err) => {
        reject(new Error(`FFmpeg fallback spawn error: ${err.message}`));
      });
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg spawn error: ${err.message}`));
    });
  });
}

module.exports = { mergeVideoAudio };
