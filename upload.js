require('dotenv').config();
const { S3Client, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');

const BUCKET_NAME = process.env.NEON_S3_BUCKET_NAME || 'sf-cases-dashboard-bucket';

// Initialize Neon S3 Client with forcePathStyle: true
const s3Client = new S3Client({
  endpoint: process.env.NEON_S3_ENDPOINT,
  region: process.env.NEON_S3_REGION || 'ap-southeast-1',
  credentials: {
    accessKeyId: process.env.NEON_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.NEON_S3_SECRET_ACCESS_KEY
  },
  forcePathStyle: true // CRITICAL: Fixes ERR_CERT_COMMON_NAME_INVALID & NoSuchBucket errors
});

// Exact MIME Content-Type mapping helper
function getContentType(filename, defaultMime) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return defaultMime || 'application/octet-stream';
}

// Multer S3 Storage Configuration
const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    contentType: function (req, file, cb) {
      const resolvedType = getContentType(file.originalname, file.mimetype);
      cb(null, resolvedType);
    },
    key: function (req, file, cb) {
      const cleanFileName = file.originalname.replace(/\s+/g, '_');
      const uniqueKey = `uploads/${Date.now()}_${cleanFileName}`;
      cb(null, uniqueKey);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

// Delete Object from S3
async function deleteFromNeonS3(filePath) {
  if (!filePath) return;
  try {
    let key = filePath;
    if (key.startsWith('http://') || key.startsWith('https://')) {
      const urlObj = new URL(key);
      key = urlObj.pathname;
    }
    
    if (key.includes(`/${BUCKET_NAME}/`)) {
      key = key.substring(key.indexOf(`/${BUCKET_NAME}/`) + BUCKET_NAME.length + 2);
    } else if (key.startsWith('/')) {
      key = key.substring(1);
    }

    try { key = decodeURIComponent(key); } catch (e) {}

    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });
    await s3Client.send(command);
  } catch (err) {
    console.error('Error deleting file from S3:', err);
  }
}

// Presigned URL Generator
async function getPresignedUrl(filePath) {
  if (!filePath) return '';

  try {
    let key = filePath;

    if (key.startsWith('http://') || key.startsWith('https://')) {
      const urlObj = new URL(key);
      key = urlObj.pathname;
    }

    if (key.includes(`/${BUCKET_NAME}/`)) {
      key = key.substring(key.indexOf(`/${BUCKET_NAME}/`) + BUCKET_NAME.length + 2);
    } else if (key.startsWith('/')) {
      key = key.substring(1);
    }

    try {
      key = decodeURIComponent(key);
    } catch (e) {}

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });

    return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  } catch (err) {
    console.error('Error generating presigned URL:', err);
    return filePath;
  }
}

module.exports = {
  upload,
  deleteFromNeonS3,
  getPresignedUrl,
  s3Client
};