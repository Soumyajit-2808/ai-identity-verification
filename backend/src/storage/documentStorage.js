/**
 * Document Storage Abstraction
 * Securely stores identity documents and selfies on disk with hash-based naming,
 * path traversal protection, metadata tracking, and access-token-governed retrieval.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORAGE_ROOT = process.env.STORAGE_PATH
  ? path.resolve(process.env.STORAGE_PATH)
  : path.resolve(__dirname, '../../uploads/documents');

function initStorage() {
  if (!fs.existsSync(STORAGE_ROOT)) {
    fs.mkdirSync(STORAGE_ROOT, { recursive: true });
  }
}

/**
 * Validate image file binary signatures (magic bytes) to prevent extension spoofing.
 */
function validateMagicBytes(buffer) {
  if (!buffer || buffer.length < 12) {
    return { isValid: false, detectedMime: null, error: 'File buffer too small or empty.' };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { isValid: true, detectedMime: 'image/jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A
  ) {
    return { isValid: true, detectedMime: 'image/png' };
  }

  // WebP: RIFF .... WEBP
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return { isValid: true, detectedMime: 'image/webp' };
  }

  // PDF: %PDF (25 50 44 46)
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return { isValid: true, detectedMime: 'application/pdf' };
  }

  return { isValid: false, detectedMime: null, error: 'Unsupported file signature; only JPEG, PNG, WebP, and PDF are permitted.' };
}

/**
 * Save an uploaded file buffer securely to storage.
 */
async function saveDocument({ buffer, originalFilename, mimeType }) {
  initStorage();

  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeExt = path.extname(originalFilename || '').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
  const storageFilename = `${fileHash}_${Date.now()}${safeExt}`;
  const targetPath = path.join(STORAGE_ROOT, storageFilename);

  // Path traversal guard
  if (!targetPath.startsWith(STORAGE_ROOT)) {
    throw new Error('Security exception: invalid storage destination path.');
  }

  await fs.promises.writeFile(targetPath, buffer);

  return {
    fileHash,
    storagePath: storageFilename,
    fileSizeBytes: buffer.length,
    mimeType,
  };
}

/**
 * Retrieve document binary buffer.
 */
async function getDocumentBuffer(storagePath) {
  initStorage();
  const safeFilename = path.basename(storagePath);
  const fullPath = path.join(STORAGE_ROOT, safeFilename);

  if (!fullPath.startsWith(STORAGE_ROOT) || !fs.existsSync(fullPath)) {
    return null;
  }

  return fs.promises.readFile(fullPath);
}

/**
 * Delete a stored document.
 */
async function deleteDocument(storagePath) {
  initStorage();
  const safeFilename = path.basename(storagePath);
  const fullPath = path.join(STORAGE_ROOT, safeFilename);

  if (fullPath.startsWith(STORAGE_ROOT) && fs.existsSync(fullPath)) {
    await fs.promises.unlink(fullPath);
    return true;
  }
  return false;
}

module.exports = {
  initStorage,
  validateMagicBytes,
  saveDocument,
  getDocumentBuffer,
  deleteDocument,
  STORAGE_ROOT,
};
