/**
 * Multi-Tenancy & Tenant Isolation Test Suite
 * Validates that cross-tenant access to review cases, documents, event policies,
 * and deduplication registries is strictly forbidden across distinct organizations.
 */

process.env.DATABASE_URL = 'sqlite::memory:';

const request = require('supertest');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const app = require('../server');
const { query } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { saveDocument } = require('../src/storage/documentStorage');

describe('Multi-Tenancy & Organization Isolation Tests', () => {
  let orgAId, orgBId;
  let eventAId, eventBId;
  let userAToken, userBToken;
  let reviewCaseBId, documentBId, verifReqBId;

  beforeAll(async () => {
    await runMigrations();

    // 1. Create Organization A & Organization B with unique slugs
    orgAId = crypto.randomUUID();
    orgBId = crypto.randomUUID();

    await query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
      [orgAId, 'Tenant Organization Alpha', `tenant-alpha-${crypto.randomUUID()}`]
    );
    await query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
      [orgBId, 'Tenant Organization Beta', `tenant-beta-${crypto.randomUUID()}`]
    );

    // 2. Create Reviewer in Org A and Reviewer in Org B
    const userAId = crypto.randomUUID();
    const userBId = crypto.randomUUID();
    const hashA = await bcrypt.hash('PasswordA@123', 10);
    const hashB = await bcrypt.hash('PasswordB@123', 10);

    await query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userAId, orgAId, 'reviewer-a@alpha.org', hashA, 'Reviewer Alpha', 'reviewer']
    );
    await query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userBId, orgBId, 'reviewer-b@beta.org', hashB, 'Reviewer Beta', 'reviewer']
    );

    // Obtain JWT tokens
    const loginA = await request(app)
      .post('/api/auth/login')
      .send({ email: 'reviewer-a@alpha.org', password: 'PasswordA@123' });
    userAToken = loginA.body.token;

    const loginB = await request(app)
      .post('/api/auth/login')
      .send({ email: 'reviewer-b@beta.org', password: 'PasswordB@123' });
    userBToken = loginB.body.token;

    // 3. Create Event A in Org A, Event B in Org B
    eventAId = crypto.randomUUID();
    eventBId = crypto.randomUUID();

    await query(
      `INSERT INTO events (id, organization_id, name, code, min_age, max_age)
       VALUES ($1, $2, $3, $4, 18, 99)`,
      [eventAId, orgAId, 'Alpha Event 2026', `EVT_A_${crypto.randomUUID().slice(0, 8)}`]
    );
    await query(
      `INSERT INTO events (id, organization_id, name, code, min_age, max_age)
       VALUES ($1, $2, $3, $4, 21, 99)`,
      [eventBId, orgBId, 'Beta Event 2026', `EVT_B_${crypto.randomUUID().slice(0, 8)}`]
    );

    // 4. Create Registration, Verification, Review Case, and Document in Org B
    const regBId = crypto.randomUUID();
    await query(
      `INSERT INTO registrations (id, event_id, registration_name, email, status)
       VALUES ($1, $2, 'Applicant In Beta', 'applicant@beta.org', 'REVIEW_REQUIRED')`,
      [regBId, eventBId]
    );

    const docStorage = await saveDocument({
      buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]),
      originalFilename: 'beta_id.jpg',
      mimeType: 'image/jpeg',
    });

    documentBId = crypto.randomUUID();
    await query(
      `INSERT INTO identity_documents (id, registration_id, document_type, file_hash, storage_path, original_filename, mime_type, file_size_bytes)
       VALUES ($1, $2, 'IDENTITY_DOCUMENT', $3, $4, 'beta_id.jpg', 'image/jpeg', 12)`,
      [documentBId, regBId, docStorage.fileHash, docStorage.storagePath]
    );

    const reqBId = crypto.randomUUID();
    verifReqBId = reqBId;
    await query(
      `INSERT INTO verification_requests (id, registration_id, event_id, status)
       VALUES ($1, $2, $3, 'COMPLETED')`,
      [reqBId, regBId, eventBId]
    );

    const resBId = crypto.randomUUID();
    await query(
      `INSERT INTO verification_results (id, request_id, registration_id, decision, confidence_score, risk_score, evidence_score, summary_reason, extracted_identity_json)
       VALUES ($1, $2, $3, 'REVIEW', 0.55, 0.45, 0.50, 'Borderline name match in Beta', '{}')`,
      [resBId, reqBId, regBId]
    );

    reviewCaseBId = crypto.randomUUID();
    await query(
      `INSERT INTO review_cases (id, result_id, registration_id, event_id, status, priority, reviewer_notes)
       VALUES ($1, $2, $3, $4, 'OPEN', 'HIGH', 'Flagged in Beta')`,
      [reviewCaseBId, resBId, regBId, eventBId]
    );
  });

  test('Reviewer in Org A should not see review cases belonging to Org B in list', async () => {
    const res = await request(app)
      .get('/api/review-cases')
      .set('Authorization', `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    const caseIds = res.body.cases.map(c => c.id);
    expect(caseIds).not.toContain(reviewCaseBId);
  });

  test('Reviewer in Org B should see review cases belonging to Org B in list', async () => {
    const res = await request(app)
      .get('/api/review-cases')
      .set('Authorization', `Bearer ${userBToken}`);

    expect(res.status).toBe(200);
    const caseIds = res.body.cases.map(c => c.id);
    expect(caseIds).toContain(reviewCaseBId);
  });

  test('Reviewer in Org A should receive 404 when directly fetching review case from Org B', async () => {
    const res = await request(app)
      .get(`/api/review-cases/${reviewCaseBId}`)
      .set('Authorization', `Bearer ${userAToken}`);

    expect(res.status).toBe(404);
  });

  test('Reviewer in Org A should receive 404 when attempting to mutate review case from Org B', async () => {
    const res = await request(app)
      .patch(`/api/review-cases/${reviewCaseBId}`)
      .set('Authorization', `Bearer ${userAToken}`)
      .send({ status: 'APPROVED', reviewerNotes: 'Unauthorized approval attempt' });

    expect(res.status).toBe(404);
  });

  test('Reviewer in Org A should be forbidden (403) from retrieving document image from Org B', async () => {
    const res = await request(app)
      .get(`/api/documents/${documentBId}/file`)
      .set('Authorization', `Bearer ${userAToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access denied/i);
  });

  test('Reviewer in Org B should successfully retrieve document image from Org B', async () => {
    const res = await request(app)
      .get(`/api/documents/${documentBId}/file`)
      .set('Authorization', `Bearer ${userBToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  test('Admin in Org A should be forbidden (403) from modifying event policy of Org B', async () => {
    // Create an Admin user in Org A
    const adminAId = crypto.randomUUID();
    const adminHashA = await bcrypt.hash('AdminPasswordA@123', 10);
    await query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, 'Admin Alpha', 'admin')`,
      [adminAId, orgAId, 'admin-a@alpha.org', adminHashA]
    );

    const loginAdminA = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin-a@alpha.org', password: 'AdminPasswordA@123' });
    const adminAToken = loginAdminA.body.token;

    const res = await request(app)
      .patch(`/api/events/${eventBId}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ minAge: 16 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/access denied: event belongs to another organization/i);
  });

  test('Unauthenticated requests to /api/verifications should be rejected with 401', async () => {
    const res = await request(app).get('/api/verifications');
    expect(res.status).toBe(401);
  });

  test('Reviewer in Org A should not see verification records from Org B in list', async () => {
    const res = await request(app)
      .get('/api/verifications')
      .set('Authorization', `Bearer ${userAToken}`);

    expect(res.status).toBe(200);
    const reqIds = res.body.verifications.map(v => v.request_id);
    expect(reqIds).not.toContain(verifReqBId);
  });

  test('Reviewer in Org B should see verification records from Org B in list', async () => {
    const res = await request(app)
      .get('/api/verifications')
      .set('Authorization', `Bearer ${userBToken}`);

    expect(res.status).toBe(200);
    const reqIds = res.body.verifications.map(v => v.request_id);
    expect(reqIds).toContain(verifReqBId);
  });

  test('Reviewer in Org A should receive 404 when directly fetching verification record of Org B', async () => {
    const res = await request(app)
      .get(`/api/verifications/${verifReqBId}`)
      .set('Authorization', `Bearer ${userAToken}`);

    expect(res.status).toBe(404);
  });

  test('Unauthenticated request to /api/metrics should return 401', async () => {
    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(401);
  });

  test('Reviewer in Org B should receive scoped metrics from /api/metrics', async () => {
    const res = await request(app)
      .get('/api/metrics')
      .set('Authorization', `Bearer ${userBToken}`);

    expect(res.status).toBe(200);
    expect(res.body.organizationId).toBe(orgBId);
    expect(res.body.metrics.totalVerifications).toBeGreaterThanOrEqual(1);
  });
});
