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
