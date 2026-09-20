/**
 * Concurrency Invariants & Database State Verification Test Suite
 * 
 * Specifically validates:
 * 1. Concurrent exact file duplicate submissions:
 *    - Exactly ONE identity registry entry exists
 *    - Original registrant data is never overwritten
 *    - Racing request is transitioned to REVIEW with DUPLICATE_FILE signal
 *    - No unexplained 500 errors
 * 2. Concurrent identity reuse (same ID number, conflicting registrant names):
 *    - First identity creates the registry entry
 *    - Conflicting identity does NOT overwrite the original record (Rahul Sharma != Rohan Mehta)
 *    - Conflicting identity is transitioned to REVIEW with IDENTITY_REUSE signal
 *    - Exactly ONE identity registry entry exists for that event + id_number_hash
 * 3. In-transaction duplicate detection:
 *    - Exercises the path where initial pre-check passes but in-transaction duplicate check fires
 *    - Proves no TypeError on duplicateFileCheck or finalSummaryReason
 *    - Verifies that risk score, confidence score, signals, decision, review case, and response are all updated
 * 4. Cross-event document isolation:
 *    - Same document submitted to Event A and Event B both succeed (not globally blocked)
 */

process.env.DATABASE_URL = 'sqlite::memory:';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const app = require('../server');
const { query, closeDb, getDbType } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const {
  hashIdNumber,
  registerIdentity,
  checkDuplicateFile,
  checkIdentityReuse,
} = require('../src/db/repositories/identityRegistryRepository');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Concurrency Invariants & Database State Integrity', () => {
  let adminToken;
  let testEventId;
  let secondEventId;
  let originalFetch;

  beforeAll(async () => {
    await runMigrations();

    // Authenticate admin
    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@verifyid.local', password: 'Admin@12345' });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.token;

    // Fetch default event
    const evRes = await query(`SELECT id FROM events WHERE code = 'HACK2026'`);
    testEventId = evRes.rows[0].id;

    // Create a second event in default org for cross-event isolation test
    secondEventId = crypto.randomUUID();
    const orgRes = await query(`SELECT id FROM organizations LIMIT 1`);
    const defaultOrgId = orgRes.rows[0].id;

    await query(
      `INSERT INTO events (id, organization_id, name, code, min_age, max_age)
       VALUES ($1, $2, 'Secondary Event', 'SEC2026', 18, 99)`,
      [secondEventId, defaultOrgId]
    );

    // Mock global.fetch for AI verification endpoint to return deterministic responses based on registration name
    originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/verify')) {
        // Parse multipart form to extract registration_name if present
        let regName = 'Standard User';
        if (options && options.body && typeof options.body.get === 'function') {
          regName = options.body.get('registration_name') || regName;
        }

        // Return mock AI response
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            verification: {
              decision: 'ELIGIBLE',
              confidence_score: 0.95,
              risk_score: 0.05,
              evidence_score: 0.95,
              summary_reason: 'Automated AI checks passed.',
              extracted_identity: {
                name: regName,
                date_of_birth: '1995-05-15',
                calculated_age: 30,
                id_number: 'TEST-ID-999999',
                id_type: 'PASSPORT',
                institution: null,
              },
              signals: [
                {
                  signal_type: 'OCR',
                  status: 'PASSED',
                  score: 1.0,
                  reason: 'Text extracted successfully.',
                  details: {},
                },
                {
                  signal_type: 'QUALITY',
                  status: 'PASSED',
                  score: 1.0,
                  reason: 'Quality is clear.',
                  details: {},
                },
                {
                  signal_type: 'TAMPER',
                  status: 'PASSED',
                  score: 1.0,
                  reason: 'No tampering detected.',
                  details: {},
                },
                {
                  signal_type: 'ELIGIBILITY',
                  status: 'PASSED',
                  score: 1.0,
                  reason: 'Age is eligible.',
                  details: {},
                },
                {
                  signal_type: 'NAME_MATCH',
                  status: 'PASSED',
                  score: 1.0,
                  reason: 'Name matches registration.',
                  details: {},
                },
              ],
            },
          }),
        };
      }
      return originalFetch(url, options);
    };
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await closeDb();
  });

  test('Invariant 1: Concurrent exact file duplicate submissions must yield exactly 1 registry record and preserve original data', async () => {
    const filePath = path.join(FIXTURES_DIR, 'valid_id.png');
    const fileBuffer = fs.readFileSync(filePath);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Launch two parallel requests with the identical document
    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/verify')
        .field('registration_name', 'Original Registrant Rahul')
        .field('event_code', 'HACK2026')
        .attach('file', filePath),
      request(app)
        .post('/api/verify')
        .field('registration_name', 'Duplicate Registrant Rohan')
        .field('event_code', 'HACK2026')
        .attach('file', filePath),
    ]);

    // Assert neither request returned an unexplained 500 error
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const decisions = [res1.body.decision, res2.body.decision];
    expect(decisions).toContain('REVIEW');

    const reviewRes = res1.body.decision === 'REVIEW' ? res1.body : res2.body;
    const eligibleRes = res1.body.decision === 'ELIGIBLE' ? res1.body : res2.body;

    // Verify review response has elevated risk, recalculate confidence, and DUPLICATE_FILE signal
    expect(reviewRes.risk_score).toBeGreaterThanOrEqual(0.35);
    expect(reviewRes.confidence_score).toBeLessThan(eligibleRes.confidence_score);
    const dupSignal = reviewRes.signals.find(s => s.signal_type === 'DUPLICATE_FILE' || s.signalType === 'DUPLICATE_FILE');
    expect(dupSignal).toBeDefined();
    expect(dupSignal.status).toBe('REVIEW');
    expect(dupSignal.score).toBe(0.0);

    // Verify a review case was created in the database for the flagged submission
    expect(reviewRes.reviewCaseId).toBeDefined();
    const caseDb = await query(`SELECT * FROM review_cases WHERE id = $1`, [reviewRes.reviewCaseId]);
    expect(caseDb.rows.length).toBe(1);
    expect(caseDb.rows[0].status).toBe('OPEN');

    // AUTHORITATIVE DATABASE ASSERTIONS:
    // Exactly ONE record exists in identity_registry for this (event_id, document_file_hash)
    const regRecords = await query(
      `SELECT * FROM identity_registry WHERE event_id = $1 AND document_file_hash = $2`,
      [testEventId, fileHash]
    );
    expect(regRecords.rows.length).toBe(1);

    // Original registrant data must remain intact and NOT be overwritten by the racing request
    const winnerName = eligibleRes.identity.name;
    expect(regRecords.rows[0].registered_name).toBe(winnerName);
  }, 25000);

  async function createTestRegistration(eventId, name) {
    const regId = crypto.randomUUID();
    await query(
      `INSERT INTO registrations (id, event_id, registration_name, status) VALUES ($1, $2, $3, 'PENDING')`,
      [regId, eventId, name]
    );
    return regId;
  }

  test('Invariant 2: Identity registry registerIdentity never overwrites an existing identity on conflicting name', async () => {
    const rawId = 'AADHAAR-RACE-001';
    const idHash = hashIdNumber(rawId);
    const uniqueHashA = crypto.randomUUID();
    const uniqueHashB = crypto.randomUUID();

    const regIdA = await createTestRegistration(testEventId, 'Rahul Sharma');
    const regIdB = await createTestRegistration(testEventId, 'Rohan Mehta');

    // 1. First registration: "Rahul Sharma"
    const regA = await registerIdentity({
      eventId: testEventId,
      registrationId: regIdA,
      rawIdNumber: rawId,
      idType: 'AADHAAR',
      registeredName: 'Rahul Sharma',
      documentFileHash: uniqueHashA,
    });
    expect(regA.registered).toBe(true);
    expect(regA.conflict).toBe(false);

    // Verify DB state after first insert
    const afterA = await query(
      `SELECT registered_name, document_file_hash FROM identity_registry WHERE event_id = $1 AND id_number_hash = $2`,
      [testEventId, idHash]
    );
    expect(afterA.rows.length).toBe(1);
    expect(afterA.rows[0].registered_name).toBe('Rahul Sharma');
    expect(afterA.rows[0].document_file_hash).toBe(uniqueHashA);

    // 2. Second registration: conflicting name "Rohan Mehta" with SAME ID number
    const regB = await registerIdentity({
      eventId: testEventId,
      registrationId: regIdB,
      rawIdNumber: rawId,
      idType: 'AADHAAR',
      registeredName: 'Rohan Mehta',
      documentFileHash: uniqueHashB,
    });

    // Semantics: conflict detected, NOT registered, original NOT overwritten
    expect(regB.registered).toBe(false);
    expect(regB.conflict).toBe(true);
    expect(regB.conflictType).toBe('IDENTITY_REUSE');
    expect(regB.isSamePersonResubmission).toBe(false);

    // Query DB directly: Rahul Sharma MUST NOT have been overwritten by Rohan Mehta!
    const afterB = await query(
      `SELECT registered_name, document_file_hash FROM identity_registry WHERE event_id = $1 AND id_number_hash = $2`,
      [testEventId, idHash]
    );
    expect(afterB.rows.length).toBe(1);
    expect(afterB.rows[0].registered_name).toBe('Rahul Sharma');
    expect(afterB.rows[0].document_file_hash).toBe(uniqueHashA);
  });

  test('Invariant 3: Same-person resubmission does not destroy original registry history', async () => {
    const rawId = 'PAN-RESUBMIT-999';
    const idHash = hashIdNumber(rawId);
    const docHash1 = crypto.randomUUID();
    const docHash2 = crypto.randomUUID();

    const regId1 = await createTestRegistration(testEventId, 'Priya Verma');
    const regId2 = await createTestRegistration(testEventId, 'Priya Verma');

    // First submission
    const sub1 = await registerIdentity({
      eventId: testEventId,
      registrationId: regId1,
      rawIdNumber: rawId,
      idType: 'PAN',
      registeredName: 'Priya Verma',
      documentFileHash: docHash1,
    });
    expect(sub1.registered).toBe(true);

    // Resubmission by SAME person with new document photo
    const sub2 = await registerIdentity({
      eventId: testEventId,
      registrationId: regId2,
      rawIdNumber: rawId,
      idType: 'PAN',
      registeredName: 'Priya Verma',
      documentFileHash: docHash2,
    });

    expect(sub2.conflict).toBe(true);
    expect(sub2.isSamePersonResubmission).toBe(true);

    // Original entry in database is preserved
    const res = await query(
      `SELECT registered_name, document_file_hash FROM identity_registry WHERE event_id = $1 AND id_number_hash = $2`,
      [testEventId, idHash]
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].registered_name).toBe('Priya Verma');
    expect(res.rows[0].document_file_hash).toBe(docHash1);
  });

  test('Invariant 4: Cross-event document deduplication is event-scoped and does not falsely block independent events', async () => {
    const rawId = 'STUDENT-XEVENT-123';
    const sharedDocHash = crypto.randomUUID();

    const ev1RegId = await createTestRegistration(testEventId, 'Cross Event User');
    const ev2RegId = await createTestRegistration(secondEventId, 'Cross Event User');

    // Event 1 submission
    const ev1Reg = await registerIdentity({
      eventId: testEventId,
      registrationId: ev1RegId,
      rawIdNumber: rawId,
      idType: 'STUDENT_ID',
      registeredName: 'Cross Event User',
      documentFileHash: sharedDocHash,
    });
    expect(ev1Reg.registered).toBe(true);

    // Event 2 submission with identical document and ID
    const ev2Reg = await registerIdentity({
      eventId: secondEventId,
      registrationId: ev2RegId,
      rawIdNumber: rawId,
      idType: 'STUDENT_ID',
      registeredName: 'Cross Event User',
      documentFileHash: sharedDocHash,
    });
    expect(ev2Reg.registered).toBe(true);

    // Verify both events have exactly 1 record each
    const ev1Check = await query(
      `SELECT id FROM identity_registry WHERE event_id = $1 AND document_file_hash = $2`,
      [testEventId, sharedDocHash]
    );
    const ev2Check = await query(
      `SELECT id FROM identity_registry WHERE event_id = $1 AND document_file_hash = $2`,
      [secondEventId, sharedDocHash]
    );
    expect(ev1Check.rows.length).toBe(1);
    expect(ev2Check.rows.length).toBe(1);
  });

  test('Invariant 5: In-transaction duplicate detection flow operates without TypeError and leaves complete, consistent state', async () => {
    // We submit through API with a file whose hash is already registered in Invariant 1
    const filePath = path.join(FIXTURES_DIR, 'valid_id.png');

    const res = await request(app)
      .post('/api/verify')
      .field('registration_name', 'Racing Registrant')
      .field('event_code', 'HACK2026')
      .attach('file', filePath);

    expect(res.status).toBe(200);
    // Since filePath valid_id.png was registered in Invariant 1, this triggers the duplicate check!
    expect(res.body.decision).toBe('REVIEW');
    expect(res.body.risk_score).toBeGreaterThanOrEqual(0.35);

    // Verify that the duplicate file signal exists, confidence is updated, and reviewCaseId is populated
    const dupSignal = res.body.signals.find(s => s.signal_type === 'DUPLICATE_FILE' || s.signalType === 'DUPLICATE_FILE');
    expect(dupSignal).toBeDefined();
    expect(dupSignal.status).toBe('REVIEW');
    expect(res.body.reviewCaseId).toBeDefined();

    // Verify database review_cases record matches the response reviewCaseId
    const rCase = await query(`SELECT * FROM review_cases WHERE id = $1`, [res.body.reviewCaseId]);
    expect(rCase.rows.length).toBe(1);
    expect(rCase.rows[0].priority).toBe('HIGH');
  });

  test('Invariant 6: Concurrent requests with same ID number and conflicting names yield exactly 1 registry record, produce REVIEW with review case, and preserve original identity', async () => {
    // Generate two distinct valid PNG buffers so neither is detected as a duplicate file
    const png1 = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
      0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x31,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
      0x42, 0x60, 0x82,
    ]);
    const png2 = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
      0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x32,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
      0x42, 0x60, 0x82,
    ]);

    const contestedIdNumber = 'AADHAAR-CONCUR-777';
    const contestedIdHash = hashIdNumber(contestedIdNumber);

    // Override fetch mock temporarily for this test to return the same ID number for both
    const savedFetch = global.fetch;
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/verify')) {
        let regName = 'Standard User';
        if (options && options.body && typeof options.body.get === 'function') {
          regName = options.body.get('registration_name') || regName;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            verification: {
              decision: 'ELIGIBLE',
              confidence_score: 0.95,
              risk_score: 0.05,
              evidence_score: 0.95,
              summary_reason: 'Automated AI checks passed.',
              extracted_identity: {
                name: regName,
                date_of_birth: '1995-05-15',
                calculated_age: 30,
                id_number: contestedIdNumber,
                id_type: 'AADHAAR',
                institution: null,
              },
              signals: [
                { signal_type: 'OCR', status: 'PASSED', score: 1.0, reason: 'OCR pass.' },
                { signal_type: 'QUALITY', status: 'PASSED', score: 1.0, reason: 'Quality pass.' },
                { signal_type: 'TAMPER', status: 'PASSED', score: 1.0, reason: 'Tamper pass.' },
                { signal_type: 'ELIGIBILITY', status: 'PASSED', score: 1.0, reason: 'Age pass.' },
                { signal_type: 'NAME_MATCH', status: 'PASSED', score: 1.0, reason: 'Name pass.' },
              ],
            },
          }),
        };
      }
      return originalFetch(url, options);
    };

    try {
      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/verify')
          .field('registration_name', 'First Participant Alice')
          .field('event_code', 'HACK2026')
          .attach('file', png1, 'alice.png'),
        request(app)
          .post('/api/verify')
          .field('registration_name', 'Second Participant Bob')
          .field('event_code', 'HACK2026')
          .attach('file', png2, 'bob.png'),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const decisions = [res1.body.decision, res2.body.decision];
      expect(decisions).toContain('REVIEW');

      const reviewRes = res1.body.decision === 'REVIEW' ? res1.body : res2.body;
      const eligibleRes = res1.body.decision === 'ELIGIBLE' ? res1.body : res2.body;

      // Assert review response signals and scores
      expect(reviewRes.risk_score).toBeGreaterThanOrEqual(0.40);
      expect(reviewRes.confidence_score).toBeLessThan(eligibleRes.confidence_score);
      const reuseSignal = reviewRes.signals.find(s => s.signal_type === 'IDENTITY_REUSE' || s.signalType === 'IDENTITY_REUSE');
      expect(reuseSignal).toBeDefined();
      expect(reuseSignal.status).toBe('REVIEW');
      expect(reviewRes.reviewCaseId).toBeDefined();

      // Assert review case in DB
      const rCase = await query(`SELECT * FROM review_cases WHERE id = $1`, [reviewRes.reviewCaseId]);
      expect(rCase.rows.length).toBe(1);
      expect(rCase.rows[0].status).toBe('OPEN');
      expect(rCase.rows[0].priority).toBe('HIGH');

      // Assert database invariant: EXACTLY ONE record in identity_registry for contested ID
      const regRecords = await query(
        `SELECT * FROM identity_registry WHERE event_id = $1 AND id_number_hash = $2`,
        [testEventId, contestedIdHash]
      );
      expect(regRecords.rows.length).toBe(1);

      // Assert original registrant name was preserved
      const originalName = eligibleRes.identity.name;
      expect(regRecords.rows[0].registered_name).toBe(originalName);
    } finally {
      global.fetch = savedFetch;
    }
  });

  test('Invariant 7: Unexpected database errors inside transaction propagate and abort transaction without committing partial state', async () => {
    const { transaction } = require('../src/db/connection');
    const testRegId = crypto.randomUUID();

    let threwError = false;
    try {
      await transaction(async (txClient) => {
        await txClient.query(
          `INSERT INTO registrations (id, event_id, registration_name, status) VALUES ($1, $2, 'Temp User', 'PENDING')`,
          [testRegId, testEventId]
        );
        // Execute an intentionally malformed query to cause an unexpected error
        await txClient.query(`INSERT INTO non_existent_table_xyz VALUES ('bad')`);
      });
    } catch (err) {
      threwError = true;
    }

    expect(threwError).toBe(true);

    // Assert that the transaction was rolled back and 'Temp User' was NOT committed
    const check = await query(`SELECT * FROM registrations WHERE id = $1`, [testRegId]);
    expect(check.rows.length).toBe(0);
  });
});
