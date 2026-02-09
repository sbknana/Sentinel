// Copyright 2026, TheForge, LLC
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

let fileConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
  fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const config = {
  port: parseInt(process.env.SENTINEL_PORT, 10) || fileConfig.port || 3000,
  dbPath: process.env.SENTINEL_DB || path.join(__dirname, '..', 'data', 'sentinel.db'),
  collectIntervalMs: (fileConfig.collection_interval_seconds || 30) * 1000,
  sseHeartbeatMs: parseInt(process.env.SENTINEL_SSE_HEARTBEAT, 10) || 15000,
  theforgeDbPath: fileConfig.theforge_db_path || null,
  hosts: fileConfig.hosts || [],
  defaultAlerts: fileConfig.default_alerts || [],
  retention: fileConfig.retention || {
    metrics_full_days: 7,
    metrics_downsampled_days: 30,
    containers_days: 7,
    alert_history_days: 90,
  },
  backups: fileConfig.backups || [],
};

module.exports = config;
