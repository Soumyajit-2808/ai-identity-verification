/**
 * Targeted Tests: Public Response PII Sanitization & Biometric Fallback Invariants
 *
 * Verifies:
 * 1. Exact duplicate document submission does NOT leak existingRegistrationId or previous participant PII publicly.
 * 2. Identity reuse under different name does NOT leak previousName or previous participant PII publicly.
 * 3. Database unique constraint conflict does NOT leak existingRecord or internal DB fields publicly.
 * 4. Internal reviewer/admin endpoints (GET /api/verifications/:id, database) retain complete investigative evidence.
 * 5. Biometric UNAVAILABLE status routes to REVIEW and never ELIGIBLE through the public verification API.
 */
process.env.DATABASE_URL = 'sqlite::memory:';

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const app = require('../server');
const { runMigrations } = require('../src/db/migrate');
const { closeDb, query } = require('../src/db/connection');
const { generateToken } = require('../src/middleware/auth');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Public Verification PII Sanitization & Safety Invariants', () => {
  let adminToken;
  let testEventId;
  let originalFetch;
  let defaultMockFetch;

  beforeAll(async () => {
    process.env.DB_ENGINE = 'sqlite';
    process.env.SQLITE_DB_PATH = ':memory:';
    await runMigrations();

    const evRes = await query(`SELECT id FROM events WHERE code = 'HACK2026'`);
    testEventId = evRes.rows[0].id;

    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@verifyid.local', password: 'Admin@12345' });
    adminToken = adminLogin.body.token;

    originalFetch = global.fetch;
    defaultMockFetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/verify')) {
        let regName = 'Standard Registrant';
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
                date_of_birth: '1998-07-20',
                calculated_age: 27,
                id_number: 'TEST-ID-' + crypto.randomUUID(),
                id_type: 'PASSPORT',
                institution: null,
              },
              signals: [
                { signal_type: 'OCR', status: 'PASSED', score: 1.0, reason: 'Text extracted.' },
                { signal_type: 'QUALITY', status: 'PASSED', score: 1.0, reason: 'Clear.' },
                { signal_type: 'TAMPER', status: 'PASSED', score: 1.0, reason: 'No tampering.' },
                { signal_type: 'ELIGIBILITY', status: 'PASSED', score: 1.0, reason: 'Eligible.' },
                { signal_type: 'NAME_MATCH', status: 'PASSED', score: 1.0, reason: 'Name matches.' },
              ],
            },
          }),
        };
      }
      return originalFetch ? originalFetch(url, options) : Promise.reject(new Error('Unmocked fetch: ' + url));
    };
    global.fetch = defaultMockFetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await closeDb();
  });

  afterEach(() => {
    global.fetch = defaultMockFetch;
  });

  test('Scenario 1: Exact duplicate document does NOT leak existingRegistrationId or previous applicant PII in public response', async () => {
    const rawBuf = fs.readFileSync(path.join(FIXTURES_DIR, 'valid_id.png'));
    const uniqueDoc = Buffer.concat([rawBuf, crypto.randomBytes(32)]);

    // First submission: Original Applicant
    const res1 = await request(app)
      .post('/api/verify')
      .field('registration_name', 'First Participant Rahul')
      .field('event_code', 'HACK2026')
      .attach('file', uniqueDoc, 'unique_id.png');

    expect(res1.status).toBe(200);
    const firstRegistrationId = res1.body.registrationId;
    expect(firstRegistrationId).toBeDefined();

    // Second submission: Duplicate document with different applicant name
    const res2 = await request(app)
      .post('/api/verify')
      .field('registration_name', 'Duplicate Applicant Rohan')
      .field('event_code', 'HACK2026')
      .attach('file', uniqueDoc, 'unique_id.png');

    expect(res2.status).toBe(200);
    expect(res2.body.decision).toBe('REVIEW');

    const publicJson = JSON.stringify(res2.body);

    // CRITICAL PUBLIC INVARIANTS:
    // 1. Must NOT contain the string 'existingRegistrationId'
    expect(publicJson).not.toContain('existingRegistrationId');
    // 2. Must NOT contain the first applicant's registration ID
    expect(publicJson).not.toContain(firstRegistrationId);
    // 3. Must NOT contain the first applicant's name
    expect(publicJson).not.toContain('First Participant Rahul');
    // 4. Must NOT contain raw internal database records
    expect(publicJson).not.toContain('existingRecord');

    // Assert signal reason is explainable and generic
    const dupSignal = res2.body.signals.find(s => (s.signal_type || s.signalType) === 'DUPLICATE_FILE');
    expect(dupSignal).toBeDefined();
    expect(dupSignal.status).toBe('REVIEW');
    expect(dupSignal.reason).toBe('This document has already been submitted for this event.');
    expect(dupSignal.details.existingRegistrationId).toBeUndefined();
    expect(dupSignal.details.existingRecord).toBeUndefined();

    // INTERNAL REVIEWER INVESTIGATION INVARIANT:
    // Reviewers/admins querying the internal API MUST still have the investigative evidence
    const internalRes = await request(app)
      .get(`/api/verifications/${res2.body.requestId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(internalRes.status).toBe(200);
    const internalDupSignal = internalRes.body.verification.signals.find(s => (s.signal_type || s.signalType) === 'DUPLICATE_FILE');
    expect(internalDupSignal).toBeDefined();
    expect(internalDupSignal.details.existingRegistrationId).toBe(firstRegistrationId);
  });

  test('Scenario 2: Identity reuse under different name does NOT leak previousName or previous applicant PII in public response', async () => {
    // Generate two distinct PNG files to avoid duplicate file hash check
    const makePng = (tag) => {
      const buf = fs.readFileSync(path.join(FIXTURES_DIR, 'valid_id.png'));
      const copy = Buffer.from(buf);
      copy[copy.length - 1] = (copy[copy.length - 1] + tag) % 256;
      return copy;
    };

    const doc1 = makePng(11);
    const doc2 = makePng(22);
    const sharedIdNumber = 'REUSE-ID-987654';

    // Mock AI service to return shared extracted ID number
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/verify')) {
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
              summary_reason: 'Automated verification passed successfully.',
              extracted_identity: {
                name: 'Extracted Identity Name',
                date_of_birth: '2000-01-15',
                calculated_age: 26,
                id_number: sharedIdNumber,
                id_type: 'PASSPORT',
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

    // First applicant registers with this ID
    const res1 = await request(app)
      .post('/api/verify')
      .field('registration_name', 'Original Owner Alice')
      .field('event_code', 'HACK2026')
      .attach('file', doc1, 'alice.png');

    expect(res1.status).toBe(200);

    // Second applicant attempts to register with the SAME extracted ID number under a different name
    const res2 = await request(app)
      .post('/api/verify')
      .field('registration_name', 'Imposter Applicant Bob')
      .field('event_code', 'HACK2026')
      .attach('file', doc2, 'bob.png');

    expect(res2.status).toBe(200);
    expect(res2.body.decision).toBe('REVIEW');

    const publicJson = JSON.stringify(res2.body);

    // CRITICAL PUBLIC INVARIANTS:
    // 1. Must NOT contain the string 'previousName'
    expect(publicJson).not.toContain('previousName');
    // 2. Must NOT contain the previous applicant's name
    expect(publicJson).not.toContain('Original Owner Alice');
    // 3. Must NOT contain internal record fields
    expect(publicJson).not.toContain('existingRecord');
    expect(publicJson).not.toContain('registered_name');

    // Assert signal reason is explainable and generic without leaking previous applicant
    const reuseSignal = res2.body.signals.find(s => (s.signal_type || s.signalType) === 'IDENTITY_REUSE');
    expect(reuseSignal).toBeDefined();
    expect(reuseSignal.status).toBe('REVIEW');
    expect(reuseSignal.reason).toBe('The extracted ID number was previously registered for this event and requires manual review.');
    expect(reuseSignal.details.previousName).toBeUndefined();
    expect(reuseSignal.details.existingRecord).toBeUndefined();

    // INTERNAL REVIEWER INVESTIGATION INVARIANT:
    // Internal API must retain previousName so reviewers can investigate the discrepancy
    const internalRes = await request(app)
      .get(`/api/verifications/${res2.body.requestId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(internalRes.status).toBe(200);
    const internalReuseSignal = internalRes.body.verification.signals.find(s => (s.signal_type || s.signalType) === 'IDENTITY_REUSE');
    expect(internalReuseSignal).toBeDefined();
    expect(internalReuseSignal.details.previousName).toBe('Original Owner Alice');
  });

  test('Scenario 3: Database unique-constraint conflict handling does NOT leak existingRecord or internal fields in public response', async () => {
    const identityRepo = require('../src/db/repositories/identityRegistryRepository');
    const originalRegisterIdentity = identityRepo.registerIdentity;

    const docBuffer = Buffer.from(fs.readFileSync(path.join(FIXTURES_DIR, 'valid_id.png')));
    docBuffer[docBuffer.length - 3] = (docBuffer[docBuffer.length - 3] + 88) % 256;
    docBuffer[docBuffer.length - 4] = (docBuffer[docBuffer.length - 4] + 99) % 256;

    // Simulate database unique constraint conflict race
    jest.spyOn(identityRepo, 'registerIdentity').mockImplementationOnce(async (params, txClient) => {
      return {
        registered: false,
        conflict: true,
        conflictType: 'IDENTITY_REUSE',
        isSamePersonResubmission: false,
        existingRecord: {
          id: 'mock-reg-id-999',
          registration_id: 'confidential-reg-id-888',
          registered_name: 'Confidential Earlier Participant',
          id_number_hash: 'secret-hash-777',
          document_file_hash: 'secret-doc-hash-666',
        },
      };
    });

    try {
      const res = await request(app)
        .post('/api/verify')
        .field('registration_name', 'Racing Applicant Charlie')
        .field('event_code', 'HACK2026')
        .attach('file', docBuffer, 'charlie.png');

      expect(res.status).toBe(200);
      expect(res.body.decision).toBe('REVIEW');

      const publicJson = JSON.stringify(res.body);

      // CRITICAL PUBLIC INVARIANTS:
      expect(publicJson).not.toContain('existingRecord');
      expect(publicJson).not.toContain('Confidential Earlier Participant');
      expect(publicJson).not.toContain('confidential-reg-id-888');
      expect(publicJson).not.toContain('registered_name');

      const conflictSig = res.body.signals.find(s => (s.signal_type || s.signalType) === 'IDENTITY_REUSE');
      expect(conflictSig).toBeDefined();
      expect(conflictSig.status).toBe('REVIEW');
      expect(conflictSig.reason).toBe('The extracted ID number was previously registered for this event and requires manual review.');
      expect(conflictSig.details.existingRecord).toBeUndefined();

      // INTERNAL DATABASE INVARIANT:
      // In the database verification_signals table, the internal details are preserved for auditing
      const dbSignals = await query(
        `SELECT raw_details_json FROM verification_signals WHERE result_id = (
           SELECT id FROM verification_results WHERE registration_id = $1
         )`,
        [res.body.registrationId]
      );
      expect(dbSignals.rows.length).toBeGreaterThan(0);
      const hasDetailedConflict = dbSignals.rows.some(r => r.raw_details_json && r.raw_details_json.includes('Confidential Earlier Participant'));
      expect(hasDetailedConflict).toBe(true);
    } finally {
      identityRepo.registerIdentity.mockRestore();
    }
  });

  test('Scenario 4: Biometric UNAVAILABLE from AI service forces REVIEW and can NEVER lead to ELIGIBLE', async () => {
    const docBuffer = Buffer.from(fs.readFileSync(path.join(FIXTURES_DIR, 'valid_id.png')));
    docBuffer[docBuffer.length - 1] = (docBuffer[docBuffer.length - 1] + 55) % 256;

    // Mock AI service returning UNAVAILABLE biometric check
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/verify')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            verification: {
              decision: 'REVIEW',
              confidence_score: 0.55,
              risk_score: 0.35,
              evidence_score: 0.80,
              summary_reason: 'Manual operator review is required due to: biometric verification unavailable.',
              extracted_identity: {
                name: 'Biometric Test User',
                date_of_birth: '2001-09-20',
                calculated_age: 25,
                id_number: 'BIO-FAIL-12345',
                id_type: 'PASSPORT',
                institution: null,
              },
              signals: [
                { signal_type: 'OCR', status: 'PASSED', score: 1.0, reason: 'OCR pass.' },
                { signal_type: 'QUALITY', status: 'PASSED', score: 1.0, reason: 'Quality pass.' },
                { signal_type: 'TAMPER', status: 'PASSED', score: 1.0, reason: 'Tamper pass.' },
                { signal_type: 'ELIGIBILITY', status: 'PASSED', score: 1.0, reason: 'Age pass.' },
                { signal_type: 'NAME_MATCH', status: 'PASSED', score: 1.0, reason: 'Name pass.' },
                {
                  signal_type: 'FACE_MATCH',
                  status: 'UNAVAILABLE',
                  score: null,
                  reason: 'Biometric verification could not be completed; manual review is required.',
                  details: { state: 'SERVICE_ERROR' },
                },
              ],
            },
          }),
        };
      }
      return originalFetch(url, options);
    };

    const res = await request(app)
      .post('/api/verify')
      .field('registration_name', 'Biometric Test User')
      .field('event_code', 'HACK2026')
      .attach('file', docBuffer, 'bio_test.png')
      .attach('selfie', docBuffer, 'selfie.png');

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('REVIEW');
    expect(res.body.decision).not.toBe('ELIGIBLE');
    expect(res.body.reviewCaseId).toBeDefined();

    const faceSig = res.body.signals.find(s => (s.signal_type || s.signalType) === 'FACE_MATCH');
    expect(faceSig).toBeDefined();
    expect(faceSig.status).toBe('UNAVAILABLE');
    expect(faceSig.reason).toContain('Biometric verification could not be completed; manual review is required.');
    // Must NOT contain internal error traces
    expect(JSON.stringify(res.body)).not.toContain('Traceback');
    expect(JSON.stringify(res.body)).not.toContain('Exception');
  });
});
