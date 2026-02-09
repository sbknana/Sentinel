// Copyright 2026, TheForge, LLC
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/backups - backup status for all configured backup jobs
router.get('/', (req, res) => {
  const db = getDb();
  const backups = db.prepare('SELECT * FROM backups ORDER BY name').all();
  res.json(backups);
});

module.exports = router;
