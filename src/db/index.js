// Copyright 2026, TheForge, LLC
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');

let db;

function getDb() {
  if (db) return db;

  // Ensure the data directory exists
  const dataDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema();
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'ssh',
      ssh_host TEXT,
      ssh_user TEXT DEFAULT 'root',
      ssh_key_path TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL,
      collected_at TEXT DEFAULT (datetime('now')),
      cpu_percent REAL,
      memory_percent REAL,
      memory_used_mb REAL,
      memory_total_mb REAL,
      disk_percent REAL,
      disk_used_gb REAL,
      disk_total_gb REAL,
      load_1m REAL,
      load_5m REAL,
      load_15m REAL,
      uptime_seconds INTEGER,
      FOREIGN KEY (host_id) REFERENCES hosts(id)
    );

    CREATE TABLE IF NOT EXISTS services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'docker',
      expected_status TEXT DEFAULT 'running',
      FOREIGN KEY (host_id) REFERENCES hosts(id),
      UNIQUE(host_id, name)
    );

    CREATE TABLE IF NOT EXISTS service_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL,
      checked_at TEXT DEFAULT (datetime('now')),
      status TEXT NOT NULL,
      details TEXT,
      FOREIGN KEY (service_id) REFERENCES services(id)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER,
      service_id INTEGER,
      severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
      message TEXT NOT NULL,
      acknowledged INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      FOREIGN KEY (host_id) REFERENCES hosts(id),
      FOREIGN KEY (service_id) REFERENCES services(id)
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_host_time ON metrics(host_id, collected_at);
    CREATE INDEX IF NOT EXISTS idx_service_checks_time ON service_checks(service_id, checked_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON alerts(resolved_at) WHERE resolved_at IS NULL;
  `);
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, close };
