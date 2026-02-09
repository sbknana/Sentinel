// Copyright 2026, TheForge, LLC
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/hosts - list all hosts
router.get('/hosts', (req, res) => {
  const db = getDb();
  const hosts = db.prepare('SELECT * FROM hosts ORDER BY name').all();
  res.json(hosts);
});

// POST /api/hosts - add a host
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
    ).run(name, hostType, ssh_host || null, ssh_user || 'root', ssh_key_path || null);
    res.status(201).json({ id: result.lastInsertRowid, name, type: hostType });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: `Host "${name}" already exists` });
    }
    throw err;
  }
});

// GET /api/hosts/:id/metrics - latest metrics for a host
router.get('/hosts/:id/metrics', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit, 10) || 60, 1440);
  const metrics = db.prepare(
    'SELECT * FROM metrics WHERE host_id = ? ORDER BY collected_at DESC LIMIT ?'
  ).all(req.params.id, limit);
  res.json(metrics);
});

// GET /api/metrics/latest - latest single metric per host
router.get('/metrics/latest', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.*, h.name AS host_name, h.type AS host_type, h.ssh_host
    FROM metrics m
    JOIN hosts h ON h.id = m.host_id
    WHERE m.id IN (
      SELECT MAX(id) FROM metrics GROUP BY host_id
    )
    ORDER BY h.name
  `).all();
  res.json(rows);
});

// GET /api/alerts - active (unresolved) alerts
router.get('/alerts', (req, res) => {
  const db = getDb();
  const includeResolved = req.query.all === 'true';
  const query = includeResolved
    ? 'SELECT a.*, h.name AS host_name FROM alerts a LEFT JOIN hosts h ON h.id = a.host_id ORDER BY a.created_at DESC LIMIT 100'
    : 'SELECT a.*, h.name AS host_name FROM alerts a LEFT JOIN hosts h ON h.id = a.host_id WHERE a.resolved_at IS NULL ORDER BY a.created_at DESC';
  const alerts = db.prepare(query).all();
  res.json(alerts);
});

// POST /api/alerts/:id/acknowledge - acknowledge an alert
router.post('/alerts/:id/acknowledge', (req, res) => {
  const db = getDb();
  const result = db.prepare(
    'UPDATE alerts SET acknowledged = 1 WHERE id = ?'
  ).run(req.params.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Alert not found' });
  }
  res.json({ ok: true });
});

// GET /api/services - all services with latest check status
router.get('/services', (req, res) => {
  const db = getDb();
  const services = db.prepare(`
    SELECT s.*, h.name AS host_name,
      sc.status AS last_status, sc.checked_at AS last_checked, sc.details
    FROM services s
    JOIN hosts h ON h.id = s.host_id
    LEFT JOIN service_checks sc ON sc.id = (
      SELECT MAX(id) FROM service_checks WHERE service_id = s.id
    )
    ORDER BY h.name, s.name
  `).all();
  res.json(services);
});

// GET /api/status - overall system status summary
router.get('/status', (req, res) => {
  const db = getDb();
  const hostCount = db.prepare('SELECT COUNT(*) AS count FROM hosts WHERE enabled = 1').get();
  const activeAlerts = db.prepare('SELECT COUNT(*) AS count FROM alerts WHERE resolved_at IS NULL').get();
  const criticalAlerts = db.prepare(
    "SELECT COUNT(*) AS count FROM alerts WHERE resolved_at IS NULL AND severity = 'critical'"
  ).get();

  res.json({
    hosts: hostCount.count,
    active_alerts: activeAlerts.count,
    critical_alerts: criticalAlerts.count,
    uptime: process.uptime(),
  });
});

module.exports = router;
