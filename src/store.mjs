import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  issue TEXT NOT NULL,
  source_rev TEXT NOT NULL,
  matched INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  state TEXT NOT NULL,
  draft TEXT,
  draft_rev TEXT,
  draft_version INTEGER NOT NULL DEFAULT 0,
  draft_stale INTEGER NOT NULL DEFAULT 0,
  decision TEXT,
  pinned_template TEXT,
  active_run_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidates_repo_idx ON candidates (repo);
CREATE INDEX IF NOT EXISTS candidates_state_idx ON candidates (state);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  source_rev TEXT NOT NULL,
  matched INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS draft_history (
  candidate_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  rev TEXT NOT NULL,
  requirements_rev TEXT NOT NULL,
  draft TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (candidate_id, version)
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  action TEXT NOT NULL,
  draft_rev TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  issue_ref TEXT NOT NULL,
  draft_rev TEXT NOT NULL,
  requirements_rev TEXT NOT NULL,
  draft_snapshot TEXT NOT NULL,
  source_rev TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  template_ref TEXT,
  branch TEXT,
  worktree_path TEXT,
  pid INTEGER,
  session_id TEXT,
  result TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
CREATE INDEX IF NOT EXISTS runs_candidate_idx ON runs (candidate_id);

CREATE TABLE IF NOT EXISTS acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  verdict TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  comment TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS acceptances_candidate_idx ON acceptances (candidate_id);

CREATE TABLE IF NOT EXISTS auto_repair_policies (
  candidate_id TEXT NOT NULL,
  draft_rev TEXT NOT NULL,
  requirements_rev TEXT NOT NULL,
  source_rev TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  limit_value INTEGER NOT NULL DEFAULT 2,
  pending_run_id TEXT,
  pending_head_sha TEXT,
  pending_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (candidate_id, draft_rev, requirements_rev, source_rev)
);

CREATE TABLE IF NOT EXISTS auto_repair_consumptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL,
  draft_rev TEXT NOT NULL,
  requirements_rev TEXT NOT NULL,
  source_rev TEXT NOT NULL,
  from_run_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (candidate_id, draft_rev, requirements_rev, source_rev, from_run_id)
);
CREATE INDEX IF NOT EXISTS auto_repair_consumptions_candidate_idx ON auto_repair_consumptions (candidate_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  candidate_id TEXT,
  run_id TEXT,
  repo TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_candidate_idx ON events (candidate_id);
CREATE INDEX IF NOT EXISTS events_run_idx ON events (run_id);
`;

export class Store {
  #db;
  #closed = false;

  constructor(dbPath) {
    if (typeof dbPath !== 'string' || dbPath.trim().length === 0) {
      throw new Error('dbPath 必须是非空字符串');
    }
    this.dbPath = dbPath;

    if (dbPath !== ':memory:') {
      mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }

    this.#db = new DatabaseSync(dbPath);
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000;');
      if (dbPath !== ':memory:') {
        this.#db.exec('PRAGMA journal_mode = WAL;');
      }
      this.#db.exec('PRAGMA foreign_keys = ON;');
      this.#db.exec(SCHEMA);
      this.#ensureColumn('candidates', 'pinned_template', 'TEXT');
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  get raw() {
    return this.#db;
  }

  #ensureColumn(table, column, definition) {
    const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((entry) => entry.name === column)) {
      return;
    }
    this.#db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#db.close();
  }

  transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Keep the original error.
      }
      throw error;
    }
  }

  all(sql, ...params) {
    return this.#db.prepare(sql).all(...params);
  }

  get(sql, ...params) {
    return this.#db.prepare(sql).get(...params);
  }

  run(sql, ...params) {
    return this.#db.prepare(sql).run(...params);
  }

  appendEvent({ at, kind, message, candidateId = null, runId = null, repo = null, data = null }) {
    this.run(
      `INSERT INTO events (at, kind, message, candidate_id, run_id, repo, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      at,
      kind,
      message,
      candidateId,
      runId,
      repo,
      data === null ? null : JSON.stringify(data),
    );
  }
}
