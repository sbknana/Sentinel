// Copyright 2026, TheForge, LLC
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../config');

let db;

function getDb() {
  if (db) return db;

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
      ssh_user TEXT,
      ssh_key_path TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES hosts(id),
      collected_at TEXT NOT NULL DEFAULT (datetime('now')),
      cpu_percent REAL,
      memory_percent REAL,
      memory_used_mb INTEGER,
      memory_total_mb INTEGER,
      disk_percent REAL,
      disk_used_gb REAL,
      disk_total_gb REAL,
      load_1m REAL,
      load_5m REAL,
      load_15m REAL,
      uptime_seconds INTEGER
    );

    CREATE TABLE IF NOT EXISTS containers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES hosts(id),
      collected_at TEXT NOT NULL DEFAULT (datetime('now')),
      container_id TEXT NOT NULL,
      name TEXT NOT NULL,
      image TEXT,
      status TEXT NOT NULL,
      uptime TEXT,
      cpu_percent REAL,
      memory_mb REAL,
      auto_restart INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER,
      metric TEXT NOT NULL,
      operator TEXT NOT NULL,
      threshold REAL NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      enabled INTEGER NOT NULL DEFAULT 1,
      cooldown_minutes INTEGER NOT NULL DEFAULT 15
    );

    CREATE TABLE IF NOT EXISTS alert_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER NOT NULL REFERENCES alerts(id),
      host_id INTEGER NOT NULL REFERENCES hosts(id),
      fired_at TEXT NOT NULL DEFAULT (datetime('now')),
      metric_value REAL,
      message TEXT,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      last_check TEXT,
      last_success TEXT,
      status TEXT,
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS healing_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL REFERENCES hosts(id),
      container_name TEXT NOT NULL,
      container_id TEXT,
      action TEXT NOT NULL DEFAULT 'restart',
      reason TEXT,
      result TEXT NOT NULL,
      error_message TEXT,
      executed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backup_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backup_name TEXT NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL,
      last_success TEXT,
      details TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_host_time ON metrics(host_id, collected_at);
    CREATE INDEX IF NOT EXISTS idx_containers_host_time ON containers(host_id, collected_at);
    CREATE INDEX IF NOT EXISTS idx_alert_history_fired ON alert_history(fired_at);
    CREATE INDEX IF NOT EXISTS idx_healing_log_time ON healing_log(executed_at);
    CREATE INDEX IF NOT EXISTS idx_backup_history_time ON backup_history(backup_name, checked_at);
  `);
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, close };
