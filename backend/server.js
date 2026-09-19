/**
 * Production Application Server & API Gateway
 * Multi-tenant Identity & Eligibility Verification Platform
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { initDb, closeDb, query, getDbType } = require('./src/db/connection');
const { runMigrations } = require('./src/db/migrate');
const { requestLogger } = require('./src/middleware/logger');
const { errorHandler } = require('./src/middleware/errorHandler');

const authRoutes = require('./src/routes/authRoutes');
const eventRoutes = require('./src/routes/eventRoutes');
const verificationRoutes = require('./src/routes/verificationRoutes');
const reviewRoutes = require('./src/routes/reviewRoutes');
const auditRoutes = require('./src/routes/auditRoutes');

const app = express();
const PORT = process.env.PORT || 3000;
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8001';

// 1. Security Headers & CORS
app.use(
  helmet({
    contentSecurityPolicy: false, // Allows inline script/styles for local dashboard demo
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  })
);

// 2. Request Correlation & Structured Logging
app.use(requestLogger);

// 3. Body Parsers
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// 4. Rate Limiting (Abuse Prevention)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // limit each IP to 300 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests from this IP; please try again later.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});
app.use('/api/', apiLimiter);

// Strict limiter for authentication
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: 'Too many login attempts; please try again later.',
    code: 'AUTH_RATE_LIMIT_EXCEEDED',
  },
});
app.use('/api/auth/login', authLimiter);

// 5. Serve Frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// 6. Health & Diagnostics
app.get('/api/health', async (req, res) => {
  let dbStatus = 'healthy';
  try {
    await query('SELECT 1');
  } catch (err) {
    dbStatus = `unhealthy: ${err.message}`;
  }

  let aiServiceStatus = 'unreachable';
  try {
    const aiCheck = await fetch(`${AI_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (aiCheck.ok) {
      aiServiceStatus = 'healthy';
    } else {
      aiServiceStatus = `http_${aiCheck.status}`;
    }
  } catch (err) {
    aiServiceStatus = `unreachable: ${err.message}`;
  }

  const isHealthy = dbStatus === 'healthy' && aiServiceStatus === 'healthy';
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    service: 'identity-verification-backend',
    version: '2.0.0',
    database: {
      engine: getDbType(),
      status: dbStatus,
    },
    ai_service: {
      url: AI_SERVICE_URL,
      status: aiServiceStatus,
    },
  });
});

// 7. API Routes
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api', reviewRoutes);
app.use('/api', verificationRoutes);
app.use('/api/audit-logs', auditRoutes);

// 8. 404 Handler
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `API route '${req.method} ${req.originalUrl}' not found.`,
    code: 'NOT_FOUND',
  });
});

// 9. Centralized Error Handler
app.use(errorHandler);

// 10. Startup & Lifecycle
async function startServer() {
  try {
    await runMigrations();
    const server = app.listen(PORT, () => {
      console.log(`[Backend] Identity Verification Platform running on http://localhost:${PORT}`);
      console.log(`[Backend] Connected to AI Service at ${AI_SERVICE_URL}`);
    });

    const shutdown = async () => {
      console.log('\n[Backend] Graceful shutdown initiated...');
      server.close(async () => {
        await closeDb();
        console.log('[Backend] Resources freed. Goodbye.');
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('[Backend] Fatal startup error:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;
