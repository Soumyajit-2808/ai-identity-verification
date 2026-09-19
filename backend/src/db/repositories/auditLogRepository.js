/**
 * Immutable Audit Log Repository
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const { query } = require('../connection');

async function logEvent({
  actorId = null,
  actorRole = null,
  action,
  entityType,
  entityId,
  eventId = null,
  details = null,
  ipAddress = null,
}, dbClient = null) {
  const id = uuidv4();
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;

  await runner(
    `INSERT INTO audit_logs (
       id, actor_id, actor_role, action, entity_type, entity_id, event_id, details_json, ip_address
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      actorId,
      actorRole,
      action,
      entityType,
      entityId,
      eventId,
      details ? JSON.stringify(details) : null,
      ipAddress,
    ]
  );

  return { id, action, entityType, entityId };
}

async function listAuditLogs({ entityType = null, entityId = null, organizationId = null, limit = 100 } = {}) {
  let queryText = `
    SELECT al.id, al.actor_id, al.actor_role, al.action, al.entity_type, al.entity_id, al.event_id,
           al.details_json, al.ip_address, al.created_at
    FROM audit_logs al
    LEFT JOIN events ev ON al.event_id = ev.id
    LEFT JOIN users u ON al.actor_id = u.id
    WHERE 1=1
  `;
  const params = [];
  let pIdx = 1;

  if (organizationId) {
    queryText += ` AND (ev.organization_id = $${pIdx} OR u.organization_id = $${pIdx})`;
    params.push(organizationId);
    pIdx++;
  }

  if (entityType) {
    queryText += ` AND al.entity_type = $${pIdx++}`;
    params.push(entityType);
  }
  if (entityId) {
    queryText += ` AND al.entity_id = $${pIdx++}`;
    params.push(entityId);
  }

  queryText += ` ORDER BY al.created_at DESC LIMIT $${pIdx}`;
  params.push(limit);

  const res = await query(queryText, params);
  return res.rows.map(row => ({
    ...row,
    details: JSON.parse(row.details_json || '{}'),
  }));
}

module.exports = {
  logEvent,
  listAuditLogs,
};
