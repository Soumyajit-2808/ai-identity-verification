/**
 * Users & Authentication Repository
 */

const { query } = require('../connection');

async function findUserByEmail(email) {
  const res = await query(
    `SELECT u.id, u.organization_id, u.email, u.password_hash, u.full_name, u.role, u.is_active,
            o.name as organization_name
     FROM users u
     LEFT JOIN organizations o ON u.organization_id = o.id
     WHERE u.email = $1 AND u.is_active = 1
     LIMIT 1`,
    [email.toLowerCase().trim()]
  );
  return res.rows.length > 0 ? res.rows[0] : null;
}

async function findUserById(id) {
  const res = await query(
    `SELECT u.id, u.organization_id, u.email, u.full_name, u.role, u.is_active,
            o.name as organization_name
     FROM users u
     LEFT JOIN organizations o ON u.organization_id = o.id
     WHERE u.id = $1
     LIMIT 1`,
    [id]
  );
  return res.rows.length > 0 ? res.rows[0] : null;
}

module.exports = {
  findUserByEmail,
  findUserById,
};
