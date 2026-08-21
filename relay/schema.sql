CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  transcript  TEXT NOT NULL,
  lang_hints  TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status, created_at);

-- 実機の WebView が何を持っているかの探査結果（設計判断のためだけの一時的なもの）
CREATE TABLE IF NOT EXISTS probes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  payload    TEXT NOT NULL
);

-- LINE の宛先（本人）。Webhook で捕まえて貯める。broadcast は会社の公式アカウントなので使わない。
CREATE TABLE IF NOT EXISTS line_users (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);

-- LINE から届いた本文（事前相談への返信を受け取るため）
CREATE TABLE IF NOT EXISTS line_inbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  handled    INTEGER NOT NULL DEFAULT 0
);
