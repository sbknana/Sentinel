// Copyright 2026, TheForge, LLC
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/healing - healing action log with optional filters
// Query params: host_id, container, result, limit (default 100)
router.get('/', (req, res) => {
  const db = getDb();
  const { host_id, container, result, limit } = req.query;

  let sql = `
    SELECT hl.*, h.name AS host_name
    FROM healing_log hl
    JOIN hosts h ON h.id = hl.host_id
    WHERE 1=1
  `;
  const params = [];

  if (host_id) {
    sql += ' AND hl.host_id = ?';
    params.push(host_id);
  }
  if (container) {
    sql += ' AND hl.container_name = ?';
    params.push(container);
  }
  if (result) {
    sql += ' AND hl.result = ?';
    params.push(result);
  }

  sql += ' ORDER BY hl.executed_at DESC LIMIT ?';
  params.push(Number(limit) || 100);

  const logs = db.prepare(sql).all(...params);
  res.json(logs);
});

// GET /api/healing/stats - summary stats for healing actions
router.get('/stats', (req, res) => {
  const db = getDb();

  const total = db.prepare('SELECT COUNT(*) AS count FROM healing_log').get();
  const byResult = db.prepare(`
    SELECT result, COUNT(*) AS count FROM healing_log GROUP BY result
  `).all();
  const last24h = db.prepare(`
    SELECT COUNT(*) AS count FROM healing_log
    WHERE executed_at > datetime('now', '-1 day')
  `).get();

  res.json({
    total: total.count,
    last_24h: last24h.count,
    by_result: byResult,
  });
});

module.exports = router;
