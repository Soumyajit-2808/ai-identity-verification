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
      // MUST trigger a unique constraint violation on (event_id, document_file_hash)
      let caughtError = null;
      try {
        await registerIdentity({
          eventId: testEventId,
          rawIdNumber: 'PAN_SECOND_' + crypto.randomUUID(),
          idType: 'PAN',
          documentFileHash: docHash, // Exact same file
          registrationId: regId2,
          registeredName: 'Second Registrant',
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(isUniqueConstraintViolation(caughtError)).toBe(true);
    });

    test('Same-person resubmission safely updates without failing', async () => {
      const regId = crypto.randomUUID();
      const idNumHash = 'same_person_' + crypto.randomUUID();
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
      expect(updated.id).toBe(initial.id);
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

  describe('4. Cross-Tenant Audit Log Isolation', () => {
    test('Admin in Org A cannot view audit logs generated by Org B', async () => {
      // Create Organization B
      const orgBId = crypto.randomUUID();
      await query(
        `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
        [orgBId, 'Isolated Org B', `org-b-${crypto.randomUUID()}`]
      );

      // Create Admin for Org B
      const adminBId = crypto.randomUUID();
      const hashB = await bcrypt.hash('AdminB@123', 10);
      await query(
        `INSERT INTO users (id, organization_id, email, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4, 'Admin B', 'admin')`,
        [adminBId, orgBId, `admin-b-${crypto.randomUUID()}@beta.org`, hashB]
      );

      // Create Event in Org B
      const eventBId = crypto.randomUUID();
      await query(
        `INSERT INTO events (id, organization_id, name, code, min_age, max_age)
         VALUES ($1, $2, $3, $4, 18, 99)`,
        [eventBId, orgBId, 'Event B Exclusive', `EVTB_${crypto.randomUUID().slice(0, 6)}`]
      );

      // Log an event in Org B
      const auditLogB = await logEvent({
        actorId: adminBId,
        actorRole: 'admin',
        action: 'CONFIDENTIAL_OPERATION_B',
        entityType: 'EVENT',
        entityId: eventBId,
        eventId: eventBId,
        details: { confidential: true },
      });

      // Query audit logs using Admin A token
      const res = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const logIds = res.body.logs.map(l => l.id);
      expect(logIds).not.toContain(auditLogB.id);
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
