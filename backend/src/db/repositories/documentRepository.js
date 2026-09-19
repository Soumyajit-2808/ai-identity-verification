/**
 * Document Metadata Repository
 * Tracks stored documents, original filenames, hashes, and storage paths.
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const { query } = require('../connection');

async function saveDocumentRecord({
  registrationId,
  documentType,
  fileHash,
  storagePath,
  originalFilename,
  mimeType,
  fileSizeBytes,
}, dbClient = null) {
  const id = uuidv4();
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;
  await runner(
    `INSERT INTO identity_documents (
       id, registration_id, document_type, file_hash, storage_path,
       original_filename, mime_type, file_size_bytes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      registrationId,
      documentType,
      fileHash,
      storagePath,
      originalFilename,
      mimeType,
      fileSizeBytes,
    ]
  );
  return { id, registrationId, documentType, fileHash, storagePath };
}

async function getDocumentsByRegistrationId(registrationId) {
  const res = await query(
    `SELECT id, registration_id, document_type, file_hash, storage_path,
            original_filename, mime_type, file_size_bytes, created_at
     FROM identity_documents
     WHERE registration_id = $1
     ORDER BY created_at ASC`,
    [registrationId]
  );
  return res.rows;
}

module.exports = {
  saveDocumentRecord,
  getDocumentsByRegistrationId,
};
