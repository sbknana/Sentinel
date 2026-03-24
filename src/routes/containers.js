// Copyright 2026, Forgeborn
const express = require('express');
const { getDb } = require('../db');
const { execOnHost } = require('../ssh');

const router = express.Router();

// GET /api/containers - all containers across all hosts (latest snapshot)
// By default, excludes destroyed containers. Pass ?include_destroyed=1 to include them.
router.get('/', (req, res) => {
  const db = getDb();
  const includeDestroyed = req.query.include_destroyed === '1';

  const containers = db.prepare(`
    SELECT c.*, h.name AS host_name
    FROM containers c
    JOIN hosts h ON h.id = c.host_id
    WHERE c.collected_at = (
      SELECT MAX(c2.collected_at) FROM containers c2 WHERE c2.host_id = c.host_id
    )
    ${includeDestroyed ? '' : "AND c.status != 'destroyed'"}
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

// PUT /api/containers/:hostId/:name/auto-restart - toggle auto_restart for a container
router.put('/:hostId/:name/auto-restart', (req, res) => {
  const db = getDb();
  const { hostId, name } = req.params;
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean' && enabled !== 0 && enabled !== 1) {
    return res.status(400).json({ error: 'Body must include "enabled" (boolean or 0/1)' });
  }

  const flag = enabled ? 1 : 0;

  // Update auto_restart on the latest snapshot(s) for this container
  const result = db.prepare(`
    UPDATE containers SET auto_restart = ?
    WHERE host_id = ? AND name = ? AND collected_at = (
      SELECT MAX(collected_at) FROM containers WHERE host_id = ? AND name = ?
    )
  `).run(flag, hostId, name, hostId, name);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Container not found' });
  }

  console.log(`[healing] auto_restart ${flag ? 'enabled' : 'disabled'} for "${name}" on host ${hostId}`);
  res.json({ container: name, host_id: Number(hostId), auto_restart: flag });
});

// PUT /api/containers/:hostId/:name/persistent - toggle persistent flag for a container
// Persistent containers will alert when destroyed; non-persistent ones are silently removed.
router.put('/:hostId/:name/persistent', (req, res) => {
  const db = getDb();
  const { hostId, name } = req.params;
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean' && enabled !== 0 && enabled !== 1) {
    return res.status(400).json({ error: 'Body must include "enabled" (boolean or 0/1)' });
  }

  const flag = enabled ? 1 : 0;

  // Update persistent flag on the latest snapshot(s) for this container
  const result = db.prepare(`
    UPDATE containers SET persistent = ?
    WHERE host_id = ? AND name = ? AND collected_at = (
      SELECT MAX(collected_at) FROM containers WHERE host_id = ? AND name = ?
    )
  `).run(flag, hostId, name, hostId, name);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Container not found' });
  }

  console.log(`[docker] persistent ${flag ? 'enabled' : 'disabled'} for "${name}" on host ${hostId}`);
  res.json({ container: name, host_id: Number(hostId), persistent: flag });
});

// POST /api/containers/:hostId/:name/restart - manually restart a container
router.post('/:hostId/:name/restart', async (req, res) => {
  const db = getDb();
  const { hostId, name } = req.params;

  const host = db.prepare('SELECT * FROM hosts WHERE id = ? AND enabled = 1').get(hostId);
  if (!host) {
    return res.status(404).json({ error: 'Host not found or disabled' });
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  try {
    await execOnHost(host, `docker restart ${name}`, 30000);

    // Log the manual restart in healing_log
    db.prepare(`
      INSERT INTO healing_log (host_id, container_name, action, reason, result, executed_at)
      VALUES (?, ?, 'restart', 'Manual restart via API', 'success', ?)
    `).run(host.id, name, now);

    console.log(`[healing] Manual restart of "${name}" on ${host.name} succeeded`);
    res.json({ container: name, host_id: host.id, result: 'success' });
  } catch (err) {
    // Log the failed restart attempt
    db.prepare(`
      INSERT INTO healing_log (host_id, container_name, action, reason, result, error_message, executed_at)
      VALUES (?, ?, 'restart', 'Manual restart via API', 'failed', ?, ?)
    `).run(host.id, name, err.message, now);

    console.error(`[healing] Manual restart of "${name}" on ${host.name} failed: ${err.message}`);
    res.status(500).json({ container: name, host_id: host.id, result: 'failed', error: err.message });
  }
});

module.exports = router;
