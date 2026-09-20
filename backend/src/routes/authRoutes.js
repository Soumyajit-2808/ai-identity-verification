/**
 * Authentication Routes
 * Handles operator login and session verification.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { findUserByEmail } = require('../db/repositories/userRepository');
const { generateToken, requireAuth } = require('../middleware/auth');
const { logEvent } = require('../db/repositories/auditLogRepository');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email and password are required.',
        code: 'MISSING_CREDENTIALS',
      });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials.',
        code: 'INVALID_CREDENTIALS',
      });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials.',
        code: 'INVALID_CREDENTIALS',
      });
    }

    const token = generateToken(user);

    await logEvent({
      organizationId: user.organization_id,
      actorId: user.id,
      actorRole: user.role,
      action: 'USER_LOGIN',
      entityType: 'USER',
      entityId: user.id,
      details: { email: user.email },
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        organizationName: user.organization_name,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      fullName: req.user.full_name,
      role: req.user.role,
      organizationName: req.user.organization_name,
    },
  });
});

module.exports = router;
