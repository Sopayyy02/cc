#!/usr/bin/env node
'use strict';
// Reset ONLY synthetic load-test exam state; keep real students' sessions and answers.
// Works on Windows, macOS, and Linux when Docker CLI is installed.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const sql = `
START TRANSACTION;
DELETE a
  FROM answers AS a
  INNER JOIN exam_sessions AS es ON es.id = a.session_id
  INNER JOIN students AS st ON st.id = es.student_id
 WHERE st.nim REGEXP '^LT[0-9]{4,}$';
DELETE es
  FROM exam_sessions AS es
  INNER JOIN students AS st ON st.id = es.student_id
 WHERE st.nim REGEXP '^LT[0-9]{4,}$';
COMMIT;
`;
const root = path.resolve(__dirname, '..');
const result = spawnSync(
  'docker',
  ['compose', 'exec', '-T', 'mysql', 'sh', '-c',
   'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot "$MYSQL_DATABASE"'],
  { cwd: root, input: sql, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] },
);
if (result.error) {
  console.error('Docker command failed:', result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('Load-test reset failed; all real sessions are preserved.');
  process.exit(result.status ?? 1);
}
console.log('Synthetic LT0001+ exam sessions and answers reset; real exam data and all login sessions preserved.');
