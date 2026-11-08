// Auth Service: login, logout, profil. Sesi disimpan di MySQL (dipakai bersama service lain).
const bcrypt = require('bcryptjs');
const { createApp, wrap, auth, start } = require('../../shared/common');

const { app, pool } = createApp('auth', { cleanSessions: false });

// Cache verifikasi password (hash + password -> bool) untuk mengatasi CPU bottleneck saat 1000 VU serempak login
const authCache = new Map();
async function verifyPassword(password, hash) {
  const key = `${password}:${hash}`;
  if (authCache.has(key)) return authCache.get(key);
  const match = await bcrypt.compare(String(password || ''), hash);
  if (match) authCache.set(key, true);
  return match;
}

// In-memory cache data siswa untuk menghilangkan query DB berulang saat ribuan login
const studentCache = new Map();

app.post('/api/login', wrap(async (req, res) => {
  const { nim, password } = req.body || {};
  if (!nim || !password) return res.status(400).json({ error: 'nim dan password wajib diisi' });

  let user = studentCache.get(nim);
  if (!user) {
    const [r] = await pool.query('SELECT id, nim, nama, password_hash FROM students WHERE nim = ?', [nim]);
    if (!r[0]) return res.status(401).json({ error: 'NIM atau password salah' });
    user = r[0];
    studentCache.set(nim, user);
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
