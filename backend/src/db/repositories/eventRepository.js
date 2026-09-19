/**
 * Events & Verification Policy Repository
 */

const { query } = require('../connection');

async function getEventByCode(code) {
  const res = await query(
    `SELECT id, organization_id, name, code, description, min_age, max_age,
            allowed_id_types, require_selfie, strict_name_matching, is_active, created_at
     FROM events
     WHERE code = $1 AND is_active = 1
     LIMIT 1`,
    [code]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    ...row,
    allowed_id_types: JSON.parse(row.allowed_id_types || '[]'),
    require_selfie: Boolean(row.require_selfie),
    strict_name_matching: Boolean(row.strict_name_matching),
  };
}

async function getEventById(id) {
  const res = await query(
    `SELECT id, organization_id, name, code, description, min_age, max_age,
            allowed_id_types, require_selfie, strict_name_matching, is_active, created_at
     FROM events
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    ...row,
    allowed_id_types: JSON.parse(row.allowed_id_types || '[]'),
    require_selfie: Boolean(row.require_selfie),
    strict_name_matching: Boolean(row.strict_name_matching),
  };
}

async function listEvents() {
  const res = await query(
    `SELECT id, organization_id, name, code, description, min_age, max_age,
            allowed_id_types, require_selfie, strict_name_matching, is_active, created_at
     FROM events
     ORDER BY created_at DESC`
  );
  return res.rows.map(row => ({
    ...row,
    allowed_id_types: JSON.parse(row.allowed_id_types || '[]'),
    require_selfie: Boolean(row.require_selfie),
    strict_name_matching: Boolean(row.strict_name_matching),
  }));
}

async function updateEventPolicy(id, { minAge, maxAge, allowedIdTypes, requireSelfie, strictNameMatching }) {
  const updates = [];
  const params = [id];
  let pIdx = 2;

  if (minAge !== undefined) {
    updates.push(`min_age = $${pIdx++}`);
    params.push(Number(minAge));
  }
  if (maxAge !== undefined) {
    updates.push(`max_age = $${pIdx++}`);
    params.push(Number(maxAge));
  }
  if (allowedIdTypes !== undefined) {
    updates.push(`allowed_id_types = $${pIdx++}`);
    params.push(JSON.stringify(allowedIdTypes));
  }
  if (requireSelfie !== undefined) {
    updates.push(`require_selfie = $${pIdx++}`);
    params.push(requireSelfie ? 1 : 0);
  }
  if (strictNameMatching !== undefined) {
    updates.push(`strict_name_matching = $${pIdx++}`);
    params.push(strictNameMatching ? 1 : 0);
  }

  if (updates.length === 0) return getEventById(id);

  updates.push(`updated_at = CURRENT_TIMESTAMP`);

  await query(
    `UPDATE events SET ${updates.join(', ')} WHERE id = $1`,
    params
  );
  return getEventById(id);
}

module.exports = {
  getEventByCode,
  getEventById,
  listEvents,
  updateEventPolicy,
};
