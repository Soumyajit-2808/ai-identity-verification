/**
 * Audit Trail API Routes
 */

const express = require('express');
const { listAuditLogs } = require('../db/repositories/auditLogRepository');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, requireRole(['admin']), async (req, res, next) => {
  try {
    const { entityType, entityId, limit } = req.query;
    const logs = await listAuditLogs({
      entityType: entityType || null,
      entityId: entityId || null,
      limit: limit ? Number(limit) : 100,
    });
    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
