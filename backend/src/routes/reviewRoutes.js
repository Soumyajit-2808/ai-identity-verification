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

router.get('/review-cases', requireAuth, requireRole(['reviewer', 'admin']), async (req, res, next) => {
  try {
    const { eventId, status, limit } = req.query;
    const cases = await listReviewCases({
      eventId: eventId || null,
      status: status || null,
      organizationId: req.user.organization_id || null,
      limit: limit ? Number(limit) : 50,
    });
    res.json({ success: true, count: cases.length, cases });
  } catch (err) {
    next(err);
  }
});

router.get('/review-cases/:id', requireAuth, requireRole(['reviewer', 'admin']), async (req, res, next) => {
  try {
    const reviewCase = await getReviewCaseById(req.params.id, req.user.organization_id || null);
    if (!reviewCase) {
      return res.status(404).json({ success: false, error: 'Review case not found or unauthorized.' });
    }
    res.json({ success: true, case: reviewCase });
  } catch (err) {
    next(err);
  }
});

router.patch('/review-cases/:id', requireAuth, requireRole(['reviewer', 'admin']), async (req, res, next) => {
  try {
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

    const updated = await updateReviewCase(req.params.id, {
      status,
      assignedTo: req.user.id,
      reviewerNotes,
      resolutionReason,
    });

    // If operator approved or rejected the review case, synchronize registration status
    if (status === 'APPROVED') {
      await updateRegistrationStatus(currentCase.registration_id, 'VERIFIED');
    } else if (status === 'REJECTED') {
      await updateRegistrationStatus(currentCase.registration_id, 'REJECTED');
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
