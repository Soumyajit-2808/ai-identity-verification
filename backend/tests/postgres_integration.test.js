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

  test('4. Real PostgreSQL Concurrency: Two independent transactions race to register the same ID number with different names', async () => {
    // Acquire two completely separate connections from the pool
    const client1 = await pool.connect();
    const client2 = await pool.connect();

    const contestedRawId = 'PG-RACE-ID-' + crypto.randomUUID();
    const contestedIdHash = hashIdNumber(contestedRawId);

    const regId1 = crypto.randomUUID();
    const regId2 = crypto.randomUUID();
    const docHash1 = crypto.randomUUID();
    const docHash2 = crypto.randomUUID();

    const client1Wrapper = { query: (sql, params) => client1.query(sql, params) };
    const client2Wrapper = { query: (sql, params) => client2.query(sql, params) };

    try {
      // Step A: Start two independent transactions
      await client1.query('BEGIN');
      await client2.query('BEGIN');

      await client1.query(
        `INSERT INTO registrations (id, event_id, registration_name, status) VALUES ($1, $2, 'Alice Concurrent', 'PENDING')`,
        [regId1, testEventId]
      );
      await client2.query(
        `INSERT INTO registrations (id, event_id, registration_name, status) VALUES ($1, $2, 'Bob Concurrent', 'PENDING')`,
        [regId2, testEventId]
      );

      // Step B & C: Fire both registerIdentity calls concurrently via Promise.all
      const [res1, res2] = await Promise.all([
        registerIdentity(
          {
            eventId: testEventId,
            registrationId: regId1,
            rawIdNumber: contestedRawId,
            idType: 'AADHAAR',
            registeredName: 'Alice Concurrent',
            documentFileHash: docHash1,
          },
          client1Wrapper
        ),
        registerIdentity(
          {
            eventId: testEventId,
            registrationId: regId2,
            rawIdNumber: contestedRawId,
            idType: 'AADHAAR',
            registeredName: 'Bob Concurrent',
            documentFileHash: docHash2,
          },
          client2Wrapper
        ),
      ]);

      // Step D: Exactly one succeeded, exactly one conflicted
      const winner = res1.registered ? res1 : res2;
      const loser = !res1.registered ? res1 : res2;
      const winnerName = res1.registered ? 'Alice Concurrent' : 'Bob Concurrent';
      const loserClient = !res1.registered ? client1 : client2;
      const winnerClient = res1.registered ? client1 : client2;
      const loserRegId = !res1.registered ? regId1 : regId2;
      const winnerRegId = res1.registered ? regId1 : regId2;

      expect(winner.registered).toBe(true);
      expect(winner.conflict).toBe(false);

      expect(loser.registered).toBe(false);
      expect(loser.conflict).toBe(true);
      expect(loser.conflictType).toBe('IDENTITY_REUSE');
      expect(loser.isSamePersonResubmission).toBe(false);

      // Step F: Simulate verification route pipeline logic on the losing transaction:
      // Conflict becomes REVIEW with high-priority review case rather than an error or 500
      let finalDecision = loser.conflict ? 'REVIEW' : 'ELIGIBLE';
      expect(finalDecision).toBe('REVIEW');

      // In the losing transaction, create a review case and update registration to REVIEW_REQUIRED
      // This proves the losing PostgreSQL transaction remained healthy and un-aborted!
      const revCaseId = crypto.randomUUID();
      const verifResultId = crypto.randomUUID();
      const verifReqId = crypto.randomUUID();

      await loserClient.query(
        `INSERT INTO verification_requests (id, registration_id, event_id, status) VALUES ($1, $2, $3, 'COMPLETED')`,
        [verifReqId, loserRegId, testEventId]
      );
      await loserClient.query(
        `INSERT INTO verification_results (id, request_id, registration_id, decision, confidence_score, risk_score)
         VALUES ($1, $2, $3, 'REVIEW', 0.55, 0.45)`,
        [verifResultId, verifReqId, loserRegId]
      );
      await loserClient.query(
        `INSERT INTO review_cases (id, result_id, registration_id, event_id, priority, status)
         VALUES ($1, $2, $3, $4, 'HIGH', 'OPEN')`,
        [revCaseId, verifResultId, loserRegId, testEventId]
      );
      await loserClient.query(
        `UPDATE registrations SET status = 'REVIEW_REQUIRED' WHERE id = $1`,
        [loserRegId]
      );

      // In the winning transaction, update registration to VERIFIED
      await winnerClient.query(
        `UPDATE registrations SET status = 'VERIFIED' WHERE id = $1`,
        [winnerRegId]
      );

      // Both transactions commit cleanly
      await client1.query('COMMIT');
      await client2.query('COMMIT');

      // Step G: Check database consistency after both transactions finish
      const regRows = await pool.query(
        `SELECT registered_name, document_file_hash FROM identity_registry WHERE event_id = $1 AND id_number_hash = $2`,
        [testEventId, contestedIdHash]
      );
      // Exactly ONE row exists in PostgreSQL
      expect(regRows.rows.length).toBe(1);
      // Original authoritative record was never overwritten
      expect(regRows.rows[0].registered_name).toBe(winnerName);

      // Both registrations exist with their respective statuses
      const regStatusCheck = await pool.query(
        `SELECT id, status FROM registrations WHERE id IN ($1, $2)`,
        [regId1, regId2]
      );
      expect(regStatusCheck.rows.length).toBe(2);

      // Review case was persisted for the loser
      const caseCheck = await pool.query(
        `SELECT id, priority, status FROM review_cases WHERE id = $1`,
        [revCaseId]
      );
      expect(caseCheck.rows.length).toBe(1);
      expect(caseCheck.rows[0].status).toBe('OPEN');
      expect(caseCheck.rows[0].priority).toBe('HIGH');
    } finally {
      client1.release();
      client2.release();
    }
  });

  test('5. Real PostgreSQL Concurrency: Two independent transactions race to register the same document_file_hash', async () => {
    const clientA = await pool.connect();
    const clientB = await pool.connect();

    const sharedDocHash = 'doc-hash-race-' + crypto.randomUUID();
    const rawIdA = 'PG-DOC-A-' + crypto.randomUUID();
    const rawIdB = 'PG-DOC-B-' + crypto.randomUUID();

    const regIdA = crypto.randomUUID();
    const regIdB = crypto.randomUUID();

    const clientAWrapper = { query: (sql, params) => clientA.query(sql, params) };
    const clientBWrapper = { query: (sql, params) => clientB.query(sql, params) };

    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      await clientA.query(
        `INSERT INTO registrations (id, event_id, registration_name, status) VALUES ($1, $2, 'Doc User A', 'PENDING')`,
        [regIdA, testEventId]
      );
      await clientB.query(
        `INSERT INTO registrations (id, event_id, registration_name, status) VALUES ($1, $2, 'Doc User B', 'PENDING')`,
        [regIdB, testEventId]
      );

      const [resA, resB] = await Promise.all([
        registerIdentity(
          {
            eventId: testEventId,
            registrationId: regIdA,
            rawIdNumber: rawIdA,
            idType: 'PASSPORT',
            registeredName: 'Doc User A',
            documentFileHash: sharedDocHash,
          },
          clientAWrapper
        ),
        registerIdentity(
          {
            eventId: testEventId,
            registrationId: regIdB,
            rawIdNumber: rawIdB,
            idType: 'PASSPORT',
            registeredName: 'Doc User B',
            documentFileHash: sharedDocHash,
          },
          clientBWrapper
        ),
      ]);

      const winner = resA.registered ? resA : resB;
      const loser = !resA.registered ? resA : resB;
      const loserClient = !resA.registered ? clientA : clientB;
      const loserRegId = !resA.registered ? regIdA : regIdB;

      expect(winner.registered).toBe(true);
      expect(winner.conflict).toBe(false);

      expect(loser.registered).toBe(false);
      expect(loser.conflict).toBe(true);
      expect(loser.conflictType).toBe('DUPLICATE_FILE');

      // Losing transaction continues and creates review case without aborting
      const revCaseId = crypto.randomUUID();
      const verifResultId = crypto.randomUUID();
      const verifReqId = crypto.randomUUID();

      await loserClient.query(
        `INSERT INTO verification_requests (id, registration_id, event_id, status) VALUES ($1, $2, $3, 'COMPLETED')`,
        [verifReqId, loserRegId, testEventId]
      );
      await loserClient.query(
        `INSERT INTO verification_results (id, request_id, registration_id, decision, confidence_score, risk_score)
         VALUES ($1, $2, $3, 'REVIEW', 0.60, 0.40)`,
        [verifResultId, verifReqId, loserRegId]
      );
      await loserClient.query(
        `INSERT INTO review_cases (id, result_id, registration_id, event_id, priority, status)
         VALUES ($1, $2, $3, $4, 'HIGH', 'OPEN')`,
        [revCaseId, verifResultId, loserRegId, testEventId]
      );

      await clientA.query('COMMIT');
      await clientB.query('COMMIT');

      // Verify database consistency
      const docRows = await pool.query(
        `SELECT registered_name, document_file_hash FROM identity_registry WHERE event_id = $1 AND document_file_hash = $2`,
        [testEventId, sharedDocHash]
      );
      expect(docRows.rows.length).toBe(1);
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  test('6. Real PostgreSQL Concurrency: Two independent transactions race to resolve the same review case (APPROVED vs REJECTED) with optimistic locking', async () => {
    const clientA = await pool.connect();
    const clientB = await pool.connect();

    const regId = crypto.randomUUID();
    const verifReqId = crypto.randomUUID();
    const verifResultId = crypto.randomUUID();
    const reviewCaseId = crypto.randomUUID();

    try {
      // 1. Setup initial state: registration PENDING, review_case OPEN
      await pool.query(
        `INSERT INTO registrations (id, event_id, registration_name, status) VALUES ($1, $2, 'Case Contestant', 'PENDING')`,
        [regId, testEventId]
      );
      await pool.query(
        `INSERT INTO verification_requests (id, registration_id, event_id, status) VALUES ($1, $2, $3, 'COMPLETED')`,
        [verifReqId, regId, testEventId]
      );
      await pool.query(
        `INSERT INTO verification_results (id, request_id, registration_id, decision, confidence_score, risk_score)
         VALUES ($1, $2, $3, 'REVIEW', 0.50, 0.50)`,
        [verifResultId, verifReqId, regId]
      );
      await pool.query(
        `INSERT INTO review_cases (id, result_id, registration_id, event_id, priority, status)
         VALUES ($1, $2, $3, $4, 'HIGH', 'OPEN')`,
        [reviewCaseId, verifResultId, regId, testEventId]
      );

      // 2. Both transactions start
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      // Helper for atomic review resolution inside a transaction client
      const resolveCase = async (client, targetStatus, reviewerNotes, resolutionReason) => {
        // Optimistic locking update
        const updRes = await client.query(
          `UPDATE review_cases
           SET status = $1, reviewer_notes = $2, resolution_reason = $3, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = $4 AND status = 'OPEN'`,
          [targetStatus, reviewerNotes, resolutionReason, reviewCaseId]
        );

        if (updRes.rowCount === 0) {
          // Conflict! Rollback and return conflict
          await client.query('ROLLBACK');
          return { success: false, conflict: true };
        }

        // Synchronize registration status in SAME transaction
        const regStatus = targetStatus === 'APPROVED' ? 'VERIFIED' : 'REJECTED';
        await client.query(
          `UPDATE registrations SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [regStatus, regId]
        );

        // Write audit log in SAME transaction
        const auditId = crypto.randomUUID();
        await client.query(
          `INSERT INTO audit_logs (id, organization_id, actor_id, actor_role, action, entity_type, entity_id, event_id)
           VALUES ($1, $2, 'rev-actor', 'reviewer', $3, 'REVIEW_CASE', $4, $5)`,
          [auditId, testOrgId, 'REVIEW_CASE_' + targetStatus, reviewCaseId, testEventId]
        );

        await client.query('COMMIT');
        return { success: true, conflict: false };
      };

      // 3. Concurrently fire both resolutions
      const [resA, resB] = await Promise.all([
        resolveCase(clientA, 'APPROVED', 'Manual operator approved', 'Valid photo ID confirmed'),
        resolveCase(clientB, 'REJECTED', 'Manual operator rejected', 'Document expired'),
      ]);

      // Exactly ONE succeeds, the other conflicts
      const results = [resA, resB];
      const successCount = results.filter(r => r.success).length;
      const conflictCount = results.filter(r => r.conflict).length;

      expect(successCount).toBe(1);
      expect(conflictCount).toBe(1);

      const winningStatus = resA.success ? 'APPROVED' : 'REJECTED';
      const winningRegStatus = winningStatus === 'APPROVED' ? 'VERIFIED' : 'REJECTED';

      // 4. Assert database consistency
      // Review case has winning status
      const caseCheck = await pool.query(
        `SELECT status, reviewer_notes, resolution_reason FROM review_cases WHERE id = $1`,
        [reviewCaseId]
      );
      expect(caseCheck.rows.length).toBe(1);
      expect(caseCheck.rows[0].status).toBe(winningStatus);

      // Registration has winning status
      const regCheck = await pool.query(
        `SELECT status FROM registrations WHERE id = $1`,
        [regId]
      );
      expect(regCheck.rows.length).toBe(1);
      expect(regCheck.rows[0].status).toBe(winningRegStatus);

      // Audit logs has exactly ONE resolution log matching winning decision
      const auditCheck = await pool.query(
        `SELECT action FROM audit_logs WHERE entity_id = $1`,
        [reviewCaseId]
      );
      expect(auditCheck.rows.length).toBe(1);
      expect(auditCheck.rows[0].action).toBe('REVIEW_CASE_' + winningStatus);
    } finally {
      clientA.release();
      clientB.release();
    }
  });
});

