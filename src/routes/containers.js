// Copyright 2026, TheForge, LLC
const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/containers - all containers across all hosts (latest snapshot)
router.get('/', (req, res) => {
  const db = getDb();
  const containers = db.prepare(`
    SELECT c.*, h.name AS host_name
    FROM containers c
    JOIN hosts h ON h.id = c.host_id
    WHERE c.collected_at = (
      SELECT MAX(c2.collected_at) FROM containers c2 WHERE c2.host_id = c.host_id
    )
    ORDER BY h.name, c.name
  `).all();
  res.json(containers);
});

// GET /api/containers/:hostId - containers for a specific host
router.get('/:hostId', (req, res) => {
  const db = getDb();
  const containers = db.prepare(`
    SELECT c.* FROM containers c
    WHERE c.host_id = ? AND c.collected_at = (
      SELECT MAX(c2.collected_at) FROM containers c2 WHERE c2.host_id = ?
    )
    ORDER BY c.name
  `).all(req.params.hostId, req.params.hostId);
  res.json(containers);
});

module.exports = router;
