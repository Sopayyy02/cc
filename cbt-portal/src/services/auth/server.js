// Auth Service: login, logout, profil. Sesi disimpan di MySQL (dipakai bersama service lain).
const bcrypt = require('bcryptjs');
const { createLoginVerifier } = require('../../shared/login-verifier');
const { createApp, wrap, auth, start } = require('../../shared/common');

const { app, pool } = createApp('auth', { cleanSessions: false });

// Coalesce concurrent bcrypt comparisons for identical salted hashes.
 // No raw passwords are stored in cache keys.
const { verify: verifyPassword } = createLoginVerifier(bcrypt.compare);

// Bounded, short-lived user record cache; password changes propagate quickly.
const studentCache = new Map();
const STUDENT_CACHE_TTL = 30000;
const MAX_STUDENT_CACHE = 4096;

app.post('/api/login', wrap(async (req, res) => {
  const { nim, password } = req.body || {};
  if (!nim || !password) return res.status(400).json({ error: 'nim dan password wajib diisi' });

  const nimKey = String(nim);
  const cached = studentCache.get(nimKey);
  let user = cached && cached.expiresAt > Date.now() ? cached.user : null;
  if (!user) {
    studentCache.delete(nimKey);
    const [r] = await pool.query('SELECT id, nim, nama, password_hash FROM students WHERE nim = ?', [nimKey]);
    if (!r[0]) return res.status(401).json({ error: 'NIM atau password salah' });
    user = r[0];
    if (studentCache.size >= MAX_STUDENT_CACHE) studentCache.delete(studentCache.keys().next().value);
    studentCache.set(nimKey, { user, expiresAt: Date.now() + STUDENT_CACHE_TTL });
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'NIM atau password salah' });
  }
  req.session.studentId = user.id;
  res.json({ id: user.id, nim: user.nim, nama: user.nama });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const [r] = await pool.query('SELECT id, nim, nama FROM students WHERE id = ?', [req.session.studentId]);
  res.json(r[0]);
}));

app.post('/api/logout', wrap(async (req, res) => {
  req.session.destroy(() => res.json({ status: 'bye' }));
}));

start(app, pool, 'auth');
