/**
 * Review Cases Repository
 * Manages manual operator review workflows (OPEN, IN_REVIEW, APPROVED, REJECTED, ESCALATED).
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const { query } = require('../connection');
const { maskIdNumber } = require('./identityRegistryRepository');

async function createReviewCase({
  resultId,
  registrationId,
  eventId,
  priority = 'MEDIUM',
  reviewerNotes = null,
}, dbClient = null) {
  const id = uuidv4();
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;

  await runner(
    `INSERT INTO review_cases (
       id, result_id, registration_id, event_id, status, priority, reviewer_notes
     ) VALUES ($1, $2, $3, $4, 'OPEN', $5, $6)`,
    [id, resultId, registrationId, eventId, priority, reviewerNotes]
  );

  return { id, resultId, registrationId, status: 'OPEN', priority };
}

async function listReviewCases({ eventId = null, status = null, organizationId = null, limit = 50 } = {}) {
  let queryText = `
    SELECT rc.id, rc.result_id, rc.registration_id, rc.event_id, rc.status,
           rc.priority, rc.assigned_to, rc.reviewer_notes, rc.resolution_reason,
           rc.created_at, rc.updated_at, rc.resolved_at,
           reg.registration_name, reg.email,
           ev.name as event_name, ev.code as event_code, ev.organization_id,
           vr.decision as original_decision, vr.confidence_score, vr.summary_reason,
           u.full_name as assigned_to_name
    FROM review_cases rc
    JOIN registrations reg ON rc.registration_id = reg.id
    JOIN events ev ON rc.event_id = ev.id
    JOIN verification_results vr ON rc.result_id = vr.id
    LEFT JOIN users u ON rc.assigned_to = u.id
    WHERE 1=1
  `;
  const params = [];
  let pIdx = 1;

  if (organizationId) {
    queryText += ` AND ev.organization_id = $${pIdx++}`;
    params.push(organizationId);
  }

  if (eventId) {
    queryText += ` AND rc.event_id = $${pIdx++}`;
    params.push(eventId);
  }

  if (status) {
    queryText += ` AND rc.status = $${pIdx++}`;
    params.push(status);
  }

  queryText += ` ORDER BY 
    CASE rc.priority
      WHEN 'URGENT' THEN 1
      WHEN 'HIGH' THEN 2
      WHEN 'MEDIUM' THEN 3
      ELSE 4
    END, rc.created_at DESC LIMIT $${pIdx}`;
  params.push(limit);

  const res = await query(queryText, params);
  return res.rows;
}

async function getReviewCaseById(id, organizationId = null, dbClient = null) {
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;
  let queryText = `
    SELECT rc.id, rc.result_id, rc.registration_id, rc.event_id, rc.status,
           rc.priority, rc.assigned_to, rc.reviewer_notes, rc.resolution_reason,
           rc.created_at, rc.updated_at, rc.resolved_at,
           reg.registration_name, reg.email, reg.phone,
           ev.name as event_name, ev.code as event_code, ev.organization_id,
           vr.decision as original_decision, vr.confidence_score, vr.summary_reason,
           vr.extracted_identity_json,
           u.full_name as assigned_to_name
    FROM review_cases rc
    JOIN registrations reg ON rc.registration_id = reg.id
    JOIN events ev ON rc.event_id = ev.id
    JOIN verification_results vr ON rc.result_id = vr.id
    LEFT JOIN users u ON rc.assigned_to = u.id
    WHERE rc.id = $1
  `;
  const params = [id];
  if (organizationId) {
    queryText += ` AND ev.organization_id = $2`;
    params.push(organizationId);
  }

  const res = await runner(queryText, params);

  if (res.rows.length === 0) return null;
  const row = res.rows[0];

  // Fetch signals
  const signalsRes = await runner(
    `SELECT signal_type, status, score, raw_details_json, reason
     FROM verification_signals
     WHERE result_id = $1
     ORDER BY created_at ASC`,
    [row.result_id]
  );

  // Fetch document metadata (safely omit storage_path from API response)
  const docsRes = await runner(
    `SELECT id, document_type, file_hash, original_filename, mime_type, file_size_bytes, created_at
     FROM identity_documents
     WHERE registration_id = $1`,
    [row.registration_id]
  );

  const extracted = JSON.parse(row.extracted_identity_json || '{}');
  if (extracted.id_number) {
    if (!extracted.id_number_masked) extracted.id_number_masked = maskIdNumber(extracted.id_number);
    delete extracted.id_number;
  }
  const { extracted_identity_json, ...rest } = row;

  return {
    ...rest,
    extracted_identity: extracted,
    signals: signalsRes.rows.map(s => ({
      signal_type: s.signal_type,
      signalType: s.signal_type,
      status: s.status,
      score: s.score,
      reason: s.reason,
      details: JSON.parse(s.raw_details_json || '{}'),
    })),
    documents: docsRes.rows,
  };
}

async function updateReviewCase(id, { status, assignedTo, reviewerNotes, resolutionReason, expectedStatus }, dbClient = null) {
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;
  const updates = ['updated_at = CURRENT_TIMESTAMP'];
  const params = [id];
  let pIdx = 2;

  if (status !== undefined) {
    updates.push(`status = $${pIdx++}`);
    params.push(status);
    if (['APPROVED', 'REJECTED'].includes(status)) {
      updates.push(`resolved_at = CURRENT_TIMESTAMP`);
    } else {
      updates.push(`resolved_at = NULL`);
    }
  }
  if (assignedTo !== undefined) {
    updates.push(`assigned_to = $${pIdx++}`);
    params.push(assignedTo);
  }
  if (reviewerNotes !== undefined) {
    updates.push(`reviewer_notes = $${pIdx++}`);
    params.push(reviewerNotes);
  }
  if (resolutionReason !== undefined) {
    updates.push(`resolution_reason = $${pIdx++}`);
    params.push(resolutionReason);
  }

  let whereClause = 'WHERE id = $1';
  if (expectedStatus) {
    whereClause += ` AND status = $${pIdx++}`;
    params.push(expectedStatus);
  }

  const result = await runner(
    `UPDATE review_cases SET ${updates.join(', ')} ${whereClause}`,
    params
  );

  const rowCount = result && result.rowCount !== undefined
    ? result.rowCount
    : (result && result.changes !== undefined ? result.changes : 0);

  if (rowCount === 0) {
    return { rowCount: 0, updated: false, status: null };
  }

  const updatedCase = await getReviewCaseById(id, null, dbClient);
  return {
    ...updatedCase,
    rowCount,
    updated: true,
  };
}

module.exports = {
  createReviewCase,
  listReviewCases,
  getReviewCaseById,
  updateReviewCase,
};

