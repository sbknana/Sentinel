// Copyright 2026, TheForge, LLC
const express = require('express');
const { getDb } = require('../db');
const config = require('../config');
const { collectBackupStatus } = require('../collectors/backup');

const router = express.Router();

// GET /api/backups - backup status for all configured backup jobs
router.get('/', (req, res) => {
  const db = getDb();
  const backups = db.prepare('SELECT * FROM backups ORDER BY name').all();

  // Enrich with config data (stale_hours, repo_path)
  const configMap = {};
  for (const b of config.backups) {
    configMap[b.name] = b;
  }

  const enriched = backups.map((b) => {
    const cfg = configMap[b.name] || {};
    const ageHours = b.last_success
      ? ((Date.now() - new Date(b.last_success).getTime()) / (1000 * 60 * 60)).toFixed(1)
      : null;
    return {
      ...b,
      stale_hours: cfg.stale_hours || 24,
      age_hours: ageHours ? parseFloat(ageHours) : null,
    };
  });

  res.json(enriched);
});

// GET /api/backups/history - backup check history for trend tracking
router.get('/history', (req, res) => {
  const db = getDb();
  const name = req.query.name || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);

  let query, params;
  if (name) {
    query = 'SELECT * FROM backup_history WHERE backup_name = ? ORDER BY checked_at DESC LIMIT ?';
    params = [name, limit];
  } else {
    query = 'SELECT * FROM backup_history ORDER BY checked_at DESC LIMIT ?';
    params = [limit];
  }

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// POST /api/backups/check - trigger an immediate backup status check
router.post('/check', async (req, res) => {
  try {
    const results = await collectBackupStatus();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
