/**
 * Review Case & Operator Workflow Routes
 */

const express = require('express');
const {
  listReviewCases,
  getReviewCaseById,
  updateReviewCase,
} = require('../db/repositories/reviewCaseRepository');
const { updateRegistrationStatus } = require('../db/repositories/registrationRepository');
const { logEvent } = require('../db/repositories/auditLogRepository');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDocumentBuffer } = require('../storage/documentStorage');
const { transaction, query } = require('../db/connection');

const router = express.Router();
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get(['/review-cases', '/reviews'], requireAuth, requireRole(['reviewer', 'admin']), async (req, res, next) => {
  try {
    const { eventId, status, limit } = req.query;
    const cases = await listReviewCases({
      eventId: eventId || null,
      status: status || null,
      organizationId: req.user.organization_id || null,
      limit: limit ? Number(limit) : 50,
    });
    res.json({ success: true, count: cases.length, cases, data: cases });
  } catch (err) {
    next(err);
  }
});

router.get(['/review-cases/:id', '/reviews/:id'], requireAuth, requireRole(['reviewer', 'admin']), async (req, res, next) => {
  try {
    if (!uuidRegex.test(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid review case ID format.' });
    }
    const reviewCase = await getReviewCaseById(req.params.id, req.user.organization_id || null);
    if (!reviewCase) {
      return res.status(404).json({ success: false, error: 'Review case not found or unauthorized.' });
    }
    res.json({ success: true, case: reviewCase, data: reviewCase });
  } catch (err) {
    next(err);
  }
});

router.patch(['/review-cases/:id', '/reviews/:id'], requireAuth, requireRole(['reviewer', 'admin']), async (req, res, next) => {
  try {
    if (!uuidRegex.test(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid review case ID format.' });
    }
    const { status, reviewerNotes, resolutionReason, expectedStatus } = req.body;
    const validStatuses = ['OPEN', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ESCALATED'];

    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
    }

    let updatedCase = null;

    // Execute review case update, registration status sync, and audit logging in one atomic transaction
    await transaction(async (txClient) => {
      const currentCase = await getReviewCaseById(req.params.id, req.user.organization_id || null, txClient);
      if (!currentCase) {
        const notFoundErr = new Error('Review case not found or unauthorized.');
        notFoundErr.statusCode = 404;
        throw notFoundErr;
      }

      // Require resolutionReason when marking case APPROVED or REJECTED
      if (['APPROVED', 'REJECTED'].includes(status)) {
        if (!resolutionReason || typeof resolutionReason !== 'string' || !resolutionReason.trim()) {
          const badReqErr = new Error('A valid resolution reason is required when approving or rejecting a review case.');
          badReqErr.statusCode = 400;
          throw badReqErr;
        }
      }

      // Concurrency / optimistic locking check if expectedStatus provided
      if (expectedStatus && currentCase.status !== expectedStatus) {
        const conflictErr = new Error(`Review case status conflict: current status is '${currentCase.status}' (expected '${expectedStatus}').`);
        conflictErr.statusCode = 409;
        conflictErr.code = 'CASE_STATUS_CONFLICT';
        throw conflictErr;
      }

      // Guard against modifying already resolved cases without administrator privilege
      const isAlreadyResolved = ['APPROVED', 'REJECTED'].includes(currentCase.status);
      if (isAlreadyResolved && req.user.role !== 'admin') {
        const adminErr = new Error(`Case is already resolved as '${currentCase.status}' and cannot be modified by reviewer. Administrator override required.`);
        adminErr.statusCode = 409;
        adminErr.code = 'CASE_ALREADY_RESOLVED';
        throw adminErr;
      }

      // Optimistic lock condition in SQL
      const lockStatus = expectedStatus || (req.user.role !== 'admin' ? currentCase.status : null);
      const updateResult = await updateReviewCase(req.params.id, {
        status,
        assignedTo: req.user.id,
        reviewerNotes,
        resolutionReason,
        expectedStatus: lockStatus,
      }, txClient);

      if (!updateResult.updated) {
        const raceErr = new Error(`Review case status conflict: case was modified concurrently.`);
        raceErr.statusCode = 409;
        raceErr.code = 'CASE_STATUS_CONFLICT';
        throw raceErr;
      }

      // Synchronize registration status with review case disposition in the SAME transaction
      if (status === 'APPROVED') {
        await updateRegistrationStatus(currentCase.registration_id, 'VERIFIED', txClient);
      } else if (status === 'REJECTED') {
        await updateRegistrationStatus(currentCase.registration_id, 'REJECTED', txClient);
      } else if (['OPEN', 'IN_REVIEW', 'ESCALATED'].includes(status)) {
        await updateRegistrationStatus(currentCase.registration_id, 'REVIEW_REQUIRED', txClient);
      }

      // Log audit event in the SAME transaction
      await logEvent({
        organizationId: currentCase.organization_id,
        actorId: req.user.id,
        actorRole: req.user.role,
        action: `REVIEW_CASE_${status}`,
        entityType: 'REVIEW_CASE',
        entityId: req.params.id,
        eventId: currentCase.event_id,
        details: {
          previousStatus: currentCase.status,
          newStatus: status,
          reviewerNotes,
          resolutionReason,
        },
        ipAddress: req.ip,
      }, txClient);

      updatedCase = updateResult;
    });

    res.json({ success: true, case: updatedCase });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        error: err.message,
        code: err.code,
      });
    }
    next(err);
  }
});

// Secure Document Retrieval for authorized operators
router.get('/documents/:id/file', requireAuth, requireRole(['reviewer', 'admin']), async (req, res, next) => {
  try {
    if (!uuidRegex.test(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid document ID format.' });
    }
    const docRes = await query(
      `SELECT d.*, ev.organization_id
       FROM identity_documents d
       JOIN registrations reg ON d.registration_id = reg.id
       JOIN events ev ON reg.event_id = ev.id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (docRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Document not found.' });
    }

    const doc = docRes.rows[0];
    if (doc.organization_id && req.user.organization_id && doc.organization_id !== req.user.organization_id) {
      return res.status(403).json({ success: false, error: 'Access denied: document belongs to another organization.' });
    }

    const buffer = await getDocumentBuffer(doc.storage_path);
    if (!buffer) {
      return res.status(404).json({ success: false, error: 'Document file missing from storage.' });
    }

    await logEvent({
      organizationId: doc.organization_id,
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'DOCUMENT_VIEWED',
      entityType: 'IDENTITY_DOCUMENT',
      entityId: doc.id,
      eventId: doc.event_id || null,
      details: { documentType: doc.document_type },
      ipAddress: req.ip,
    });

    res.setHeader('Content-Type', doc.mime_type || 'image/jpeg');
    res.setHeader('Content-Disposition', `inline; filename="${doc.original_filename || 'document.jpg'}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
