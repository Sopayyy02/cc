// Auth Service: login, logout, profil. Sesi disimpan di MySQL (dipakai bersama service lain).
const bcrypt = require('bcryptjs');
const { createLoginVerifier } = require('../../shared/login-verifier');
const { createApp, wrap, auth, start } = require('../../shared/common');

const { app, pool } = createApp('auth', { cleanSessions: true });

// Coalesce concurrent bcrypt comparisons for identical salted hashes.
 // No raw passwords are stored in cache keys.
const { verify: verifyPassword } = createLoginVerifier(bcrypt.compare);

// Read the authoritative password hash on every login so a password reset
// takes effect immediately across every replica.

app.post('/api/login', wrap(async (req, res) => {
  const { nim, password } = req.body || {};
  if (!nim || !password) return res.status(400).json({ error: 'nim dan password wajib diisi' });

  const [rows] = await pool.query(
    'SELECT id, nim, nama, password_hash FROM students WHERE nim = ?',
    [String(nim)],
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'NIM atau password salah' });

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
