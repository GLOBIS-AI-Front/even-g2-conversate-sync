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
