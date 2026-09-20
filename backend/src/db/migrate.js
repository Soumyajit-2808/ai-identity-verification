/**
 * Database Migration & Seeding Runner
 * Executes schema.sql and creates default organizations, events, and admin operator.
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { randomUUID: uuidv4 } = require('crypto');
const { query, initDb } = require('./connection');

async function runMigrations() {
  initDb();
  console.log('[Migration] Running database migrations...');

  const candidatePaths = [
    process.env.SCHEMA_PATH,
    path.resolve(__dirname, '../../../database/schema.sql'),
    path.resolve(__dirname, '../../database/schema.sql'),
    path.resolve(__dirname, '../database/schema.sql'),
    path.resolve(__dirname, './schema.sql'),
  ].filter(Boolean);

  let schemaSql = null;
  let resolvedPath = null;
  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      schemaSql = fs.readFileSync(candidate, 'utf-8');
      resolvedPath = candidate;
      break;
    }
  }

  if (!schemaSql) {
    throw new Error(`[Migration Error] schema.sql could not be found. Checked paths: ${candidatePaths.join(', ')}`);
  }

  console.log(`[Migration] Loaded schema from: ${resolvedPath}`);

  // Strip single-line comments and execute
  const cleanSql = schemaSql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');

  const { exec, query, getDbType } = require('./connection');
  const isPostgres = getDbType() === 'postgres';

  // If table already exists with legacy duplicate file hashes, deduplicate before applying unique index
  try {
    const tableCheckSql = isPostgres
      ? `SELECT table_name FROM information_schema.tables WHERE table_name = 'identity_registry'`
      : `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'identity_registry'`;
    const checkRes = await query(tableCheckSql);
    if (checkRes.rows && checkRes.rows.length > 0) {
      await query(`
        DELETE FROM identity_registry
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT MIN(id) AS id
            FROM identity_registry
            GROUP BY event_id, document_file_hash
          ) AS keep_rows
        )
      `);
    }
  } catch (_tableNotYetExisting) {
    // Expected on clean installation when table does not exist yet
  }

  await exec(cleanSql);

  // Incremental migrations for existing installations where tables already existed
  try {
    const auditColsRes = isPostgres
      ? await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'organization_id'`)
      : await query(`PRAGMA table_info(audit_logs)`);
    const hasOrgCol = isPostgres
      ? auditColsRes.rows.length > 0
      : auditColsRes.rows.some(r => r.name === 'organization_id');
    if (!hasOrgCol) {
      await query(`ALTER TABLE audit_logs ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE`);
      console.log('[Migration] Added missing organization_id column to audit_logs.');
    }
  } catch (_auditColErr) {}

  try {
    const docColsRes = isPostgres
      ? await query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'identity_documents' AND column_name = 'event_id'`)
      : await query(`PRAGMA table_info(identity_documents)`);
    const hasEventCol = isPostgres
      ? docColsRes.rows.length > 0
      : docColsRes.rows.some(r => r.name === 'event_id');
    if (!hasEventCol) {
      await query(`ALTER TABLE identity_documents ADD COLUMN event_id TEXT REFERENCES events(id) ON DELETE CASCADE`);
      console.log('[Migration] Added missing event_id column to identity_documents.');
    }
  } catch (_docColErr) {}

  console.log('[Migration] Schema tables and indexes verified successfully.');

  // Seed default organization and event if not present
  await seedDefaults();
}

async function seedDefaults() {
  // 1. Default Organization
  const orgCheck = await query('SELECT id FROM organizations WHERE slug = $1', ['default-org']);
  let orgId;
  if (orgCheck.rows.length === 0) {
    orgId = uuidv4();
    await query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
      [orgId, 'National Hackathon Federation', 'default-org']
    );
    console.log('[Migration] Seeded default organization: National Hackathon Federation');
  } else {
    orgId = orgCheck.rows[0].id;
  }

  // 2. Default Event
  const eventCheck = await query('SELECT id FROM events WHERE code = $1', ['HACK2026']);
  let eventId;
  if (eventCheck.rows.length === 0) {
    eventId = uuidv4();
    await query(
      `INSERT INTO events (id, organization_id, name, code, description, min_age, max_age, allowed_id_types, require_selfie, strict_name_matching)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        eventId,
        orgId,
        'AI Build Challenge 2026',
        'HACK2026',
        'Annual Flagship AI & Emerging Tech Hackathon. Requires 18+ age eligibility and valid photo ID.',
        18,
        100,
        JSON.stringify(['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'STUDENT_ID', 'NATIONAL_ID']),
        0, // Optional selfie by default
        0  // Standard fuzzy name matching
      ]
    );
    console.log('[Migration] Seeded default event: AI Build Challenge 2026 (HACK2026)');
  } else {
    eventId = eventCheck.rows[0].id;
  }

  // 3. Admin User (Demo / Local default credentials)
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@verifyid.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.SEED_ADMIN_PASSWORD || process.env.SEED_ADMIN_PASSWORD === 'Admin@12345') {
      throw new Error('[Fatal Security Error] Production mode requires an explicit, non-default SEED_ADMIN_PASSWORD environment variable.');
    }
  }

  const adminCheck = await query('SELECT id FROM users WHERE email = $1', [adminEmail]);
  if (adminCheck.rows.length === 0) {
    const adminId = uuidv4();
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(adminPassword, salt);
    await query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminId, orgId, adminEmail, passwordHash, 'System Administrator', 'admin']
    );
    console.log(`[Migration] Seeded admin user: ${adminEmail}`);
  }

  // 4. Reviewer User (Demo / Local default credentials)
  const reviewerEmail = process.env.SEED_REVIEWER_EMAIL || 'reviewer@verifyid.local';
  const reviewerPassword = process.env.SEED_REVIEWER_PASSWORD || 'Reviewer@12345';
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.SEED_REVIEWER_PASSWORD || process.env.SEED_REVIEWER_PASSWORD === 'Reviewer@12345') {
      throw new Error('[Fatal Security Error] Production mode requires an explicit, non-default SEED_REVIEWER_PASSWORD environment variable.');
    }
  }

  const reviewerCheck = await query('SELECT id FROM users WHERE email = $1', [reviewerEmail]);
  if (reviewerCheck.rows.length === 0) {
    const reviewerId = uuidv4();
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(reviewerPassword, salt);
    await query(
      `INSERT INTO users (id, organization_id, email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [reviewerId, orgId, reviewerEmail, passwordHash, 'Chief Verification Officer', 'reviewer']
    );
    console.log(`[Migration] Seeded default reviewer user: ${reviewerEmail}`);
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('[Migration] Migration process complete.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Migration] Migration failed:', err);
      process.exit(1);
    });
}

module.exports = { runMigrations };
