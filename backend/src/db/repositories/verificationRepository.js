/**
 * Verification Repository
 * Handles verification requests, persisted decisions, and granular evidence signals.
 */

const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();
const { query } = require('../connection');
const { maskIdNumber } = require('./identityRegistryRepository');

async function createVerificationRequest({ registrationId, eventId, requestIp = null, userAgent = null }, dbClient = null) {
  const id = uuidv4();
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;
  await runner(
    `INSERT INTO verification_requests (id, registration_id, event_id, status, request_ip, user_agent)
     VALUES ($1, $2, $3, 'PROCESSING', $4, $5)`,
    [id, registrationId, eventId, requestIp, userAgent]
  );
  return { id, registrationId, eventId, status: 'PROCESSING' };
}

async function saveVerificationResult({
  requestId,
  registrationId,
  decision,
  confidenceScore,
  riskScore = 0.0,
  evidenceScore = 0.0,
  summaryReason,
  extractedIdentity,
}, dbClient = null) {
  const id = uuidv4();
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;

  // Privacy protection: never persist raw government ID numbers
  const sanitizedIdentity = { ...(extractedIdentity || {}) };
  if (sanitizedIdentity.id_number) {
    if (!sanitizedIdentity.id_number_masked) {
      sanitizedIdentity.id_number_masked = maskIdNumber(sanitizedIdentity.id_number);
    }
    delete sanitizedIdentity.id_number;
  }

  await runner(
    `INSERT INTO verification_results (
       id, request_id, registration_id, decision, confidence_score,
       risk_score, evidence_score, summary_reason, extracted_identity_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      requestId,
      registrationId,
      decision,
      confidenceScore,
      riskScore,
      evidenceScore,
      summaryReason,
      JSON.stringify(sanitizedIdentity),
    ]
  );

  // Mark request as completed
  await runner(
    `UPDATE verification_requests SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [requestId]
  );

  return { id, requestId, decision, confidenceScore, summaryReason };
}

async function saveVerificationSignals(resultId, signalsArray, dbClient = null) {
  const runner = dbClient ? dbClient.query.bind(dbClient) : query;

  for (const signal of signalsArray) {
    const id = uuidv4();
    const sigType = signal.signal_type || signal.signalType;
    await runner(
      `INSERT INTO verification_signals (
         id, result_id, signal_type, status, score, raw_details_json, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        resultId,
        sigType,
        signal.status,
        signal.score !== undefined ? signal.score : null,
        signal.details ? JSON.stringify(signal.details) : null,
        signal.reason || '',
      ]
    );
  }
}

async function getVerificationHistory({ eventId = null, organizationId = null, limit = 50 } = {}) {
  let queryText = `
    SELECT vr.id as result_id, vr.decision, vr.confidence_score, vr.risk_score,
           vr.summary_reason, vr.extracted_identity_json, vr.created_at,
           req.id as request_id, req.status as request_status,
           reg.id as registration_id, reg.registration_name, reg.email,
           ev.id as event_id, ev.name as event_name, ev.code as event_code, ev.organization_id,
           rc.id as review_case_id, rc.status as review_case_status
    FROM verification_results vr
    JOIN verification_requests req ON vr.request_id = req.id
    JOIN registrations reg ON vr.registration_id = reg.id
    JOIN events ev ON req.event_id = ev.id
    LEFT JOIN review_cases rc ON vr.id = rc.result_id
    WHERE 1=1
  `;
  const params = [];
  let pIdx = 1;

  if (organizationId) {
    queryText += ` AND ev.organization_id = $${pIdx++} `;
    params.push(organizationId);
  }

  if (eventId) {
    queryText += ` AND ev.id = $${pIdx++} `;
    params.push(eventId);
  }

  queryText += ` ORDER BY vr.created_at DESC LIMIT $${pIdx}`;
  params.push(limit);

  const res = await query(queryText, params);
  return res.rows.map(row => {
    const extracted = JSON.parse(row.extracted_identity_json || '{}');
    if (extracted.id_number) {
      if (!extracted.id_number_masked) extracted.id_number_masked = maskIdNumber(extracted.id_number);
      delete extracted.id_number;
    }
    const { extracted_identity_json, ...rest } = row;
    return {
      ...rest,
      extracted_identity: extracted,
    };
  });
}

async function getVerificationDetails(requestId, organizationId = null) {
  let queryText = `
    SELECT vr.id as result_id, vr.decision, vr.confidence_score, vr.risk_score,
           vr.evidence_score, vr.summary_reason, vr.extracted_identity_json, vr.created_at,
           req.id as request_id, req.status as request_status, req.request_ip,
           reg.id as registration_id, reg.registration_name, reg.email, reg.phone,
           ev.id as event_id, ev.name as event_name, ev.code as event_code, ev.organization_id,
           ev.min_age, ev.max_age
    FROM verification_results vr
    JOIN verification_requests req ON vr.request_id = req.id
    JOIN registrations reg ON vr.registration_id = reg.id
    JOIN events ev ON req.event_id = ev.id
    WHERE req.id = $1
  `;
  const params = [requestId];
  if (organizationId) {
    queryText += ` AND ev.organization_id = $2`;
    params.push(organizationId);
  }

  const res = await query(queryText, params);
  if (res.rows.length === 0) return null;
  const result = res.rows[0];

  // Fetch signals
  const signalsRes = await query(
    `SELECT signal_type, status, score, raw_details_json, reason
     FROM verification_signals
     WHERE result_id = $1
     ORDER BY created_at ASC`,
    [result.result_id]
  );

  const signals = signalsRes.rows.map(s => ({
    signalType: s.signal_type,
    status: s.status,
    score: s.score,
    reason: s.reason,
    details: JSON.parse(s.raw_details_json || '{}'),
  }));

  // Fetch documents (safely omit storage_path from API response)
  const docsRes = await query(
    `SELECT id, document_type, file_hash, original_filename, mime_type, file_size_bytes, created_at
     FROM identity_documents
     WHERE registration_id = $1`,
    [result.registration_id]
  );

  const extracted = JSON.parse(result.extracted_identity_json || '{}');
  if (extracted.id_number) {
    if (!extracted.id_number_masked) extracted.id_number_masked = maskIdNumber(extracted.id_number);
    delete extracted.id_number;
  }
  const { extracted_identity_json, ...rest } = result;

  return {
    ...rest,
    extracted_identity: extracted,
    signals,
    documents: docsRes.rows,
  };
}

module.exports = {
  createVerificationRequest,
  saveVerificationResult,
  saveVerificationSignals,
  getVerificationHistory,
  getVerificationDetails,
};
