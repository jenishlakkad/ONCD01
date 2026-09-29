const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

// Removes any audio track from a local video file before it's ever uploaded
// (see server/routes/adminProductsPostgres.js's create/replace media
// endpoints) — product preview videos never need sound, and every byte of
// audio is pure wasted storage. Uses a fast ffmpeg STREAM COPY of the video
// track (`-c:v copy -an`): the video is never decoded or re-encoded, only
// re-muxed into a new container with the audio track dropped, so this is a
// near-instant operation regardless of file size or length — nothing like
// a real transcode, and safe to run on every single upload unconditionally.
// A video that already has no audio track passes through unchanged (-an is
// simply a no-op there); ffmpeg does not error on a missing audio stream.
//
// Returns the path to a NEW temporary file with audio removed. Never
// modifies or deletes the input — that's the caller's responsibility, once
// it has successfully switched over to using the returned path instead.
function stripVideoAudio(inputPath) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(inputPath) || '.mp4';
    const base = path.basename(inputPath, ext);
    const outputPath = path.join(path.dirname(inputPath), `${base}-noaudio-${crypto.randomBytes(4).toString('hex')}${ext}`);
    execFile(
      ffmpegPath,
      ['-y', '-i', inputPath, '-map', '0:v:0', '-c:v', 'copy', '-an', outputPath],
      { timeout: 60_000 },
      (err) => {
        if (err) {
          fs.unlink(outputPath, () => {});
          reject(new Error(`Failed to strip audio from video: ${err.message}`));
          return;
        }
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
          fs.unlink(outputPath, () => {});
          reject(new Error('Audio-strip produced no output file.'));
          return;
        }
        resolve(outputPath);
      }
    );
  });
}

module.exports = { stripVideoAudio };
