// Copyright 2026, TheForge, LLC
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/status - overall system health summary
router.get('/status', (req, res) => {
  const db = getDb();
  const hostCount = db.prepare('SELECT COUNT(*) AS count FROM hosts WHERE enabled = 1').get();
  const activeAlerts = db.prepare(
    'SELECT COUNT(*) AS count FROM alert_history WHERE resolved_at IS NULL'
  ).get();
  const criticalAlerts = db.prepare(`
    SELECT COUNT(*) AS count FROM alert_history ah
    JOIN alerts a ON a.id = ah.alert_id
    WHERE ah.resolved_at IS NULL AND a.severity = 'critical'
  `).get();

  res.json({
    hosts: hostCount.count,
    active_alerts: activeAlerts.count,
    critical_alerts: criticalAlerts.count,
    uptime: process.uptime(),
  });
});

// GET /api/hosts - list all monitored hosts with current status
router.get('/hosts', (req, res) => {
  const db = getDb();
  const hosts = db.prepare('SELECT * FROM hosts ORDER BY name').all();

  const result = hosts.map((host) => {
    const latestMetric = db.prepare(
      'SELECT * FROM metrics WHERE host_id = ? ORDER BY collected_at DESC LIMIT 1'
    ).get(host.id);
    return { ...host, latest_metrics: latestMetric || null };
  });

  res.json(result);
});

// GET /api/hosts/:id - single host detail with latest metrics
router.get('/hosts/:id', (req, res) => {
  const db = getDb();
  const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(req.params.id);
  if (!host) {
    return res.status(404).json({ error: 'Host not found' });
  }
  const latestMetric = db.prepare(
    'SELECT * FROM metrics WHERE host_id = ? ORDER BY collected_at DESC LIMIT 1'
  ).get(host.id);
  res.json({ ...host, latest_metrics: latestMetric || null });
});

// GET /api/hosts/:id/metrics - historical metrics for a host
router.get('/hosts/:id/metrics', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit, 10) || 60, 1440);
  const metrics = db.prepare(
    'SELECT * FROM metrics WHERE host_id = ? ORDER BY collected_at DESC LIMIT ?'
  ).all(req.params.id, limit);
  res.json(metrics);
});

// POST /api/hosts - add a new host
router.post('/hosts', (req, res) => {
  const { name, type, ssh_host, ssh_user, ssh_key_path } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  const hostType = type || 'ssh';
  if (hostType === 'ssh' && !ssh_host) {
    return res.status(400).json({ error: 'ssh_host is required for SSH hosts' });
  }
  const db = getDb();
  try {
    const result = db.prepare(
      'INSERT INTO hosts (name, type, ssh_host, ssh_user, ssh_key_path) VALUES (?, ?, ?, ?, ?)'
    ).run(name, hostType, ssh_host || null, ssh_user || null, ssh_key_path || null);
    res.status(201).json({ id: Number(result.lastInsertRowid), name, type: hostType });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `Host "${name}" already exists` });
    }
    throw err;
  }
});

module.exports = router;
