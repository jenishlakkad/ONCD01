const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const env = require('../config/env');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

function destFor(subdir) {
  const dir = path.join(env.uploadsDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function storageFor(subdir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, destFor(subdir)),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  });
}

function fileFilter(req, file, cb) {
  if ([...IMAGE_TYPES, ...VIDEO_TYPES].includes(file.mimetype)) return cb(null, true);
  cb(new Error(`Unsupported file type: ${file.mimetype}`));
}

function kindOf(mimetype) {
  return VIDEO_TYPES.includes(mimetype) ? 'video' : 'image';
}

function makeUploader(subdir) {
  return multer({
    storage: storageFor(subdir),
    fileFilter,
    limits: { fileSize: 50 * 1024 * 1024 },
  });
}

module.exports = { makeUploader, kindOf, IMAGE_TYPES, VIDEO_TYPES };
