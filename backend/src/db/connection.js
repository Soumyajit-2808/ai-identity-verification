/**
 * Database Connection & Query Adapter
 * Supports PostgreSQL (via pg.Pool) and SQLite (via node:sqlite)
 * Exposes a unified async query() and transaction() API.
 */

const fs = require('fs');
const path = require('path');

let pool = null;
let sqliteDb = null;
let dbType = 'sqlite'; // 'postgres' or 'sqlite'
let sqliteTxQueue = Promise.resolve();

function getDatabaseConfig() {
  const databaseUrl = process.env.DATABASE_URL || '';
  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    return { type: 'postgres', url: databaseUrl };
  }
  const defaultSqlitePath = path.resolve(__dirname, '../../data/identity_verification.sqlite');
  const sqlitePath = databaseUrl.startsWith('sqlite:') 
    ? databaseUrl.replace('sqlite:', '') 
    : defaultSqlitePath;
  return { type: 'sqlite', path: sqlitePath };
}

function initDb() {
  if (pool || sqliteDb) return;

  const config = getDatabaseConfig();
  dbType = config.type;

  if (dbType === 'postgres') {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: config.url,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error('[DB Pool Error] Unexpected error on idle client:', err);
    });
    console.log('[DB] Connected to PostgreSQL at', config.url.split('@')[1] || 'remote host');
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const dir = path.dirname(config.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    sqliteDb = new DatabaseSync(config.path);
    // Enable foreign key constraints in SQLite
    sqliteDb.exec('PRAGMA foreign_keys = ON;');
    sqliteDb.exec('PRAGMA journal_mode = WAL;');
    console.log('[DB] Initialized persistent SQLite database at:', config.path);
  }
}

/**
 * Execute a SQL query with parameter binding.
 * Compatible with $1, $2 parameter placeholders.
 * Returns { rows, rowCount }.
 */
async function query(text, params = []) {
  initDb();

  if (dbType === 'postgres') {
    const res = await pool.query(text, params);
    return {
      rows: res.rows,
      rowCount: res.rowCount,
    };
  }

  // SQLite execution with $n -> ? conversion preserving exact placeholder order
  const order = [];
  const sqliteQuery = text.replace(/\$(\d+)/g, (_, idx) => {
    order.push(parseInt(idx, 10) - 1);
    return '?';
  });
  const rawParams = order.length > 0 ? order.map(i => params[i]) : params;
  const sqliteParams = rawParams.map(p => (p === undefined ? null : p));

  try {
    const trimmed = sqliteQuery.trim().toUpperCase();
    const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA') || trimmed.includes('RETURNING');
    
    const stmt = sqliteDb.prepare(sqliteQuery);
    if (isSelect) {
      const rows = stmt.all(...sqliteParams);
      return {
        rows,
        rowCount: rows.length,
      };
    } else {
      const info = stmt.run(...sqliteParams);
      return {
        rows: [],
        rowCount: Number(info.changes || 0),
        lastInsertRowid: info.lastInsertRowid,
      };
    }
  } catch (err) {
    console.error('[DB Error]', {
      message: err.message,
      code: err.code,
      querySnippet: sqliteQuery.trim().slice(0, 120),
      paramCount: params.length,
      engine: dbType,
    });
    throw err;
  }
}

/**
 * Execute multiple operations inside a database transaction.
 */
async function transaction(callback) {
  initDb();

  if (dbType === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const clientWrapper = {
        query: (text, params) => client.query(text, params),
      };
      const result = await callback(clientWrapper);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // SQLite transaction serialization across the single connection
  const prevLock = sqliteTxQueue;
  let releaseLock;
  sqliteTxQueue = new Promise((resolve) => {
    releaseLock = resolve;
  });

  await prevLock;
  try {
    sqliteDb.exec('BEGIN TRANSACTION');
    const txWrapper = {
      query: async (text, params) => query(text, params),
    };
    const result = await callback(txWrapper);
    sqliteDb.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      sqliteDb.exec('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    releaseLock();
  }
}

function getDbType() {
  initDb();
  return dbType;
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
}

async function exec(sql) {
  initDb();
  if (dbType === 'postgres') {
    return pool.query(sql);
  } else {
    return sqliteDb.exec(sql);
  }
}

module.exports = {
  initDb,
  query,
  exec,
  transaction,
  getDbType,
  closeDb,
};
