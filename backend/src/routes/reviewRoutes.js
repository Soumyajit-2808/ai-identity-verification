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
const { query } = require('../db/connection');

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
    const { status, reviewerNotes, resolutionReason } = req.body;
    const validStatuses = ['OPEN', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ESCALATED'];

    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      });
    }

    const currentCase = await getReviewCaseById(req.params.id, req.user.organization_id || null);
    if (!currentCase) {
      return res.status(404).json({ success: false, error: 'Review case not found or unauthorized.' });
    }

    // Concurrency / optimistic locking check if expectedStatus provided
    const { expectedStatus } = req.body;
    if (expectedStatus && currentCase.status !== expectedStatus) {
      return res.status(409).json({
        success: false,
        error: `Review case status conflict: current status is '${currentCase.status}' (expected '${expectedStatus}').`,
        code: 'CASE_STATUS_CONFLICT',
      });
    }

    // Guard against modifying already resolved cases without administrator privilege
    const isAlreadyResolved = ['APPROVED', 'REJECTED'].includes(currentCase.status);
    if (isAlreadyResolved && req.user.role !== 'admin') {
      return res.status(409).json({
        success: false,
        error: `Case is already resolved as '${currentCase.status}' and cannot be modified by reviewer. Administrator override required.`,
        code: 'CASE_ALREADY_RESOLVED',
      });
    }

    // Require resolutionReason when marking case APPROVED or REJECTED
    if (['APPROVED', 'REJECTED'].includes(status)) {
      if (!resolutionReason || typeof resolutionReason !== 'string' || !resolutionReason.trim()) {
        return res.status(400).json({
          success: false,
          error: 'A valid resolution reason is required when approving or rejecting a review case.',
        });
      }
    }

    const updated = await updateReviewCase(req.params.id, {
      status,
      assignedTo: req.user.id,
      reviewerNotes,
      resolutionReason,
    });

    // Synchronize registration status with review case disposition
    if (status === 'APPROVED') {
      await updateRegistrationStatus(currentCase.registration_id, 'VERIFIED');
    } else if (status === 'REJECTED') {
      await updateRegistrationStatus(currentCase.registration_id, 'REJECTED');
    } else if (['OPEN', 'IN_REVIEW', 'ESCALATED'].includes(status)) {
      await updateRegistrationStatus(currentCase.registration_id, 'REVIEW_REQUIRED');
    }

    await logEvent({
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
    });

    res.json({ success: true, case: updated });
  } catch (err) {
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
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'DOCUMENT_VIEWED',
      entityType: 'IDENTITY_DOCUMENT',
      entityId: doc.id,
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
