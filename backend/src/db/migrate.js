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

  const { exec } = require('./connection');
  await exec(cleanSql);

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
        JSON.stringify(['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'STUDENT_ID']),
        0, // Optional selfie by default
        0  // Standard fuzzy name matching
      ]
    );
    console.log('[Migration] Seeded default event: AI Build Challenge 2026 (HACK2026)');
  } else {
    eventId = eventCheck.rows[0].id;
  }

  // 3. Default Admin User
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@verifyid.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
  if (process.env.NODE_ENV === 'production' && adminPassword === 'Admin@12345') {
    console.warn('[Security Warning] Default seed admin password is being used in production. Set SEED_ADMIN_PASSWORD in your environment.');
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
    console.log(`[Migration] Seeded default admin user: ${adminEmail}`);
  }

  // 4. Default Reviewer User
  const reviewerEmail = process.env.SEED_REVIEWER_EMAIL || 'reviewer@verifyid.local';
  const reviewerPassword = process.env.SEED_REVIEWER_PASSWORD || 'Reviewer@12345';
  if (process.env.NODE_ENV === 'production' && reviewerPassword === 'Reviewer@12345') {
    console.warn('[Security Warning] Default seed reviewer password is being used in production. Set SEED_REVIEWER_PASSWORD in your environment.');
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
