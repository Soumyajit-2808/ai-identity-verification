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
const { requireAuth, requireRole } = require('./src/middleware/auth');

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

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://127.0.0.1:3000'];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser requests (e.g. server-to-server, curl, tests) or matching origins
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('CORS request blocked: origin unauthorized.'));
    },
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

// Dedicated rate limiter for computationally heavy verification requests
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: {
    success: false,
    error: 'Too many verification attempts from this IP; please try again later.',
    code: 'VERIFY_RATE_LIMIT_EXCEEDED',
  },
});
app.use('/api/verify', verifyLimiter);

// 5. Serve Frontend
const candidateFrontendPaths = [
  path.join(__dirname, '..', 'frontend'),
  path.join(__dirname, 'frontend'),
  '/app/frontend',
];
const fs = require('fs');
const frontendDir = candidateFrontendPaths.find(p => fs.existsSync(p)) || path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));

app.get('/', (req, res, next) => {
  const indexHtml = path.join(frontendDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    return res.sendFile(indexHtml);
  }
  next();
});

// 6. Health & Diagnostics
app.get('/api/health', async (req, res) => {
  let dbOk = false;
  try {
    await query('SELECT 1');
    dbOk = true;
  } catch (_) {
    dbOk = false;
  }

  let aiOk = false;
  try {
    const aiCheck = await fetch(`${AI_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    aiOk = aiCheck.ok;
  } catch (_) {
    aiOk = false;
  }

  const dbStatus = dbOk ? 'healthy' : 'unhealthy';
  const aiStatus = aiOk ? 'healthy' : 'unhealthy';
  const isHealthy = dbOk && aiOk;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    service: 'identity-verification-backend',
    version: '2.0.0',
    database: {
      status: dbStatus,
    },
    ai_service: {
      status: aiStatus,
    },
    components: {
      database: dbStatus,
      ai_service: aiStatus,
    },
  });
});

app.get('/api/metrics', requireAuth, requireRole(['admin', 'reviewer']), async (req, res) => {
  try {
    const orgId = req.user.organization_id || null;
    let totalQuery = 'SELECT COUNT(*) as cnt FROM verification_results vr JOIN verification_requests req ON vr.request_id = req.id JOIN events ev ON req.event_id = ev.id';
    let decisionsQuery = 'SELECT vr.decision, COUNT(*) as cnt FROM verification_results vr JOIN verification_requests req ON vr.request_id = req.id JOIN events ev ON req.event_id = ev.id';
    let reviewsQuery = "SELECT COUNT(*) as cnt FROM review_cases rc JOIN events ev ON rc.event_id = ev.id WHERE rc.status = 'OPEN'";
    const params = [];

    if (orgId) {
      totalQuery += ' WHERE ev.organization_id = $1';
      decisionsQuery += ' WHERE ev.organization_id = $1 GROUP BY vr.decision';
      reviewsQuery += ' AND ev.organization_id = $1';
      params.push(orgId);
    } else {
      decisionsQuery += ' GROUP BY vr.decision';
    }

    const totalResult = await query(totalQuery, params);
    const totalVerifications = parseInt(totalResult.rows[0]?.cnt || totalResult.rows[0]?.count || '0', 10);

    const decisionsResult = await query(decisionsQuery, params);
    const decisions = { ELIGIBLE: 0, INELIGIBLE: 0, REVIEW: 0 };
    for (const row of decisionsResult.rows) {
      if (row.decision) {
        decisions[row.decision] = parseInt(row.cnt || row.count || '0', 10);
      }
    }

    const reviewsResult = await query(reviewsQuery, params);
    const openReviews = parseInt(reviewsResult.rows[0]?.cnt || reviewsResult.rows[0]?.count || '0', 10);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      organizationId: orgId,
      metrics: {
        totalVerifications,
        decisions,
        openReviews,
        uptimeSeconds: Math.floor(process.uptime()),
        memoryUsageMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      },
    });
  } catch (err) {
    console.error('[Metrics Error]', err);
    res.status(500).json({
      success: false,
      error: 'Failed to compute metrics.',
      code: 'METRICS_ERROR',
    });
  }
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
