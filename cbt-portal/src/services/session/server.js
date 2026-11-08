// Session Service: sesi ujian, autosave jawaban, selesai ujian.
// Memanggil Exam Service (HTTP internal) untuk validasi soal dan penilaian.
const { createApp, wrap, auth, callService, start } = require('../../shared/common');

const EXAM_URL = process.env.EXAM_SERVICE_URL || 'http://exam-service:3000';
const { app, pool } = createApp('session');

// Cache metadata sesi agar autosave berulang tidak perlu query JOIN exam_sessions & exams di setiap request.
const sessionMetaCache = new Map();

// Sisa waktu dihitung di database saat fetch pertama, lalu dihitung di memori
async function ownSession(id, studentId) {
  const cacheKey = `${id}:${studentId}`;
  const c = sessionMetaCache.get(cacheKey);
  if (c && Date.now() - c.at < 60000) {
    const sisa = Math.floor(c.durasi_detik - (Date.now() - c.started_at_ms) / 1000);
    return { id: +id, exam_id: c.exam_id, status: c.status, sisa };
  }

  const [r] = await pool.query(
    `SELECT s.id, s.exam_id, s.status, s.started_at, e.durasi_menit
       FROM exam_sessions s JOIN exams e ON e.id = s.exam_id
      WHERE s.id = ? AND s.student_id = ?`, [id, studentId]);
  if (!r[0]) return null;

  const row = r[0];
  const started_at_ms = new Date(row.started_at).getTime();
  const durasi_detik = row.durasi_menit * 60;
  sessionMetaCache.set(cacheKey, {
    exam_id: row.exam_id,
    started_at_ms,
    durasi_detik,
    status: row.status,
    at: Date.now(),
  });

  const sisa = Math.floor(durasi_detik - (Date.now() - started_at_ms) / 1000);
  return { id: row.id, exam_id: row.exam_id, status: row.status, sisa };
}

// CATATAN (prinsip stateless): ini BUKAN data ujian/sesi, hanya cache daftar id soal yang
// bisa dibangun ulang kapan saja. Restart atau replika baru tidak kehilangan apa pun.
// Cache daftar id soal per ujian (60 dtk). Bila Exam Service sedang down,
// cache lama tetap dipakai supaya autosave jawaban peserta tidak terhenti.
const qCache = new Map();
async function questionIds(examId) {
  const c = qCache.get(examId);
  if (c && Date.now() - c.at < 60000) return c.ids;
  try {
    const r = await callService(EXAM_URL, `/internal/exams/${examId}/question-ids`);
    const ids = new Set(r.status === 200 ? r.data.ids : []);
    qCache.set(examId, { ids, at: Date.now() });
    return ids;
  } catch (e) {
    if (c) return c.ids;
    throw e;
  }
}

// Autosave ACKs and exam-start decisions must never depend on replica-local caches.

app.post('/api/sessions/start', auth, wrap(async (req, res) => {
  const examId = +(req.body || {}).exam_id;
  if (!Number.isSafeInteger(examId) || examId <= 0) return res.status(400).json({ error: 'exam_id tidak valid' });

  await pool.query('INSERT IGNORE INTO exam_sessions (student_id, exam_id) VALUES (?, ?)', [req.session.studentId, examId]);
  const [r] = await pool.query('SELECT id FROM exam_sessions WHERE student_id = ? AND exam_id = ?', [req.session.studentId, examId]);
  if (!r[0]) return res.status(404).json({ error: 'ujian tidak ditemukan' });
  res.json({ session_id: r[0].id });
}));

app.get('/api/sessions/:id', auth, wrap(async (req, res) => {
  const s = await ownSession(req.params.id, req.session.studentId);
  if (!s) return res.status(404).json({ error: 'sesi tidak ditemukan' });
  const [a] = await pool.query('SELECT question_id, pilihan FROM answers WHERE session_id = ?', [s.id]);
  const answers = {};
  a.forEach((x) => {
    answers[x.question_id] = x.pilihan;
  });
  res.json({
    session: { id: s.id, exam_id: s.exam_id, status: s.status, sisa_detik: Math.max(0, s.sisa) },
    answers,
  });
}));

// Autosave: satu jawaban per request, UPSERT (aman untuk retry), langsung commit ke MySQL.
app.put('/api/sessions/:id/answers', auth, wrap(async (req, res) => {
  const s = await ownSession(req.params.id, req.session.studentId);
  if (!s) return res.status(404).json({ error: 'sesi tidak ditemukan' });
  if (s.status !== 'ongoing' || s.sisa <= 0) return res.status(403).json({ error: 'ujian sudah berakhir' });
  const { question_id, pilihan } = req.body || {};
  if (!/^[A-D]$/.test(pilihan)) return res.status(400).json({ error: 'pilihan tidak valid' });
  const qid = +question_id;
  if (!(await questionIds(s.exam_id)).has(qid)) return res.status(404).json({ error: 'soal tidak ditemukan' });
  
  // This SQL write is the authority across every replica: the student must
  // still own an ongoing exam, and the timer must still be running.
  // Never ACK using an in-memory choice: another replica might have changed it.
  const [write] = await pool.query(
    `INSERT INTO answers (session_id, question_id, pilihan)
     SELECT es.id, ?, ?
       FROM exam_sessions AS es
       JOIN exams AS e ON e.id = es.exam_id
      WHERE es.id = ? AND es.student_id = ? AND es.status = 'ongoing'
        AND TIMESTAMPADD(MINUTE, e.durasi_menit, es.started_at) > CURRENT_TIMESTAMP
     ON DUPLICATE KEY UPDATE pilihan = VALUES(pilihan), saved_at = CURRENT_TIMESTAMP(3)`,
    [qid, pilihan, s.id, req.session.studentId]);

  // MySQL reports affectedRows=0 if a duplicate update is a true no-op
  // (same choice and timestamp millisecond). Recheck that rare case so a
  // valid retry is not incorrectly rejected while a finished exam stays closed.
  if (write.affectedRows === 0) {
    const [existing] = await pool.query(
      `SELECT 1 AS accepted FROM answers a
       JOIN exam_sessions es ON es.id = a.session_id
       JOIN exams e ON e.id = es.exam_id
       WHERE a.session_id = ? AND a.question_id = ? AND a.pilihan = ?
         AND es.student_id = ? AND es.status = 'ongoing'
         AND TIMESTAMPADD(MINUTE, e.durasi_menit, es.started_at) > CURRENT_TIMESTAMP
       LIMIT 1`,
      [s.id, qid, pilihan, req.session.studentId]);
    if (!existing.length) return res.status(409).json({ error: 'ujian_sudah_berakhir_atau_jawaban_berubah' });
  }
  res.json({ status: 'saved', question_id: qid, saved_at: new Date().toISOString() });
}));

// Idempotent: status diubah hanya jika masih 'ongoing', jadi aman di-retry
// bila Exam Service gagal merespons saat penilaian.
app.post('/api/sessions/:id/finish', auth, wrap(async (req, res) => {
  sessionMetaCache.delete(`${req.params.id}:${req.session.studentId}`);
  const s = await ownSession(req.params.id, req.session.studentId);
  if (!s) return res.status(404).json({ error: 'sesi tidak ditemukan' });
  await pool.query("UPDATE exam_sessions SET status = 'finished', finished_at = NOW() WHERE id = ? AND status = 'ongoing'", [s.id]);
  sessionMetaCache.delete(`${req.params.id}:${req.session.studentId}`);
  const [a] = await pool.query('SELECT question_id, pilihan FROM answers WHERE session_id = ?', [s.id]);
  const answers = {};
  a.forEach((x) => { answers[x.question_id] = x.pilihan; });
  const r = await callService(EXAM_URL, `/internal/exams/${s.exam_id}/score`, { method: 'POST', body: { answers } });
  if (r.status !== 200) return res.status(502).json({ error: 'penilaian gagal' });
  res.json({ status: 'finished', benar: r.data.benar, total: r.data.total });
}));

start(app, pool, 'session');
