// Copyright 2026, TheForge, LLC
const express = require('express');
const config = require('../config');

const router = express.Router();

// GET /api/config - current runtime configuration
router.get('/', (req, res) => {
  res.json({
    port: config.port,
    collection_interval_ms: config.collectIntervalMs,
    sse_heartbeat_ms: config.sseHeartbeatMs,
    hosts: config.hosts,
    retention: config.retention,
  });
});

module.exports = router;
