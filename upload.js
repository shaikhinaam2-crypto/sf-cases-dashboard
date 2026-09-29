require('dotenv').config();
const { S3Client, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');

const bucketName = process.env.NEON_S3_BUCKET_NAME || 'sf-cases-dashboard-bucket';

// Initialize S3 Client configured for Neon S3 Storage
const s3Client = new S3Client({
  region: process.env.NEON_S3_REGION || 'ap-southeast-1',
  endpoint: process.env.NEON_S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.NEON_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.NEON_S3_SECRET_ACCESS_KEY
  },
  forcePathStyle: true
});

// Configure Multer to upload directly to S3
const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: bucketName,
    metadata: (req, file, cb) => {
      cb(null, { fieldName: file.fieldname });
    },
    key: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      cb(null, `uploads/${uniqueSuffix}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB limit
});

// Helper: Delete File from S3
async function deleteFromNeonS3(filePath) {
  if (!filePath) return;

  try {
    let key = filePath;

    // Extract key if a full URL was stored
    if (key.startsWith('http://') || key.startsWith('https://')) {
      const urlObj = new URL(key);
      key = urlObj.pathname;
    }

    // Clean key string
    try {
      key = decodeURIComponent(key);
    } catch (e) {}

    if (key.startsWith(`/${bucketName}/`)) {
      key = key.replace(`/${bucketName}/`, '');
    }
    if (key.startsWith('/')) {
      key = key.substring(1);
    }

    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key
    });

    await s3Client.send(command);
    console.log(`Successfully deleted S3 key: ${key}`);
  } catch (err) {
    console.error('Error deleting object from Neon S3:', err);
  }
}

// Helper: Generate Presigned URL with Double-Encoding Cleanup
async function getPresignedUrl(filePath) {
  if (!filePath) return '';

  try {
    let key = filePath;

    // Extract pathname if full HTTP/HTTPS URL
    if (key.startsWith('http://') || key.startsWith('https://')) {
      const urlObj = new URL(key);
      key = urlObj.pathname;
    }

    // Remove bucket prefix if embedded in path
    if (key.startsWith(`/${bucketName}/`)) {
      key = key.replace(`/${bucketName}/`, '');
    }

    // CRITICAL FIX: Decode double-encoded characters (%2520 -> %20 -> space)
    let decodedKey = key;
    try {
      decodedKey = decodeURIComponent(key);
      if (decodedKey.includes('%20')) {
        decodedKey = decodeURIComponent(decodedKey);
      }
    } catch (e) {
      decodedKey = key;
    }

    // Strip leading slash
    if (decodedKey.startsWith('/')) {
      decodedKey = decodedKey.substring(1);
    }

    // Generate authorized presigned GET URL valid for 1 hour
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: decodedKey
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
  getPresignedUrl
};