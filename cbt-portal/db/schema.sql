CREATE TABLE IF NOT EXISTS students (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nim VARCHAR(20) NOT NULL UNIQUE,
  nama VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  judul VARCHAR(150) NOT NULL,
  durasi_menit INT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS questions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  exam_id INT NOT NULL,
  teks TEXT NOT NULL,
  opsi_a TEXT NOT NULL, opsi_b TEXT NOT NULL, opsi_c TEXT NOT NULL, opsi_d TEXT NOT NULL,
  kunci CHAR(1) NOT NULL,
  FOREIGN KEY (exam_id) REFERENCES exams(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS exam_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  student_id INT NOT NULL,
  exam_id INT NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  status ENUM('ongoing','finished') NOT NULL DEFAULT 'ongoing',
  UNIQUE KEY uq_student_exam (student_id, exam_id),
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (exam_id) REFERENCES exams(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS answers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  question_id INT NOT NULL,
  pilihan CHAR(1) NOT NULL,
  saved_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_session_question (session_id, question_id),
  FOREIGN KEY (session_id) REFERENCES exam_sessions(id),
  FOREIGN KEY (question_id) REFERENCES questions(id)
) ENGINE=InnoDB;
