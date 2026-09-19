/**
 * Events & Policy Management Routes
 */

const express = require('express');
const { listEvents, getEventByCode, getEventById, updateEventPolicy } = require('../db/repositories/eventRepository');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logEvent } = require('../db/repositories/auditLogRepository');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const events = await listEvents();
    res.json({ success: true, events });
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
    res.json({ success: true, event });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', requireAuth, requireRole(['admin', 'organizer']), async (req, res, next) => {
  try {
    const existing = await getEventById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Event not found.' });
    }

    if (existing.organization_id && req.user.organization_id && existing.organization_id !== req.user.organization_id) {
      return res.status(403).json({ success: false, error: 'Access denied: event belongs to another organization.' });
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
