/**
 * Immutable Audit Log Repository
 * Enforces strict multi-tenant scoping and authoritative organization recording.
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const { query } = require('../connection');

async function resolveAuthoritativeOrgId({
  organizationId = null,
  actorId = null,
  eventId = null,
  entityType = null,
  entityId = null,
}, runner) {
  if (organizationId) return organizationId;

  if (eventId) {
    const evRes = await runner('SELECT organization_id FROM events WHERE id = $1', [eventId]);
    if (evRes.rows && evRes.rows.length > 0 && evRes.rows[0].organization_id) {
      return evRes.rows[0].organization_id;
    }
  }

  if (entityId) {
    if (entityType === 'EVENT') {
      const evRes = await runner('SELECT organization_id FROM events WHERE id = $1', [entityId]);
      if (evRes.rows && evRes.rows.length > 0 && evRes.rows[0].organization_id) {
        return evRes.rows[0].organization_id;
      }
    } else if (entityType === 'USER') {
      const uRes = await runner('SELECT organization_id FROM users WHERE id = $1', [entityId]);
      if (uRes.rows && uRes.rows.length > 0 && uRes.rows[0].organization_id) {
        return uRes.rows[0].organization_id;
      }
    } else if (entityType === 'ORGANIZATION') {
      return entityId;
    } else if (entityType === 'REVIEW_CASE') {
      const rcRes = await runner(
        `SELECT ev.organization_id
         FROM review_cases rc
         JOIN events ev ON rc.event_id = ev.id
         WHERE rc.id = $1`,
        [entityId]
      );
      if (rcRes.rows && rcRes.rows.length > 0 && rcRes.rows[0].organization_id) {
        return rcRes.rows[0].organization_id;
      }
    } else if (entityType === 'IDENTITY_DOCUMENT') {
      const docRes = await runner(
        `SELECT ev.organization_id
         FROM identity_documents doc
         JOIN registrations reg ON doc.registration_id = reg.id
         JOIN events ev ON reg.event_id = ev.id
         WHERE doc.id = $1`,
        [entityId]
      );
      if (docRes.rows && docRes.rows.length > 0 && docRes.rows[0].organization_id) {
        return docRes.rows[0].organization_id;
      }
    } else if (entityType === 'VERIFICATION_REQUEST') {
      const reqRes = await runner(
        `SELECT ev.organization_id
         FROM verification_requests req
         JOIN events ev ON req.event_id = ev.id
         WHERE req.id = $1`,
        [entityId]
      );
      if (reqRes.rows && reqRes.rows.length > 0 && reqRes.rows[0].organization_id) {
        return reqRes.rows[0].organization_id;
      }
    }
  }

  if (actorId) {
    const uRes = await runner('SELECT organization_id FROM users WHERE id = $1', [actorId]);
    if (uRes.rows && uRes.rows.length > 0 && uRes.rows[0].organization_id) {
      return uRes.rows[0].organization_id;
    }
  }

  return null;
}

async function logEvent({
  organizationId = null,
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

  const resolvedOrgId = await resolveAuthoritativeOrgId(
    { organizationId, actorId, eventId, entityType, entityId },
    runner
  );

  await runner(
    `INSERT INTO audit_logs (
       id, organization_id, actor_id, actor_role, action, entity_type, entity_id, event_id, details_json, ip_address
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      resolvedOrgId,
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

  return { id, organizationId: resolvedOrgId, action, entityType, entityId };
}

async function listAuditLogs({ entityType = null, entityId = null, organizationId = null, limit = 100 } = {}) {
  let queryText = `
    SELECT al.id, al.organization_id, al.actor_id, al.actor_role, al.action, al.entity_type, al.entity_id, al.event_id,
           al.details_json, al.ip_address, al.created_at
    FROM audit_logs al
    WHERE 1=1
  `;
  const params = [];
  let pIdx = 1;

  if (organizationId) {
    queryText += ` AND al.organization_id = $${pIdx++}`;
    params.push(organizationId);
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
