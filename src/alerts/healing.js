// Copyright 2026, TheForge, LLC
const { getDb } = require('../db');
const { execOnHost } = require('../ssh');
const { broadcast } = require('../sse');

/**
 * Attempt to restart crashed containers that have auto_restart enabled.
 * Called after each Docker collection cycle. Looks at the latest container
 * snapshots for the given host, finds non-running containers with
 * auto_restart = 1, and issues `docker start <name>` for each.
 *
 * All actions (success and failure) are logged to the healing_log table.
 *
 * @param {object} host - The host object from the hosts table
 * @param {Array} containers - The container snapshots just collected
 */
async function healCrashedContainers(host, containers) {
  const db = getDb();

  // Find containers that are not running and have auto_restart enabled
  const needsHealing = containers.filter((c) => {
    if (c.status === 'running') return false;
    // Check auto_restart flag from the latest snapshot for this container
    const latest = db.prepare(`
      SELECT auto_restart FROM containers
      WHERE host_id = ? AND name = ?
      ORDER BY collected_at DESC
      LIMIT 1
    `).get(host.id, c.name);
    return latest && latest.auto_restart === 1;
  });

  if (needsHealing.length === 0) return;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const container of needsHealing) {
    // Skip containers in transient states — only restart exited/dead ones
    if (container.status !== 'exited' && container.status !== 'dead') {
      continue;
    }

    console.log(`[healing] Attempting restart of "${container.name}" on ${host.name} (status: ${container.status})`);

    let result = 'success';
    let errorMessage = null;

    try {
      await execOnHost(host, `docker start ${container.name}`, 15000);
      console.log(`[healing] Successfully restarted "${container.name}" on ${host.name}`);
    } catch (err) {
      result = 'failed';
      errorMessage = err.message;
      console.error(`[healing] Failed to restart "${container.name}" on ${host.name}: ${err.message}`);
    }

    // Log the healing action
    db.prepare(`
      INSERT INTO healing_log (host_id, container_name, container_id, action, reason, result, error_message, executed_at)
      VALUES (?, ?, ?, 'restart', ?, ?, ?, ?)
    `).run(
      host.id,
      container.name,
      container.container_id || null,
      `Container status was "${container.status}"`,
      result,
      errorMessage,
      now
    );

    // Broadcast healing event via SSE
    broadcast('healing', {
      host_id: host.id,
      host_name: host.name,
      container_name: container.name,
      container_id: container.container_id,
      action: 'restart',
      result,
      error_message: errorMessage,
      executed_at: now,
    });
  }
}

module.exports = { healCrashedContainers };
