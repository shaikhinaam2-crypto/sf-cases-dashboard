const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');
require('dotenv').config();

const s3Client = new S3Client({
  endpoint: process.env.NEON_S3_ENDPOINT || 'https://storage.c-4.ap-southeast-1.aws.neon.tech',
  region: process.env.NEON_S3_REGION || 'ap-southeast-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.NEON_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.NEON_S3_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = process.env.NEON_S3_BUCKET_NAME || 'sf-cases-dashboard-bucket';

const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    metadata: (req, file, cb) => {
      cb(null, { fieldName: file.fieldname });
    },
    key: (req, file, cb) => {
      const fileName = `uploads/${Date.now()}_${path.basename(file.originalname)}`;
      cb(null, fileName);
    }
  })
});

// Helper: Generate Presigned URL valid for 1 hour
async function getPresignedUrl(filePath) {
  if (!filePath) return '';
  try {
    const key = filePath.includes(`${BUCKET_NAME}/`) ? filePath.split(`${BUCKET_NAME}/`)[1] : filePath;
    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
    return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  } catch (err) {
    console.error('Error generating presigned URL:', err);
    return filePath;
  }
}

async function deleteFromNeonS3(fileKey) {
  if (!fileKey) return;
  try {
    const key = fileKey.includes(`${BUCKET_NAME}/`) ? fileKey.split(`${BUCKET_NAME}/`)[1] : fileKey;
    if (key) {
      await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      console.log(`Deleted file from Neon S3: ${key}`);
    }
  } catch (err) {
    console.error('Error deleting file from Neon S3:', err);
  }
}

module.exports = {
  upload,
  deleteFromNeonS3,
  getPresignedUrl
};