/**
 * Database & Persistence Test Suite
 * Tests relational integrity, duplicate detection, identity reuse tracking,
 * transactions, and review workflows across persistent storage.
 */

process.env.DATABASE_URL = 'sqlite::memory:';

const { initDb, closeDb, transaction } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { getEventByCode } = require('../src/db/repositories/eventRepository');
const { createRegistration, updateRegistrationStatus } = require('../src/db/repositories/registrationRepository');
const {
  checkDuplicateFile,
  checkIdentityReuse,
  registerIdentity,
  hashIdNumber,
  maskIdNumber,
} = require('../src/db/repositories/identityRegistryRepository');
const {
  createVerificationRequest,
  saveVerificationResult,
  saveVerificationSignals,
  getVerificationHistory,
  getVerificationDetails,
} = require('../src/db/repositories/verificationRepository');
const {
  createReviewCase,
  listReviewCases,
  updateReviewCase,
} = require('../src/db/repositories/reviewCaseRepository');
const { logEvent, listAuditLogs } = require('../src/db/repositories/auditLogRepository');

describe('Database & Persistence Layer', () => {
  let testEvent;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'sqlite::memory:';
    await runMigrations();
    testEvent = await getEventByCode('HACK2026');
    expect(testEvent).toBeDefined();
    expect(testEvent.code).toBe('HACK2026');
  });

  afterAll(async () => {
    await closeDb();
  });

  test('1. Creates a registration and persists correctly', async () => {
    const reg = await createRegistration({
      eventId: testEvent.id,
      registrationName: 'Aarav Patel',
      email: 'aarav@example.com',
      phone: '+919876543210',
    });

    expect(reg.id).toBeDefined();
    expect(reg.registrationName).toBe('Aarav Patel');
    expect(reg.status).toBe('PENDING');
  });

  test('2. Enforces persistent duplicate file detection', async () => {
    const fileHash = 'sha256_mock_file_hash_111111111';
    const reg1 = await createRegistration({
      eventId: testEvent.id,
      registrationName: 'Priya Sharma',
    });

    // Before registration, duplicate check should be false
    const initialCheck = await checkDuplicateFile(testEvent.id, fileHash);
    expect(initialCheck.isDuplicate).toBe(false);

    // Register identity
    await registerIdentity({
      eventId: testEvent.id,
      registrationId: reg1.id,
      rawIdNumber: 'ABC1234567',
      idType: 'STUDENT_ID',
      registeredName: 'Priya Sharma',
      documentFileHash: fileHash,
    });

    // Subsequent check for same file hash must be true
    const secondCheck = await checkDuplicateFile(testEvent.id, fileHash);
    expect(secondCheck.isDuplicate).toBe(true);
    expect(secondCheck.existingRegistrationId).toBe(reg1.id);
  });

  test('3. Enforces persistent identity reuse detection with conflicting name', async () => {
    const idNumber = 'PAN9876543';
    const reg1 = await createRegistration({
      eventId: testEvent.id,
      registrationName: 'Vikram Malhotra',
    });

    // Register first submission
    await registerIdentity({
      eventId: testEvent.id,
      registrationId: reg1.id,
      rawIdNumber: idNumber,
      idType: 'PAN',
      registeredName: 'Vikram Malhotra',
      documentFileHash: 'hash_file_aaa',
    });

    // Second registration with different name but SAME ID number
    const reuseCheck = await checkIdentityReuse(testEvent.id, idNumber, 'Rohan Mehta');
    expect(reuseCheck.canCheck).toBe(true);
    expect(reuseCheck.isReused).toBe(true);
    expect(reuseCheck.isSamePersonResubmission).toBe(false);
    expect(reuseCheck.previousName).toBe('Vikram Malhotra');

    // Same person resubmitting
    const resubmitCheck = await checkIdentityReuse(testEvent.id, idNumber, 'Vikram Malhotra');
    expect(resubmitCheck.isReused).toBe(true);
    expect(resubmitCheck.isSamePersonResubmission).toBe(true);
  });

  test('4. Atomic verification records and signal persistence', async () => {
    const reg = await createRegistration({
      eventId: testEvent.id,
      registrationName: 'Sneha Rao',
    });

    const verifReq = await createVerificationRequest({
      registrationId: reg.id,
      eventId: testEvent.id,
      requestIp: '127.0.0.1',
      userAgent: 'Jest/TestRunner',
    });

    expect(verifReq.status).toBe('PROCESSING');

    const result = await saveVerificationResult({
      requestId: verifReq.id,
      registrationId: reg.id,
      decision: 'REVIEW',
      confidenceScore: 0.72,
      riskScore: 0.35,
      evidenceScore: 0.80,
      summaryReason: 'Manual review required: slight blur and name discrepancy.',
      extractedIdentity: {
        name: 'Sneha R.',
        date_of_birth: '12/04/2002',
        id_number: 'AADHAAR-8888',
      },
    });

    await saveVerificationSignals(result.id, [
      {
        signalType: 'QUALITY',
        status: 'REVIEW',
        score: 55.0,
        reason: 'Image blur detected below threshold',
        details: { blur_score: 55.0 },
      },
      {
        signalType: 'NAME_MATCH',
        status: 'REVIEW',
        score: 0.65,
        reason: 'Initial vs Full Name match',
        details: { ocr_name: 'Sneha R.', reg_name: 'Sneha Rao' },
      },
    ]);

    const details = await getVerificationDetails(verifReq.id);
    expect(details.decision).toBe('REVIEW');
    expect(details.signals.length).toBe(2);
    expect(details.extracted_identity.name).toBe('Sneha R.');
  });

  test('5. Review case lifecycle & audit logging', async () => {
    const reg = await createRegistration({
      eventId: testEvent.id,
      registrationName: 'Karan Johar',
    });

    const verifReq = await createVerificationRequest({
      registrationId: reg.id,
      eventId: testEvent.id,
    });

    const result = await saveVerificationResult({
      requestId: verifReq.id,
      registrationId: reg.id,
      decision: 'REVIEW',
      confidenceScore: 0.60,
      summaryReason: 'Face mismatch flagged.',
      extractedIdentity: { name: 'Karan' },
    });

    // Create review case
    const reviewCase = await createReviewCase({
      resultId: result.id,
      registrationId: reg.id,
      eventId: testEvent.id,
      priority: 'HIGH',
      reviewerNotes: 'Biometric face verification score was low.',
    });

    expect(reviewCase.status).toBe('OPEN');

    // Operator updates review case to APPROVED
    const updated = await updateReviewCase(reviewCase.id, {
      status: 'APPROVED',
      reviewerNotes: 'Verified ID photo manually under good lighting; confirmed identity.',
      resolutionReason: 'Manual human operator override.',
    });

    expect(updated.status).toBe('APPROVED');
    expect(updated.resolved_at).toBeDefined();

    // Log audit event
    await logEvent({
      actorId: 'admin-123',
      actorRole: 'reviewer',
      action: 'REVIEW_CASE_RESOLVED',
      entityType: 'REVIEW_CASE',
      entityId: reviewCase.id,
      eventId: testEvent.id,
      details: { oldStatus: 'OPEN', newStatus: 'APPROVED' },
    });

    const logs = await listAuditLogs({ entityType: 'REVIEW_CASE', entityId: reviewCase.id });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe('REVIEW_CASE_RESOLVED');
  });

  test('6. Migration idempotency and unique constraints verification', async () => {
    // Verify runMigrations is idempotent when executed again
    await expect(runMigrations()).resolves.not.toThrow();

    // Verify unique indexes exist on identity_registry
    const { query, getDbType } = require('../src/db/connection');
    if (getDbType() === 'sqlite') {
      const indexesRes = await query(`PRAGMA index_list('identity_registry')`);
      const uniqueIndexNames = indexesRes.rows.filter(r => r.unique).map(r => r.name);
      expect(uniqueIndexNames.some(name => name.includes('idx_uq_event_id_number'))).toBe(true);
      expect(uniqueIndexNames.some(name => name.includes('idx_uq_event_file_hash'))).toBe(true);
    }
  });

  test('7. Privacy Invariant: Raw ID numbers are never stored in verification_results or exposed via history/details/review APIs', async () => {
    const rawGovId = 'AADHAAR-SECRET-9876543210';
    const reg = await createRegistration({
      eventId: testEvent.id,
      registrationName: 'Privacy Sensitive User',
    });

    const vReq = await createVerificationRequest({
      registrationId: reg.id,
      eventId: testEvent.id,
    });

    const vRes = await saveVerificationResult({
      requestId: vReq.id,
      registrationId: reg.id,
      decision: 'REVIEW',
      confidenceScore: 0.85,
      riskScore: 0.15,
      summaryReason: 'Privacy check test.',
      extractedIdentity: {
        name: 'Privacy Sensitive User',
        date_of_birth: '1990-01-01',
        id_number: rawGovId, // Raw ID passed to saveVerificationResult
        id_type: 'AADHAAR',
      },
    });

    const rCase = await createReviewCase({
      resultId: vRes.id,
      registrationId: reg.id,
      eventId: testEvent.id,
      priority: 'MEDIUM',
    });

    // 1. Raw DB row verification
    const { query } = require('../src/db/connection');
    const rawDbRow = await query(`SELECT extracted_identity_json FROM verification_results WHERE id = $1`, [vRes.id]);
    expect(rawDbRow.rows.length).toBe(1);
    const dbJson = rawDbRow.rows[0].extracted_identity_json;
    expect(dbJson).not.toContain(rawGovId);
    expect(JSON.parse(dbJson).id_number).toBeUndefined();
    expect(JSON.parse(dbJson).id_number_masked).toBeDefined();
    expect(JSON.parse(dbJson).id_number_masked).not.toBe(rawGovId);

    // 2. getVerificationHistory response
    const history = await getVerificationHistory({ eventId: testEvent.id });
    const historyItem = history.find(h => h.result_id === vRes.id);
    expect(historyItem).toBeDefined();
    expect(historyItem.extracted_identity_json).toBeUndefined(); // column stripped
    expect(historyItem.extracted_identity.id_number).toBeUndefined();
    expect(historyItem.extracted_identity.id_number_masked).toBeDefined();
    expect(JSON.stringify(historyItem)).not.toContain(rawGovId);

    // 3. getVerificationDetails response
    const details = await getVerificationDetails(vReq.id);
    expect(details).toBeDefined();
    expect(details.extracted_identity_json).toBeUndefined(); // column stripped
    expect(details.extracted_identity.id_number).toBeUndefined();
    expect(details.extracted_identity.id_number_masked).toBeDefined();
    expect(JSON.stringify(details)).not.toContain(rawGovId);

    // 4. getReviewCaseById response
    const { getReviewCaseById } = require('../src/db/repositories/reviewCaseRepository');
    const reviewCaseData = await getReviewCaseById(rCase.id);
    expect(reviewCaseData).toBeDefined();
    expect(reviewCaseData.extracted_identity_json).toBeUndefined(); // column stripped
    expect(reviewCaseData.extracted_identity.id_number).toBeUndefined();
    expect(reviewCaseData.extracted_identity.id_number_masked).toBeDefined();
    expect(JSON.stringify(reviewCaseData)).not.toContain(rawGovId);
  });

  test('8. Review Case Atomic Update: Optimistic locking and transactional registration synchronization', async () => {
    const reg = await createRegistration({
      eventId: testEvent.id,
      registrationName: 'Atomic Test User',
    });
    const vReq = await createVerificationRequest({
      registrationId: reg.id,
      eventId: testEvent.id,
    });
    const vRes = await saveVerificationResult({
      requestId: vReq.id,
      registrationId: reg.id,
      decision: 'REVIEW',
      confidenceScore: 0.70,
      summaryReason: 'Need manual review.',
      extractedIdentity: { name: 'Atomic Test User' },
    });
    const rCase = await createReviewCase({
      resultId: vRes.id,
      registrationId: reg.id,
      eventId: testEvent.id,
      priority: 'HIGH',
    });

    // 1. Optimistic locking: conflicting expectedStatus rejects update
    const conflictResult = await updateReviewCase(rCase.id, {
      status: 'APPROVED',
      resolutionReason: 'Approved override',
      expectedStatus: 'IN_REVIEW', // Current status is OPEN, not IN_REVIEW
    });
    expect(conflictResult.updated).toBe(false);
    expect(conflictResult.rowCount).toBe(0);

    // Verify status was NOT modified
    const { getReviewCaseById } = require('../src/db/repositories/reviewCaseRepository');
    const unchangedCase = await getReviewCaseById(rCase.id);
    expect(unchangedCase.status).toBe('OPEN');

    // 2. Successful update with matching expectedStatus
    const successResult = await updateReviewCase(rCase.id, {
      status: 'APPROVED',
      resolutionReason: 'Manual operator confirmed documents',
      expectedStatus: 'OPEN',
    });
    expect(successResult.updated).toBe(true);
    expect(successResult.status).toBe('APPROVED');
  });
});

