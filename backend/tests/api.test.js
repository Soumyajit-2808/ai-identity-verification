/**
 * Backend API Integration Test Suite
 * Tests health endpoints, authentication, verification orchestration,
 * magic byte validation, review cases, and audit trail.
 */

process.env.DATABASE_URL = 'sqlite::memory:';

const request = require('supertest');
const app = require('../server');
const { closeDb } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');

// Create a minimal valid 100x100 PNG buffer
const validPngBuffer = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
  0x42, 0x60, 0x82,
]);

describe('Backend API Endpoints', () => {
  let authToken;

  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closeDb();
  });

  test('1. GET /api/health returns health status', async () => {
    const res = await request(app).get('/api/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body.service).toBe('identity-verification-backend');
    expect(res.body.database.status).toBe('healthy');
  });

  test('2. POST /api/auth/login validates credentials', async () => {
    // Bad credentials
    const badRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@verifyid.local', password: 'WrongPassword' });
    expect(badRes.status).toBe(401);
    expect(badRes.body.code).toBe('INVALID_CREDENTIALS');

    // Valid credentials
    const goodRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@verifyid.local', password: 'Admin@12345' });
    expect(goodRes.status).toBe(200);
    expect(goodRes.body.token).toBeDefined();
    expect(goodRes.body.user.role).toBe('admin');
    authToken = goodRes.body.token;
  });

  test('3. GET /api/auth/me returns authenticated operator', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('admin@verifyid.local');
  });

  test('4. GET /api/events returns event list and policies', async () => {
    const res = await request(app).get('/api/events');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events.length).toBeGreaterThan(0);
    expect(res.body.events[0].code).toBe('HACK2026');
  });

  test('5. POST /api/verify rejects files with invalid magic bytes', async () => {
    // Fake text file disguised as a JPEG
    const fakeBuffer = Buffer.from('THIS IS NOT A VALID IMAGE FILE');
    const res = await request(app)
      .post('/api/verify')
      .field('registration_name', 'Rahul Sharma')
      .attach('file', fakeBuffer, 'fake.jpg');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILE_SIGNATURE');
  });

  test('6. POST /api/verify rejects missing registration name', async () => {
    const res = await request(app)
      .post('/api/verify')
      .field('registration_name', '')
      .attach('file', validPngBuffer, 'test.png');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_NAME');
  });
});
