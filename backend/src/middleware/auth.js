/**
 * Authentication & Authorization Middleware
 * Issues JWT tokens, validates operator/reviewer sessions, and enforces RBAC.
 */

const jwt = require('jsonwebtoken');
const { findUserById } = require('../db/repositories/userRepository');

const DEFAULT_DEV_SECRET = 'VERIFY_ID_DEV_JWT_SECRET_KEY_CHANGE_IN_PRODUCTION';

if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEFAULT_DEV_SECRET || process.env.JWT_SECRET === 'VERIFY_ID_SECURE_JWT_SECRET_2026_KEY_PROD') {
    throw new Error('[Security Exception] In production mode, JWT_SECRET must be configured with a unique, secure secret key.');
  }
}

const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_DEV_SECRET;
const TOKEN_EXPIRY = '24h';

function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organization_id,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Please provide a valid Bearer token.',
      code: 'UNAUTHORIZED',
    });
  }

  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired authentication token.',
      code: 'TOKEN_INVALID',
    });
  }

  const user = await findUserById(decoded.id);
  if (!user || !user.is_active) {
    return res.status(401).json({
      success: false,
      error: 'User account not found or deactivated.',
      code: 'USER_DEACTIVATED',
    });
  }

  req.user = user;
  next();
}

function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required.',
        code: 'UNAUTHORIZED',
      });
    }

    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: `Forbidden. Role '${req.user.role}' is not authorized to access this resource.`,
        code: 'FORBIDDEN',
      });
    }

    next();
  };
}

module.exports = {
  generateToken,
  verifyToken,
  requireAuth,
  requireRole,
  JWT_SECRET,
};
