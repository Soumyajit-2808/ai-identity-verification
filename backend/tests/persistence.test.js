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
});
