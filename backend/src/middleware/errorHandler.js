/**
 * Centralized Error Handling Middleware
 * Prevents stack trace leakage to clients while logging full details for diagnostics.
 */

function errorHandler(err, req, res, next) {
  const requestId = req.id || 'unknown';
  const statusCode = err.statusCode || (err.status && typeof err.status === 'number' ? err.status : 500);

  // Log internal diagnostic information on server console
  console.error(`[Error Handler] [${requestId}] ${req.method} ${req.originalUrl}:`, {
    message: err.message,
    stack: err.stack,
    code: err.code,
  });

  // Client-safe response
  const isClientError = statusCode >= 400 && statusCode < 500;
  const safeMessage = isClientError 
    ? err.message 
    : 'An internal server error occurred while processing your request.';

  res.status(statusCode).json({
    success: false,
    error: safeMessage,
    code: err.code || (isClientError ? 'CLIENT_ERROR' : 'INTERNAL_ERROR'),
    requestId,
  });
}

module.exports = { errorHandler };
