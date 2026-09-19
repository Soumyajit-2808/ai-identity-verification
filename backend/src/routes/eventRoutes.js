/**
 * Events & Policy Management Routes
 */

const express = require('express');
const { listEvents, getEventByCode, getEventById, updateEventPolicy } = require('../db/repositories/eventRepository');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logEvent } = require('../db/repositories/auditLogRepository');

const router = express.Router();
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_ID_TYPES = ['PASSPORT', 'DRIVING_LICENSE', 'STUDENT_ID', 'NATIONAL_ID', 'AADHAAR', 'PAN', 'VOTER_ID'];
const ALLOWED_POLICY_FIELDS = ['minAge', 'maxAge', 'allowedIdTypes', 'requireSelfie', 'strictNameMatching'];

router.get('/', async (req, res, next) => {
  try {
    const events = await listEvents();
    // Sanitize internal organization_id from public event discovery
    const sanitized = events.map(({ organization_id, ...rest }) => rest);
    res.json({ success: true, events: sanitized });
  } catch (err) {
    next(err);
  }
});

router.get('/:code', async (req, res, next) => {
  try {
    const event = await getEventByCode(req.params.code);
    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found.' });
    }
    const { organization_id, ...sanitized } = event;
    res.json({ success: true, event: sanitized });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireAuth, requireRole(['admin', 'organizer']), async (req, res, next) => {
  try {
    if (!uuidRegex.test(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid event ID format.' });
    }

    const existing = await getEventById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Event not found.' });
    }

    if (existing.organization_id && req.user.organization_id && existing.organization_id !== req.user.organization_id) {
      return res.status(403).json({ success: false, error: 'Access denied: event belongs to another organization.' });
    }

    const bodyKeys = Object.keys(req.body);
    if (bodyKeys.length === 0) {
      return res.status(400).json({ success: false, error: 'No policy update fields provided.' });
    }

    const unknownFields = bodyKeys.filter(k => !ALLOWED_POLICY_FIELDS.includes(k));
    if (unknownFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Unrecognized policy field(s): ${unknownFields.join(', ')}. Permitted fields: ${ALLOWED_POLICY_FIELDS.join(', ')}`,
      });
    }

    const { minAge, maxAge, allowedIdTypes, requireSelfie, strictNameMatching } = req.body;

    // Strict validation of minAge
    if (minAge !== undefined) {
      if (typeof minAge !== 'number' || !Number.isInteger(minAge) || minAge < 0 || minAge > 120) {
        return res.status(400).json({ success: false, error: 'minAge must be an integer between 0 and 120.' });
      }
    }

    // Strict validation of maxAge
    if (maxAge !== undefined) {
      if (typeof maxAge !== 'number' || !Number.isInteger(maxAge) || maxAge < 0 || maxAge > 120) {
        return res.status(400).json({ success: false, error: 'maxAge must be an integer between 0 and 120.' });
      }
    }

    const newMin = minAge !== undefined ? minAge : existing.min_age;
    const newMax = maxAge !== undefined ? maxAge : existing.max_age;
    if (newMin > newMax) {
      return res.status(400).json({ success: false, error: 'minAge cannot exceed maxAge.' });
    }

    // Strict validation of allowedIdTypes
    if (allowedIdTypes !== undefined) {
      if (!Array.isArray(allowedIdTypes) || allowedIdTypes.length === 0) {
        return res.status(400).json({ success: false, error: 'allowedIdTypes must be a non-empty array of permitted ID types.' });
      }
      for (const t of allowedIdTypes) {
        if (typeof t !== 'string' || !t.trim()) {
          return res.status(400).json({ success: false, error: 'allowedIdTypes elements must be non-empty strings.' });
        }
      }
      const invalidTypes = allowedIdTypes.filter(t => !KNOWN_ID_TYPES.includes(t));
      if (invalidTypes.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Unsupported ID type(s): ${invalidTypes.join(', ')}. Permitted types: ${KNOWN_ID_TYPES.join(', ')}`,
        });
      }
    }

    // Strict boolean validation to prevent truthiness coercion bugs
    if (requireSelfie !== undefined && typeof requireSelfie !== 'boolean') {
      return res.status(400).json({ success: false, error: 'requireSelfie must be an explicit boolean (true or false).' });
    }

    if (strictNameMatching !== undefined && typeof strictNameMatching !== 'boolean') {
      return res.status(400).json({ success: false, error: 'strictNameMatching must be an explicit boolean (true or false).' });
    }

    const updated = await updateEventPolicy(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Event not found.' });
    }

    await logEvent({
      actorId: req.user.id,
      actorRole: req.user.role,
      action: 'EVENT_POLICY_UPDATED',
      entityType: 'EVENT',
      entityId: req.params.id,
      eventId: req.params.id,
      details: req.body,
      ipAddress: req.ip,
    });

    res.json({ success: true, event: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
