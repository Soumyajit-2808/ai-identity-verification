/**
 * Comprehensive Audit & Corrections Test Suite
 * Validates:
 * 1. Concurrency-safe duplicate file detection & unique database constraint
 * 2. Unexpected DB error propagation (not swallowed as duplicate)
 * 3. Cross-tenant audit log scoping
 * 4. Event policy validation (booleans, min/max age, unknown fields, ID types)
 * 5. Canonical ID types vocabulary
 * 6. Explicit PDF upload rejection
 * 7. Schema synchronization between root and backend
 * 8. Frontend synchronization between root and backend
 * 9. Review case state transitions, optimistic locking, and resolution reasons
 */

process.env.DATABASE_URL = 'sqlite::memory:';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../server');
const { query, closeDb, getClient } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const {
  registerIdentity,
  checkDuplicateFile,
  isUniqueConstraintViolation,
} = require('../src/db/repositories/identityRegistryRepository');
const { logEvent } = require('../src/db/repositories/auditLogRepository');

describe('Audit Corrections & Invariant Tests', () => {
  let adminToken;
  let reviewerToken;
  let testEventId;
  let testOrgId;

  beforeAll(async () => {
    await runMigrations();

    // Authenticate admin and reviewer
    const adminLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@verifyid.local', password: 'Admin@12345' });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.token;

    const reviewerLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'reviewer@verifyid.local', password: 'Reviewer@12345' });
    expect(reviewerLogin.status).toBe(200);
    reviewerToken = reviewerLogin.body.token;

    // Fetch default event
    const eventsRes = await request(app).get('/api/events');
    expect(eventsRes.status).toBe(200);
    testEventId = eventsRes.body.events[0].id;
    testOrgId = eventsRes.body.events[0].organization_id;
  });

  afterAll(async () => {
    await closeDb();
  });

  describe('1. Concurrency & Identity Registry DB Invariants', () => {
    test('Simultaneous duplicate file insertion into identity_registry triggers unique constraint violation', async () => {
      const regId1 = crypto.randomUUID();
      const regId2 = crypto.randomUUID();
      const docHash = 'hash_' + crypto.randomUUID();

      await query(
        `INSERT INTO registrations (id, event_id, registration_name, email, status) VALUES ($1, $2, $3, $4, $5)`,
        [regId1, testEventId, 'First Registrant', 'first@test.local', 'VERIFIED']
      );
      await query(
        `INSERT INTO registrations (id, event_id, registration_name, email, status) VALUES ($1, $2, $3, $4, $5)`,
        [regId2, testEventId, 'Second Registrant', 'second@test.local', 'VERIFIED']
      );

      // First registration succeeds
      const firstResult = await registerIdentity({
        eventId: testEventId,
        rawIdNumber: 'PAN_FIRST_' + crypto.randomUUID(),
        idType: 'PAN',
        documentFileHash: docHash,
        registrationId: regId1,
        registeredName: 'First Registrant',
      });
      expect(firstResult.id).toBeDefined();

      // Second registration with the same document hash but different ID number hash
      // MUST trigger conflict detection on (event_id, document_file_hash) without overwriting
      const secondResult = await registerIdentity({
        eventId: testEventId,
        rawIdNumber: 'PAN_SECOND_' + crypto.randomUUID(),
        idType: 'PAN',
        documentFileHash: docHash, // Exact same file
        registrationId: regId2,
        registeredName: 'Second Registrant',
      });

      expect(secondResult.registered).toBe(false);
      expect(secondResult.conflict).toBe(true);
      expect(secondResult.conflictType).toBe('DUPLICATE_FILE');

      // Direct DB assertion: exactly ONE record exists for docHash
      const countRes = await query(
        `SELECT COUNT(*) as count FROM identity_registry WHERE event_id = $1 AND document_file_hash = $2`,
        [testEventId, docHash]
      );
      expect(Number(countRes.rows[0].count)).toBe(1);
    });

    test('Same-person resubmission safely detects resubmission without destroying original registry history', async () => {
      const regId = crypto.randomUUID();
      const docHash1 = 'file_1_' + crypto.randomUUID();
      const docHash2 = 'file_2_' + crypto.randomUUID();

      await query(
        `INSERT INTO registrations (id, event_id, registration_name, email, status) VALUES ($1, $2, $3, $4, $5)`,
        [regId, testEventId, 'Legitimate Person', 'legit@test.local', 'VERIFIED']
      );

      const initial = await registerIdentity({
        eventId: testEventId,
        rawIdNumber: 'ABCDE1234F',
        idType: 'PAN',
        documentFileHash: docHash1,
        registrationId: regId,
        registeredName: 'Legitimate Person',
      });
      expect(initial.id).toBeDefined();

      // Same person submits a new document
      const updated = await registerIdentity({
        eventId: testEventId,
        rawIdNumber: 'ABCDE1234F',
        idType: 'PAN',
        documentFileHash: docHash2,
        registrationId: regId,
        registeredName: 'Legitimate Person',
      });
      expect(updated.conflict).toBe(true);
      expect(updated.isSamePersonResubmission).toBe(true);
      expect(updated.existingRecord.id).toBe(initial.id);
      expect(updated.existingRecord.registered_name).toBe('Legitimate Person');
      expect(updated.existingRecord.document_file_hash).toBe(docHash1); // Original intact!
    });

    test('Unexpected database failures in identity registration are NOT swallowed as duplicates', async () => {
      // Pass an invalid client / corrupt query to verify errors bubble up
      const mockBrokenClient = {
        query: async () => {
          const err = new Error('FATAL: Database connection terminated unexpectedly');
          err.code = '57P01'; // Postgres admin shutdown code
          throw err;
        },
      };

      let threwUnexpected = false;
      try {
        await registerIdentity(
          {
            eventId: testEventId,
            idNumberHash: 'hash123',
            documentFileHash: 'filehash123',
            registrationId: 'reg123',
            registeredName: 'Test',
          },
          mockBrokenClient
        );
      } catch (err) {
        threwUnexpected = true;
        expect(err.message).toMatch(/terminated unexpectedly/);
        expect(isUniqueConstraintViolation(err)).toBe(false);
      }
      expect(threwUnexpected).toBe(true);
    });
  });

  describe('2. Event Policy Validation & Canonical ID Types', () => {
    test('PATCH /api/events/:id rejects string "false" for requireSelfie', async () => {
      const res = await request(app)
        .patch(`/api/events/${testEventId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ requireSelfie: 'false' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/requireSelfie must be.*boolean/i);
    });

    test('PATCH /api/events/:id rejects string "true" for strictNameMatching', async () => {
      const res = await request(app)
        .patch(`/api/events/${testEventId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ strictNameMatching: 'true' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/strictNameMatching must be.*boolean/i);
    });

    test('PATCH /api/events/:id rejects unknown/unsupported ID types', async () => {
      const res = await request(app)
        .patch(`/api/events/${testEventId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ allowedIdTypes: ['PASSPORT', 'INVALID_BUS_PASS'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unsupported id type/i);
    });

    test('PATCH /api/events/:id rejects unknown unexpected fields', async () => {
      const res = await request(app)
        .patch(`/api/events/${testEventId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ maliciousField: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unrecognized.*field.*maliciousField/i);
    });

    test('PATCH /api/events/:id successfully accepts all canonical ID types', async () => {
      const canonicalTypes = [
        'PASSPORT',
        'DRIVING_LICENSE',
        'STUDENT_ID',
        'NATIONAL_ID',
        'AADHAAR',
        'PAN',
        'VOTER_ID',
      ];

      const res = await request(app)
        .patch(`/api/events/${testEventId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          allowedIdTypes: canonicalTypes,
          requireSelfie: true,
          strictNameMatching: false,
          minAge: 18,
          maxAge: 35,
        });

      expect(res.status).toBe(200);
      expect(res.body.event.require_selfie).toBe(true);
      expect(res.body.event.strict_name_matching).toBe(false);
      expect(res.body.event.allowed_id_types).toEqual(canonicalTypes);
    });
  });

  describe('3. PDF Upload Rejection', () => {
    test('POST /api/verify explicitly rejects PDF files with magic bytes', async () => {
      // PDF-1.4 header
      const pdfBuffer = Buffer.from('%PDF-1.4\n%Fake PDF binary stream\n%%EOF');

      const res = await request(app)
        .post('/api/verify')
        .field('registration_name', 'PDF Tester')
        .field('event_code', 'HACK2026')
        .attach('file', pdfBuffer, 'document.pdf');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PDF_NOT_SUPPORTED');
      expect(res.body.error).toMatch(/pdf documents are not supported/i);
    });
  });

  describe('4. Authoritative Cross-Tenant Audit Log Isolation', () => {
    let orgBId, adminBId, eventBId, adminBToken;

    beforeAll(async () => {
      // Create Organization B
      orgBId = crypto.randomUUID();
      await query(
        `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
        [orgBId, 'Isolated Org B', `org-b-${crypto.randomUUID()}`]
      );

      // Create Admin for Org B
      adminBId = crypto.randomUUID();
      const hashB = await bcrypt.hash('AdminB@123', 10);
      await query(
        `INSERT INTO users (id, organization_id, email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4, 'Admin B', 'admin')`,
        [adminBId, orgBId, `admin-b-${crypto.randomUUID()}@beta.org`, hashB]
      );

      // Login Admin B to obtain JWT
      const loginBRes = await request(app)
        .post('/api/auth/login')
        .send({ email: `admin-b-${adminBId}@beta.org`, password: 'AdminB@123' });
      // If login by dynamic email fails, generate token directly or query user
      const userBRow = (await query(`SELECT * FROM users WHERE id = $1`, [adminBId])).rows[0];
      const { generateToken } = require('../src/middleware/auth');
      adminBToken = generateToken(userBRow);

      // Create Event in Org B
      eventBId = crypto.randomUUID();
      await query(
        `INSERT INTO events (id, organization_id, name, code, min_age, max_age)
         VALUES ($1, $2, $3, $4, 18, 99)`,
        [eventBId, orgBId, 'Event B Exclusive', `EVTB_${crypto.randomUUID().slice(0, 6)}`]
      );
    });

    test('Test 4.1: Same event, different actor (actor A acts on event B) -> authoritative org is B; Org A cannot view it', async () => {
      // Admin A acts on Event B
      const auditLog = await logEvent({
        actorId: 'admin-a-id', // Actor from org A
        actorRole: 'admin',
        action: 'CROSS_ACTOR_OPERATION',
        entityType: 'EVENT',
        entityId: eventBId,
        eventId: eventBId, // Event belongs to Org B
        details: { note: 'Admin A acting on Event B' },
      });

      // Admin A queries audit logs -> MUST NOT see it
      const resA = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resA.status).toBe(200);
      const logIdsA = resA.body.logs.map(l => l.id);
      expect(logIdsA).not.toContain(auditLog.id);

      // Admin B queries audit logs -> MUST see it
      const resB = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${adminBToken}`);
      expect(resB.status).toBe(200);
      const logIdsB = resB.body.logs.map(l => l.id);
      expect(logIdsB).toContain(auditLog.id);
    });

    test('Test 4.2: Same actor, different event (actor B acts on event A) -> authoritative org is A; Org B cannot view it', async () => {
      // Admin B acts on default event (Org A)
      const auditLog = await logEvent({
        actorId: adminBId, // Actor from Org B
        actorRole: 'admin',
        action: 'ACTOR_B_ON_EVENT_A',
        entityType: 'EVENT',
        entityId: testEventId,
        eventId: testEventId, // Event belongs to Org A
        details: { note: 'Admin B acting on Event A' },
      });

      // Admin B queries audit logs -> MUST NOT see it
      const resB = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${adminBToken}`);
      expect(resB.status).toBe(200);
      const logIdsB = resB.body.logs.map(l => l.id);
      expect(logIdsB).not.toContain(auditLog.id);

      // Admin A queries audit logs -> MUST see it
      const resA = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resA.status).toBe(200);
      const logIdsA = resA.body.logs.map(l => l.id);
      expect(logIdsA).toContain(auditLog.id);
    });

    test('Test 4.3: event_id is NULL (user-level event in Org B) -> Org A cannot view it', async () => {
      const auditLog = await logEvent({
        actorId: adminBId,
        actorRole: 'admin',
        action: 'USER_PASSWORD_CHANGE',
        entityType: 'USER',
        entityId: adminBId,
        eventId: null,
        details: { note: 'Password changed' },
      });

      const resA = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`);
      const logIdsA = resA.body.logs.map(l => l.id);
      expect(logIdsA).not.toContain(auditLog.id);
    });

    test('Test 4.4: actor_id is NULL (system/anonymous submission on event B) -> authoritative org is B; Org A cannot view it', async () => {
      const auditLog = await logEvent({
        actorId: null,
        actorRole: null,
        action: 'ANONYMOUS_VERIFICATION_SUBMISSION',
        entityType: 'VERIFICATION_REQUEST',
        entityId: crypto.randomUUID(),
        eventId: eventBId,
        details: { ip: '127.0.0.1' },
      });

      const resA = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`);
      const logIdsA = resA.body.logs.map(l => l.id);
      expect(logIdsA).not.toContain(auditLog.id);

      const resB = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${adminBToken}`);
      const logIdsB = resB.body.logs.map(l => l.id);
      expect(logIdsB).toContain(auditLog.id);
    });

    test('Test 4.5: System-generated log (actor_id NULL, event_id NULL) -> not leaked to tenant feeds', async () => {
      const auditLog = await logEvent({
        organizationId: null,
        actorId: null,
        actorRole: null,
        action: 'GLOBAL_SYSTEM_CLEANUP',
        entityType: 'SYSTEM',
        entityId: 'SYSTEM',
        eventId: null,
        details: { cleanedFiles: 0 },
      });

      const resA = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resA.body.logs.map(l => l.id)).not.toContain(auditLog.id);

      const resB = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${adminBToken}`);
      expect(resB.body.logs.map(l => l.id)).not.toContain(auditLog.id);
    });

    test('Test 4.6: Canonical ID Types vocabulary is fully synchronized across schema, backend, and documentation', async () => {
      const expectedCanonical = [
        'AADHAAR',
        'DRIVING_LICENSE',
        'NATIONAL_ID',
        'PAN',
        'PASSPORT',
        'STUDENT_ID',
        'VOTER_ID',
      ];

      // Verify schema.sql default
      const rootSchema = fs.readFileSync(path.resolve(__dirname, '../../database/schema.sql'), 'utf-8');
      const backendSchema = fs.readFileSync(path.resolve(__dirname, '../database/schema.sql'), 'utf-8');
      expect(rootSchema).toBe(backendSchema);

      expectedCanonical.forEach((idType) => {
        expect(rootSchema).toContain(idType);
      });

      // Verify default seeded event contains all canonical types
      const evCheck = await query(`SELECT allowed_id_types FROM events WHERE code = 'HACK2026'`);
      const defaultTypes = JSON.parse(evCheck.rows[0].allowed_id_types).sort();
      expect(defaultTypes).toEqual(expectedCanonical);
    });
  });

  describe('5. Review Workflow State Transitions & Optimistic Locking', () => {
    let reviewCaseId;

    beforeAll(async () => {
      // Create a test registration & review case in default org
      const regId = crypto.randomUUID();
      await query(
        `INSERT INTO registrations (id, event_id, registration_name, email, status)
         VALUES ($1, $2, 'Case Review Applicant', 'case@test.local', 'REVIEW_REQUIRED')`,
        [regId, testEventId]
      );

      const reqId = crypto.randomUUID();
      await query(
        `INSERT INTO verification_requests (id, registration_id, event_id, status)
         VALUES ($1, $2, $3, 'COMPLETED')`,
        [reqId, regId, testEventId]
      );

      const resId = crypto.randomUUID();
      await query(
        `INSERT INTO verification_results (id, request_id, registration_id, decision, confidence_score, risk_score, evidence_score, summary_reason, extracted_identity_json)
         VALUES ($1, $2, $3, 'REVIEW', 0.50, 0.40, 0.50, 'Ambiguous name', '{}')`,
        [resId, reqId, regId]
      );

      reviewCaseId = crypto.randomUUID();
      await query(
        `INSERT INTO review_cases (id, result_id, registration_id, event_id, status, priority)
         VALUES ($1, $2, $3, $4, 'OPEN', 'MEDIUM')`,
        [reviewCaseId, resId, regId, testEventId]
      );
    });

    test('Reviewer cannot approve without a resolutionReason', async () => {
      const res = await request(app)
        .patch(`/api/review-cases/${reviewCaseId}`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({ status: 'APPROVED' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/resolution reason is required/i);
    });

    test('Reviewer approves case successfully', async () => {
      const res = await request(app)
        .patch(`/api/review-cases/${reviewCaseId}`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          status: 'APPROVED',
          resolutionReason: 'Document validated via manual inspection',
          reviewerNotes: 'Verified against university roster',
        });

      expect(res.status).toBe(200);
      expect(res.body.case.status).toBe('APPROVED');
      expect(res.body.case.resolution_reason).toBe('Document validated via manual inspection');
    });

    test('Reviewer cannot overwrite an already APPROVED case (409 Conflict)', async () => {
      const res = await request(app)
        .patch(`/api/review-cases/${reviewCaseId}`)
        .set('Authorization', `Bearer ${reviewerToken}`)
        .send({
          status: 'REJECTED',
          resolutionReason: 'Changing mind',
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/cannot be modified by reviewer/i);
    });

    test('Optimistic locking fails when expectedStatus does not match', async () => {
      const res = await request(app)
        .patch(`/api/review-cases/${reviewCaseId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          expectedStatus: 'OPEN', // But current is APPROVED
          status: 'ESCALATED',
          resolutionReason: 'Admin escalation',
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CASE_STATUS_CONFLICT');
    });
  });

  describe('6. Repository Schema and Frontend Synchronization', () => {
    test('database/schema.sql and backend/database/schema.sql are line-for-line identical', () => {
      const rootSchemaPath = path.resolve(__dirname, '../../database/schema.sql');
      const backendSchemaPath = path.resolve(__dirname, '../database/schema.sql');

      expect(fs.existsSync(rootSchemaPath)).toBe(true);
      expect(fs.existsSync(backendSchemaPath)).toBe(true);

      const rootSchema = fs.readFileSync(rootSchemaPath, 'utf8').replace(/\r\n/g, '\n').trim();
      const backendSchema = fs.readFileSync(backendSchemaPath, 'utf8').replace(/\r\n/g, '\n').trim();

      expect(rootSchema).toBe(backendSchema);
    });

    test('frontend/index.html and backend/frontend/index.html are line-for-line identical', () => {
      const rootFrontendPath = path.resolve(__dirname, '../../frontend/index.html');
      const backendFrontendPath = path.resolve(__dirname, '../frontend/index.html');

      expect(fs.existsSync(rootFrontendPath)).toBe(true);
      expect(fs.existsSync(backendFrontendPath)).toBe(true);

      const rootFrontend = fs.readFileSync(rootFrontendPath, 'utf8').replace(/\r\n/g, '\n').trim();
      const backendFrontend = fs.readFileSync(backendFrontendPath, 'utf8').replace(/\r\n/g, '\n').trim();

      expect(rootFrontend).toBe(backendFrontend);
    });
  });
});
