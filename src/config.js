// Copyright 2026, TheForge, LLC
const path = require('path');

const config = {
  port: parseInt(process.env.SENTINEL_PORT, 10) || 3000,
  dbPath: process.env.SENTINEL_DB || path.join(__dirname, '..', 'data', 'sentinel.db'),
  collectIntervalMs: parseInt(process.env.SENTINEL_COLLECT_INTERVAL, 10) || 60000,
  sseHeartbeatMs: parseInt(process.env.SENTINEL_SSE_HEARTBEAT, 10) || 15000,
};

module.exports = config;
