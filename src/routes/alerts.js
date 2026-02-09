// Copyright 2026, TheForge, LLC
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/alerts - list all alert rules
router.get('/', (req, res) => {
  const db = getDb();
  const alerts = db.prepare(`
    SELECT a.*, h.name AS host_name
    FROM alerts a
    LEFT JOIN hosts h ON h.id = a.host_id
    ORDER BY a.severity DESC, a.metric
  `).all();
  res.json(alerts);
});

// POST /api/alerts - create a new alert rule
router.post('/', (req, res) => {
  const { host_id, metric, operator, threshold, severity, cooldown_minutes } = req.body;
  if (!metric || !operator || threshold == null) {
    return res.status(400).json({ error: 'metric, operator, and threshold are required' });
  }
  const validOperators = ['>', '<', '=='];
  if (!validOperators.includes(operator)) {
    return res.status(400).json({ error: `operator must be one of: ${validOperators.join(', ')}` });
  }
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO alerts (host_id, metric, operator, threshold, severity, cooldown_minutes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    host_id || null,
    metric,
    operator,
    threshold,
    severity || 'warning',
    cooldown_minutes || 15
  );
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

// PUT /api/alerts/:id - update an alert rule
router.put('/:id', (req, res) => {
  const { metric, operator, threshold, severity, enabled, cooldown_minutes } = req.body;
  const db = getDb();
  const existing = db.prepare('SELECT * FROM alerts WHERE id = ?').get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Alert rule not found' });
  }
  db.prepare(`
    UPDATE alerts SET metric = ?, operator = ?, threshold = ?, severity = ?, enabled = ?, cooldown_minutes = ?
    WHERE id = ?
  `).run(
    metric ?? existing.metric,
    operator ?? existing.operator,
    threshold ?? existing.threshold,
    severity ?? existing.severity,
    enabled ?? existing.enabled,
    cooldown_minutes ?? existing.cooldown_minutes,
    req.params.id
  );
  res.json({ ok: true });
});

// DELETE /api/alerts/:id - delete an alert rule
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM alerts WHERE id = ?').run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Alert rule not found' });
  }
  res.json({ ok: true });
});

// GET /api/alerts/history - fired alerts log
router.get('/history', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const severity = req.query.severity;
  let query = `
    SELECT ah.*, a.metric, a.operator, a.threshold, a.severity, h.name AS host_name
    FROM alert_history ah
    JOIN alerts a ON a.id = ah.alert_id
    JOIN hosts h ON h.id = ah.host_id
  `;
  const params = [];
  if (severity) {
    query += ' WHERE a.severity = ?';
    params.push(severity);
  }
  query += ' ORDER BY ah.fired_at DESC LIMIT ?';
  params.push(limit);
  const history = db.prepare(query).all(...params);
  res.json(history);
});

// POST /api/alerts/history/:id/acknowledge - acknowledge a fired alert
router.post('/history/:id/acknowledge', (req, res) => {
  const db = getDb();
  const result = db.prepare(
    "UPDATE alert_history SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL"
  ).run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Alert not found or already resolved' });
  }
  res.json({ ok: true });
});

module.exports = router;
