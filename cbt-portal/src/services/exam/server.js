// Exam Service: daftar ujian & soal (publik, butuh login) + endpoint internal
// untuk Session Service (validasi soal dan penilaian; kunci jawaban tidak pernah keluar).
const { createApp, wrap, auth, internalOnly, start } = require('../../shared/common');

const { app, pool } = createApp('exam');

// Cache in-memory untuk soal & ID soal ujian (read-heavy, data statis selama ujian)
const questionsCache = new Map();
const qIdsCache = new Map();

app.get('/api/exams', auth, wrap(async (req, res) => {
  const [r] = await pool.query('SELECT id, judul, durasi_menit FROM exams');
  res.json(r);
}));

app.get('/api/exams/:id/questions', auth, wrap(async (req, res) => {
  const examId = req.params.id;
  if (!questionsCache.has(examId)) {
    const [r] = await pool.query(
      'SELECT id, teks, opsi_a, opsi_b, opsi_c, opsi_d FROM questions WHERE exam_id = ? ORDER BY id', [examId]);
    questionsCache.set(examId, r);
  }
  res.json(questionsCache.get(examId));
}));

// ---- Internal (antar-service) ----
app.get('/internal/exams/:id/question-ids', internalOnly, wrap(async (req, res) => {
  const examId = req.params.id;
  if (!qIdsCache.has(examId)) {
    const [r] = await pool.query('SELECT id FROM questions WHERE exam_id = ?', [examId]);
    qIdsCache.set(examId, r.map((x) => x.id));
  }
  res.json({ ids: qIdsCache.get(examId) });
}));

// body: { answers: { "<question_id>": "A".."D" } }  ->  { benar, total }
app.post('/internal/exams/:id/score', internalOnly, wrap(async (req, res) => {
  const answers = (req.body && req.body.answers) || {};
  const [keys] = await pool.query('SELECT id, kunci FROM questions WHERE exam_id = ?', [req.params.id]);
  const benar = keys.filter((k) => answers[k.id] === k.kunci).length;
  res.json({ benar, total: keys.length });
}));

start(app, pool, 'exam');
