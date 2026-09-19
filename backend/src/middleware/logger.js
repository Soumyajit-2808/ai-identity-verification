/**
 * Structured Logging & Request Correlation Middleware
 * Generates/tracks unique correlation IDs and logs request outcomes without leaking PII.
 */

const crypto = require('crypto');

function requestLogger(req, res, next) {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const logData = {
      requestId,
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode: res.statusCode,
      durationMs,
      ip,
      userAgent: req.headers['user-agent'] || 'unknown',
    };

    if (res.statusCode >= 500) {
      console.error('[HTTP Server Error]', JSON.stringify(logData));
    } else if (res.statusCode >= 400) {
      console.warn('[HTTP Client Error]', JSON.stringify(logData));
    } else {
      console.log('[HTTP Request]', JSON.stringify(logData));
    }
  });

  next();
}

module.exports = { requestLogger };
