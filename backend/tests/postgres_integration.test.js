/**
 * PostgreSQL Transaction & Invariant Integration Test Suite
 * Specifically verifies PostgreSQL savepoint sub-transaction error recovery,
 * non-destructive identity registry handling, and transaction continuation.
 *
 * Runs only when TEST_DATABASE_URL or DATABASE_URL points to a PostgreSQL instance.
 * Does NOT fake PostgreSQL behavior using SQLite.
 */

const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  registerIdentity,
  hashIdNumber,
} = require('../src/db/repositories/identityRegistryRepository');

const pgUrl = process.env.TEST_DATABASE_URL || (
  process.env.DATABASE_URL && (process.env.DATABASE_URL.startsWith('postgres://') || process.env.DATABASE_URL.startsWith('postgresql://'))
    ? process.env.DATABASE_URL
    : null
);

const describePg = pgUrl ? describe : describe.skip;

describePg('PostgreSQL-Native Transaction Invariants & Recovery', () => {
  let pool;
  let testEventId;
  let testOrgId;

  beforeAll(async () => {
    if (!pgUrl) return;
    pool = new Pool({
      connectionString: pgUrl,
      connectionTimeoutMillis: 3000,
    });

    // Test connectivity
    await pool.query('SELECT 1');

    // Run schema
    const schemaPath = path.resolve(__dirname, '../../database/schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    const cleanSql = schemaSql
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');
    await pool.query(cleanSql);

    // Setup test organization and event
    testOrgId = crypto.randomUUID();
    testEventId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, 'PG Test Org', $2)
       ON CONFLICT (slug) DO NOTHING`,
      [testOrgId, 'pg-test-org-' + Date.now()]
    );
    await pool.query(
      `INSERT INTO events (id, organization_id, name, code, min_age, max_age)
       VALUES ($1, $2, 'PG Test Event', $3, 18, 99)
       ON CONFLICT (code) DO NOTHING`,
      [testEventId, testOrgId, 'PGEV-' + Date.now()]
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  test('1. First identity registration succeeds inside a PostgreSQL transaction', async () => {
    const client = await pool.connect();
    const rawId = 'PG-ID-VALID-101';
    const idHash = hashIdNumber(rawId);
    const regId = crypto.randomUUID();
    const docHash = crypto.randomUUID();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO registrations (id, event_id, registration_name, status) VALUES ($1, $2, 'Alice Walker', 'PENDING')`,
        [regId, testEventId]
      );

      const clientWrapper = { query: (sql, params) => client.query(sql, params) };
      const reg = await registerIdentity(
        {
          eventId: testEventId,
          registrationId: regId,
          rawIdNumber: rawId,
          idType: 'PASSPORT',
          registeredName: 'Alice Walker',
          documentFileHash: docHash,
        },
        clientWrapper
      );

      expect(reg.registered).toBe(true);
      expect(reg.conflict).toBe(false);

      await client.query('COMMIT');

      // Verify row persisted
      const check = await pool.query(
        `SELECT registered_name, document_file_hash FROM identity_registry WHERE event_id = $1 AND id_number_hash = $2`,
        [testEventId, idHash]
      );
      expect(check.rows.length).toBe(1);
      expect(check.rows[0].registered_name).toBe('Alice Walker');
    } finally {
      client.release();
    }
  });

  test('2. Second registration with conflicting name recovers via SAVEPOINT and transaction can continue without "current transaction is aborted"', async () => {
    const client = await pool.connect();
    const rawId = 'PG-ID-VALID-101'; // Same ID as Test 1
    const idHash = hashIdNumber(rawId);
    const regIdB = crypto.randomUUID();
    const docHashB = crypto.randomUUID();
    const extraRegId = crypto.randomUUID();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO registrations (id, event_id, registration_name, status) VALUES ($1, $2, 'Bob Imposter', 'PENDING')`,
        [regIdB, testEventId]
      );

      const clientWrapper = { query: (sql, params) => client.query(sql, params) };

      // registerIdentity encounters unique constraint violation on (event_id, id_number_hash)
      // With SAVEPOINT, it must NOT leave the PostgreSQL transaction in an aborted state!
      const regB = await registerIdentity(
        {
          eventId: testEventId,
          registrationId: regIdB,
          rawIdNumber: rawId,
          idType: 'PASSPORT',
          registeredName: 'Bob Imposter',
          documentFileHash: docHashB,
        },
        clientWrapper
      );

      // Verify structured conflict result returned
      expect(regB.registered).toBe(false);
      expect(regB.conflict).toBe(true);
      expect(regB.conflictType).toBe('IDENTITY_REUSE');
      expect(regB.isSamePersonResubmission).toBe(false);

      // Verify PostgreSQL transaction is NOT aborted: subsequent write query inside the SAME transaction MUST succeed!
      // In PostgreSQL, if the transaction were aborted, this query would throw:
      // "current transaction is aborted, commands ignored until end of transaction block"
      let queryAfterConflictSucceeded = false;
      try {
        await client.query(
          `INSERT INTO registrations (id, event_id, registration_name, status) VALUES ($1, $2, 'After Conflict User', 'PENDING')`,
          [extraRegId, testEventId]
        );
        queryAfterConflictSucceeded = true;
      } catch (err) {
        queryAfterConflictSucceeded = false;
      }
      expect(queryAfterConflictSucceeded).toBe(true);

      // Commit the transaction successfully
      await client.query('COMMIT');

      // 4. Assert original identity registry row remains unchanged
      const check = await pool.query(
        `SELECT registered_name, document_file_hash FROM identity_registry WHERE event_id = $1 AND id_number_hash = $2`,
        [testEventId, idHash]
      );
      expect(check.rows.length).toBe(1);
      expect(check.rows[0].registered_name).toBe('Alice Walker'); // Still Alice, NOT Bob!

      // Assert subsequent write was committed
      const afterCheck = await pool.query(
        `SELECT registration_name FROM registrations WHERE id = $1`,
        [extraRegId]
      );
      expect(afterCheck.rows.length).toBe(1);
      expect(afterCheck.rows[0].registration_name).toBe('After Conflict User');
    } finally {
      client.release();
    }
  });

  test('3. Unexpected database errors still abort the transaction in PostgreSQL', async () => {
    const client = await pool.connect();
    const tempRegId = crypto.randomUUID();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO registrations (id, event_id, registration_name, status) VALUES ($1, $2, 'Temp User', 'PENDING')`,
        [tempRegId, testEventId]
      );

      let threw = false;
      try {
        await client.query(`SELECT * FROM completely_non_existent_table_12345`);
      } catch (err) {
        threw = true;
      }
      expect(threw).toBe(true);

      // Rollback
      await client.query('ROLLBACK');

      // Assert nothing committed
      const check = await pool.query(`SELECT * FROM registrations WHERE id = $1`, [tempRegId]);
      expect(check.rows.length).toBe(0);
    } finally {
      client.release();
    }
  });
});
