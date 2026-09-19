/**
 * Registrations Repository
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const { query } = require('../connection');

async function createRegistration({ eventId, registrationName, email = null, phone = null }, dbClient = null) {
  const id = uuidv4();
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;
  await runner(
    `INSERT INTO registrations (id, event_id, registration_name, email, phone, status)
     VALUES ($1, $2, $3, $4, $5, 'PENDING')`,
    [id, eventId, registrationName, email, phone]
  );
  return { id, eventId, registrationName, email, phone, status: 'PENDING' };
}

async function getRegistrationById(id) {
  const res = await query(
    `SELECT r.id, r.event_id, r.registration_name, r.email, r.phone, r.status, r.created_at,
            e.name as event_name, e.code as event_code
     FROM registrations r
     JOIN events e ON r.event_id = e.id
     WHERE r.id = $1`,
    [id]
  );
  return res.rows.length > 0 ? res.rows[0] : null;
}

async function updateRegistrationStatus(id, status, dbClient = null) {
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;
  await runner(
    `UPDATE registrations SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [status, id]
  );
}

module.exports = {
  createRegistration,
  getRegistrationById,
  updateRegistrationStatus,
};
