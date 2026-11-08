// Kode bersama untuk semua microservice: koneksi DB, session, health check,
// pemanggilan antar-service (timeout + retry) dan graceful shutdown.
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const mysql = require('mysql2/promise');

// NFR-04: kredensial hanya dari environment variable. Tidak ada nilai bawaan (fallback)
// di kode; bila belum diisi, service berhenti dengan pesan jelas.
function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Environment variable ${name} wajib diisi (lihat .env.example).`);
    process.exit(1);
  }
  return v;
}

const INTERNAL_TOKEN = need('INTERNAL_TOKEN');
const SESSION_SECRET = need('SESSION_SECRET');
const DB_USER = need('DB_USER');
const DB_PASSWORD = need('DB_PASSWORD');

function createPool() {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: +(process.env.DB_PORT || 3306),
    user: DB_USER,
    password: DB_PASSWORD,
    database: process.env.DB_NAME || 'cbt_portal',
    // Kecil per task: total koneksi = pool x jumlah task (penting saat auto scaling).
    connectionLimit: +(process.env.DB_POOL || 10),
    connectTimeout: 10000,
    enableKeepAlive: true,
  });
}

// cleanSessions: hanya satu service (auth) yang membersihkan sesi kedaluwarsa.
function createApp(name, { cleanSessions = false } = {}) {
  const pool = createPool();
  const app = express();
  // Di belakang Nginx / ALB / API Gateway: jumlah proxy yang dipercaya (lokal 1, AWS 2).
  app.set('trust proxy', +(process.env.TRUST_PROXY || 1));
  app.disable('x-powered-by');

  // Health check ringan dipasang SEBELUM session agar tidak membebani pool koneksi
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: name, database: 'up' });
  });

  // Access log satu baris (hanya dicatat jika error atau mode dev, agar tidak memperlambat IO container)
  if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_ACCESS_LOG === 'true') {
    app.use((req, res, next) => {
      const t = Date.now();
      res.on('finish', () => console.log(`[${name}] ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - t}ms`));
      next();
    });
  }

  app.use(express.json({ limit: '100kb' }));

  // Session di MySQL (bukan memori) + secret yang sama di semua service
  // => cookie login dari service auth valid di service exam & session, dan
  // semua instance (replika) bersifat stateless sehingga aman di-scale.
  const store = new MySQLStore({
    clearExpired: cleanSessions,
    expiration: 8 * 3600 * 1000,
    createDatabaseTable: false,
    disableTouch: true, // Mencegah update query ke MySQL di setiap request autosave
  }, pool);
  // Bypass touch di level JS agar zero overhead DB saat read/autosave
  store.touch = (sid, data, cb) => (cb ? cb() : undefined);

  // In-memory cache untuk store.get agar ribuan autosave tidak query SELECT * FROM sessions
  const sessionMemCache = new Map();
  const origGet = store.get.bind(store);
  store.get = function(sid, cb) {
    const cached = sessionMemCache.get(sid);
    if (cached && (Date.now() - cached.at < 60000)) {
      return cb(null, cached.data);
    }
    origGet(sid, (err, data) => {
      if (!err && data) {
        sessionMemCache.set(sid, { data, at: Date.now() });
      }
      cb(err, data);
    });
  };
  const origSet = store.set.bind(store);
  store.set = function(sid, sessionData, cb) {
    sessionMemCache.set(sid, { data: sessionData, at: Date.now() });
    return origSet(sid, sessionData, cb);
  };
  const origDestroy = store.destroy.bind(store);
  store.destroy = function(sid, cb) {
    sessionMemCache.delete(sid);
    return origDestroy(sid, cb);
  };

  app.use(session({
    name: 'cbt.sid',
    secret: SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      maxAge: 8 * 3600 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true', // true hanya jika seluruh rantai proxy meneruskan X-Forwarded-Proto=https
    },
  }));

  return { app, pool };
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
    console.error(e.message);
    if (e.code === 'UPSTREAM_UNAVAILABLE') {
      return res.status(503).json({ error: 'layanan_sementara_tidak_tersedia' });
    }
    res.status(500).json({ error: 'server_error' });
  });
}

const auth = (req, res, next) =>
  (req.session.studentId ? next() : res.status(401).json({ error: 'unauthorized' }));

// Endpoint /internal/* hanya untuk antar-service (gateway & API Gateway tidak meneruskannya).
function internalOnly(req, res, next) {
  const given = Buffer.from(String(req.get('x-internal-token') || ''));
  const want = Buffer.from(INTERNAL_TOKEN);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
  res.status(403).json({ error: 'forbidden' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Panggilan HTTP antar-service: timeout, retry + exponential backoff untuk
// error jaringan / 5xx. Setelah semua percobaan gagal -> UPSTREAM_UNAVAILABLE (dipetakan jadi 503).
async function callService(baseUrl, path, { method = 'GET', body, timeout = 2000, retries = 2 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(baseUrl + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (r.status >= 500) throw new Error(`upstream ${r.status}`);
      const data = await r.json().catch(() => null);
      return { status: r.status, data };
    } catch (e) {
      last = e;
      if (i < retries) await sleep(100 * 2 ** i + Math.random() * 50);
    } finally {
      clearTimeout(timer);
    }
  }
  const err = new Error(`${baseUrl}${path} gagal: ${last && last.message}`);
  err.code = 'UPSTREAM_UNAVAILABLE';
  throw err;
}

function start(app, pool, name) {
  const port = +(process.env.PORT || 3000);
  // Error handler terakhir: selalu JSON, tanpa stack trace.
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (res.headersSent) {
      return next(err);
    }
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err.message);
    res.status(status).json({ error: status === 500 ? 'server_error' : 'request_tidak_valid' });
  });
  pool.query('SELECT 1')
    .then(() => {
      const server = app.listen(port, () => console.log(`[${name}] berjalan di port ${port}`));
      // Harus lebih besar dari idle timeout ALB (60 dtk) agar tidak muncul 502 acak.
      server.keepAliveTimeout = 65000;
      server.headersTimeout = 66000;
      ['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => {
        console.log(`[${name}] ${sig} diterima, menutup server...`);
        server.close(() => pool.end().finally(() => process.exit(0)));
        setTimeout(() => process.exit(0), 8000).unref();
      }));
    })
    .catch((e) => { console.error(`[${name}] tidak bisa terhubung ke MySQL:`, e.message); process.exit(1); });
}

module.exports = { createApp, wrap, auth, internalOnly, callService, start };
