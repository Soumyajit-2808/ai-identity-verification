/**
 * Identity Deduplication & Reuse Repository
 * Persists SHA-256 hashes of documents and normalized/salted ID numbers.
 * Enforces transaction-level and unique-constraint deduplication across application restarts.
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const { query } = require('../connection');

/**
 * Hash an ID number for privacy-preserving deduplication storage.
 */
function hashIdNumber(idNumber) {
  if (!idNumber) return null;
  const normalized = idNumber.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const salt = process.env.PII_SALT || 'VERIFY_ID_SALT_2026_DEFAULT';
  if (process.env.NODE_ENV === 'production' && salt === 'VERIFY_ID_SALT_2026_DEFAULT') {
    throw new Error('[Fatal Security Error] PII_SALT environment variable must be set to a cryptographically random value in production.');
  }
  return crypto.createHmac('sha256', salt).update(normalized).digest('hex');
}

/**
 * Mask an ID number for secure display in logs/UI (e.g., "XXXX-XXXX-1234").
 */
function maskIdNumber(idNumber) {
  if (!idNumber) return '—';
  const clean = idNumber.trim();
  if (clean.length <= 4) return '****';
  const lastFour = clean.slice(-4);
  return '*'.repeat(clean.length - 4) + lastFour;
}

/**
 * Check if the exact document file has been submitted before for this event.
 */
async function checkDuplicateFile(eventId, fileHash, dbClient = null) {
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;
  const res = await runner(
    `SELECT ir.id, ir.registration_id, ir.registered_name, ir.created_at, r.registration_name
     FROM identity_registry ir
     LEFT JOIN registrations r ON ir.registration_id = r.id
     WHERE ir.event_id = $1 AND ir.document_file_hash = $2
     LIMIT 1`,
    [eventId, fileHash]
  );

  if (res.rows.length > 0) {
    const row = res.rows[0];
    return {
      isDuplicate: true,
      existingRegistrationId: row.registration_id,
      registeredName: row.registered_name || row.registration_name,
      createdAt: row.created_at,
    };
  }

  return { isDuplicate: false };
}

/**
 * Check if the extracted ID number has been registered by a different person in this event.
 */
async function checkIdentityReuse(eventId, rawIdNumber, currentRegistrationName, dbClient = null) {
  if (!rawIdNumber) {
    return {
      canCheck: false,
      reason: 'No valid ID number extracted; cannot check identity reuse.',
    };
  }

  const idHash = hashIdNumber(rawIdNumber);
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;

  const res = await runner(
    `SELECT ir.id, ir.registration_id, ir.registered_name, ir.id_type, ir.created_at
     FROM identity_registry ir
     WHERE ir.event_id = $1 AND ir.id_number_hash = $2
     LIMIT 1`,
    [eventId, idHash]
  );

  if (res.rows.length > 0) {
    const row = res.rows[0];
    const prevName = (row.registered_name || '').toUpperCase().trim();
    const currName = (currentRegistrationName || '').toUpperCase().trim();
    const sameName = prevName === currName;

    return {
      canCheck: true,
      isReused: true,
      isSamePersonResubmission: sameName,
      existingRegistrationId: row.registration_id,
      previousName: row.registered_name,
      idType: row.id_type,
      createdAt: row.created_at,
    };
  }

  return {
    canCheck: true,
    isReused: false,
  };
}

/**
 * Determine if an error is an expected database uniqueness constraint violation.
 */
function isUniqueConstraintViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT') return true;
  if (typeof err.message === 'string' && (
    err.message.includes('UNIQUE constraint failed') ||
    err.message.includes('unique constraint') ||
    err.message.includes('duplicate key value')
  )) {
    return true;
  }
  return false;
}

/**
 * Persist identity to the registry inside an atomic transaction.
 * Concurrency-safe: enforces database uniqueness without destructive overwrites.
 * - First registration creates the registry entry.
 * - Conflicting registrations (same ID different person or duplicate file) are rejected by unique constraints.
 * - Original registry record is NEVER overwritten.
 * - Unexpected database failures propagate to abort the transaction.
 */
async function registerIdentity({
  eventId,
  registrationId,
  rawIdNumber,
  idType,
  registeredName,
  documentFileHash,
}, dbClient = null) {
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;
  const idHash = rawIdNumber ? hashIdNumber(rawIdNumber) : 'UNIDENTIFIED_' + uuidv4();
  const maskedId = maskIdNumber(rawIdNumber);
  const id = uuidv4();

  // If executing within an active transaction, establish a SAVEPOINT.
  // In PostgreSQL, any statement error (such as a unique constraint violation) aborts
  // the transaction block unless rolled back to a SAVEPOINT.
  const savepointName = 'sp_id_reg_' + uuidv4().replace(/-/g, '_');
  const useSavepoint = Boolean(dbClient);

  if (useSavepoint) {
    await runner(`SAVEPOINT ${savepointName}`);
  }

  try {
    const res = await runner(
      `INSERT INTO identity_registry (
         id, event_id, registration_id, id_number_hash, id_number_masked,
         id_type, registered_name, document_file_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        id,
        eventId,
        registrationId,
        idHash,
        maskedId,
        idType || 'UNKNOWN',
        registeredName,
        documentFileHash,
      ]
    );

    if (useSavepoint) {
      await runner(`RELEASE SAVEPOINT ${savepointName}`).catch(() => {});
    }

    const persistedId = (res && res.rows && res.rows[0] && res.rows[0].id) ? res.rows[0].id : id;
    return {
      registered: true,
      conflict: false,
      id: persistedId,
      idNumberHash: idHash,
      idNumberMasked: maskedId,
    };
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      if (useSavepoint) {
        // Rollback to savepoint: restores PostgreSQL transaction state so subsequent queries succeed
        await runner(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await runner(`RELEASE SAVEPOINT ${savepointName}`).catch(() => {});
      }

      // Database unique constraint triggered! Either id_number_hash or document_file_hash exists.
      // Fetch authoritative existing row to determine exact nature of conflict without mutating it.
      const conflictRes = await runner(
        `SELECT ir.id, ir.registration_id, ir.registered_name, ir.id_number_hash,
                ir.document_file_hash, ir.id_type, ir.created_at
         FROM identity_registry ir
         WHERE ir.event_id = $1 AND (ir.id_number_hash = $2 OR ir.document_file_hash = $3)
         ORDER BY ir.created_at ASC, ir.id ASC
         LIMIT 1`,
        [eventId, idHash, documentFileHash]
      );

      const existingRecord = conflictRes.rows && conflictRes.rows[0] ? conflictRes.rows[0] : null;
      const isSameDoc = existingRecord && existingRecord.document_file_hash === documentFileHash;
      const isSameId = existingRecord && existingRecord.id_number_hash === idHash;
      const prevName = (existingRecord?.registered_name || '').toUpperCase().trim();
      const currName = (registeredName || '').toUpperCase().trim();
      const isSamePerson = prevName === currName;

      return {
        registered: false,
        conflict: true,
        conflictType: isSameDoc ? 'DUPLICATE_FILE' : 'IDENTITY_REUSE',
        isSamePersonResubmission: isSameId && isSamePerson && !isSameDoc,
        idNumberHash: idHash,
        idNumberMasked: maskedId,
        existingRecord,
      };
    }

    // If unexpected error, rollback to savepoint if active, then propagate
    if (useSavepoint) {
      try {
        await runner(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await runner(`RELEASE SAVEPOINT ${savepointName}`);
      } catch (_) {}
    }

    // Unexpected database failure MUST propagate to abort transaction
    throw err;
  }
}

module.exports = {
  hashIdNumber,
  maskIdNumber,
  checkDuplicateFile,
  checkIdentityReuse,
  registerIdentity,
  isUniqueConstraintViolation,
};

