// Copyright 2026, Forgeborn
const { getDb } = require('../db');
const { execOnHost } = require('../ssh');
const { broadcast } = require('../sse');
const { healCrashedContainers } = require('../alerts/healing');

// Commands from CLAUDE.md spec
const DOCKER_PS_CMD = "docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'";
const DOCKER_STATS_CMD = "docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'";

/**
 * Collect Docker container data from a single host.
 * Runs docker ps -a for all containers and docker stats for resource usage.
 * Stores results in the containers table and broadcasts via SSE.
 *
 * After collecting, detects destroyed containers (previously monitored but no
 * longer in docker ps -a output) and auto-removes non-persistent ones from
 * monitoring instead of alerting "down."
 */
async function collectDocker(host) {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Get all containers (running + stopped)
  let psOutput;
  try {
    psOutput = await execOnHost(host, DOCKER_PS_CMD);
  } catch (err) {
    console.error(`[docker] Failed to list containers on ${host.name}: ${err.message}`);
    return [];
  }

  const containers = parsePsOutput(psOutput);

  // Get resource usage for running containers
  let statsOutput = '';
  if (containers.length > 0) {
    try {
      statsOutput = await execOnHost(host, DOCKER_STATS_CMD);
    } catch (err) {
      // docker stats can fail if no containers are running — not fatal
      console.warn(`[docker] Failed to get stats on ${host.name}: ${err.message}`);
    }
  }

  const stats = parseStatsOutput(statsOutput);

  // Merge stats into container data
  for (const container of containers) {
    const stat = stats.get(container.name);
    if (stat) {
      container.cpu_percent = stat.cpu_percent;
      container.memory_mb = stat.memory_mb;
    }
  }

  // Carry forward auto_restart and persistent flags from the previous snapshot
  const prevFlags = db.prepare(`
    SELECT auto_restart, persistent FROM containers
    WHERE host_id = ? AND name = ?
    ORDER BY collected_at DESC
    LIMIT 1
  `);

  for (const container of containers) {
    const prev = prevFlags.get(host.id, container.name);
    container.auto_restart = prev ? prev.auto_restart : 0;
    container.persistent = prev ? prev.persistent : 0;
  }

  // --- Detect destroyed containers ---
  // Get the set of container names we knew about on the last poll
  const liveNames = new Set(containers.map((c) => c.name));
  handleDestroyedContainers(db, host, liveNames, now);

  // Store in database (even if containers is empty, the destroyed detection above still runs)
  if (containers.length > 0) {
    const insert = db.prepare(`
      INSERT INTO containers (host_id, collected_at, container_id, name, image, status, uptime, cpu_percent, memory_mb, auto_restart, persistent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((rows) => {
      for (const c of rows) {
        insert.run(
          host.id,
          now,
          c.container_id,
          c.name,
          c.image,
          c.status,
          c.uptime,
          c.cpu_percent,
          c.memory_mb,
          c.auto_restart,
          c.persistent
        );
      }
    });

    insertMany(containers);
  }

  // Broadcast to SSE clients
  broadcast('container', {
    host_id: host.id,
    host_name: host.name,
    collected_at: now,
    containers,
  });

  return containers;
}

/**
 * Detect containers that were previously monitored but no longer appear in
 * docker ps -a output (i.e., they were destroyed/removed).
 *
 * - Non-persistent containers: auto-removed from monitoring with a log entry.
 *   Any unresolved alerts for these containers are resolved automatically.
 * - Persistent containers: a "destroyed" alert is fired (these are production
 *   services that should NOT disappear silently).
 *
 * @param {object} db - The database instance
 * @param {object} host - The host object
 * @param {Set<string>} liveNames - Container names currently reported by docker ps -a
 * @param {string} now - Current timestamp
 */
function handleDestroyedContainers(db, host, liveNames, now) {
  // Get distinct container names from the most recent collection for this host
  // (i.e., the last snapshot before the current poll)
  const previousContainers = db.prepare(`
    SELECT DISTINCT c.name, c.persistent, c.container_id
    FROM containers c
    WHERE c.host_id = ?
      AND c.collected_at = (
        SELECT MAX(c2.collected_at) FROM containers c2
        WHERE c2.host_id = c.host_id
      )
  `).all(host.id);

  for (const prev of previousContainers) {
    if (liveNames.has(prev.name)) continue;

    // This container was in the previous poll but is no longer in docker ps -a — it was destroyed
    if (prev.persistent === 1) {
      // Persistent container destroyed — this is noteworthy, fire an alert
      firePersistentDestroyedAlert(db, host, prev, now);
    } else {
      // Ephemeral container destroyed — auto-remove from monitoring silently
      autoRemoveDestroyedContainer(db, host, prev, now);
    }
  }
}

/**
 * Auto-remove a destroyed ephemeral container from monitoring.
 * Inserts a final "destroyed" snapshot so the timeline is clear,
 * resolves any open alerts for this container, and logs the removal.
 */
function autoRemoveDestroyedContainer(db, host, container, now) {
  console.log(`[docker] Container "${container.name}" destroyed — removed from monitoring on ${host.name}`);

  // Insert a final snapshot with status "destroyed" so the timeline is complete
  db.prepare(`
    INSERT INTO containers (host_id, collected_at, container_id, name, image, status, uptime, cpu_percent, memory_mb, auto_restart, persistent)
    VALUES (?, ?, ?, ?, NULL, 'destroyed', NULL, NULL, NULL, 0, 0)
  `).run(host.id, now, container.container_id, container.name);

  // Resolve any open alerts for this container
  db.prepare(`
    UPDATE alert_history
    SET resolved_at = ?
    WHERE host_id = ?
      AND message LIKE ?
      AND resolved_at IS NULL
  `).run(now, host.id, `%${container.name}%`);

  // Log to healing_log for audit trail
  db.prepare(`
    INSERT INTO healing_log (host_id, container_name, container_id, action, reason, result, error_message, executed_at)
    VALUES (?, ?, ?, 'auto_remove', 'Container destroyed — no longer in docker ps -a', 'success', NULL, ?)
  `).run(host.id, container.name, container.container_id, now);

  // Broadcast removal event
  broadcast('container_removed', {
    host_id: host.id,
    host_name: host.name,
    container_name: container.name,
    container_id: container.container_id,
    reason: 'destroyed',
    removed_at: now,
  });
}

/**
 * Fire an alert for a persistent container that was destroyed.
 * Persistent containers (e.g., production services) should never disappear
 * silently — this warrants a critical alert.
 */
function firePersistentDestroyedAlert(db, host, container, now) {
  console.log(`[alert] CRITICAL: Persistent container "${container.name}" was destroyed on ${host.name}`);

  // Insert a "destroyed" snapshot
  db.prepare(`
    INSERT INTO containers (host_id, collected_at, container_id, name, image, status, uptime, cpu_percent, memory_mb, auto_restart, persistent)
    VALUES (?, ?, ?, ?, NULL, 'destroyed', NULL, NULL, NULL, 0, 1)
  `).run(host.id, now, container.container_id, container.name);

  // Find the container_down alert rule for this host
  const rule = db.prepare(`
    SELECT * FROM alerts
    WHERE metric = 'container_down'
      AND enabled = 1
      AND (host_id IS NULL OR host_id = ?)
    LIMIT 1
  `).get(host.id);

  if (rule) {
    const message = `Persistent container "${container.name}" was DESTROYED on ${host.name} — expected to be running`;

    // Check cooldown to avoid duplicate alerts
    const recent = db.prepare(`
      SELECT id FROM alert_history
      WHERE alert_id = ?
        AND host_id = ?
        AND message LIKE ?
        AND fired_at > datetime('now', ?)
        AND resolved_at IS NULL
    `).get(rule.id, host.id, `%${container.name}%DESTROYED%`, `-${rule.cooldown_minutes} minutes`);

    if (!recent) {
      db.prepare(`
        INSERT INTO alert_history (alert_id, host_id, fired_at, metric_value, message)
        VALUES (?, ?, ?, ?, ?)
      `).run(rule.id, host.id, now, 0, message);

      broadcast('alert', {
        host_id: host.id,
        host_name: host.name,
        severity: 'critical',
        message,
        container: container.name,
        status: 'destroyed',
        fired_at: now,
      });
    }
  }
}

/**
 * Parse `docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'`
 *
 * Status field examples:
 *   "Up 2 hours"
 *   "Up 3 days (healthy)"
 *   "Exited (0) 5 minutes ago"
 *   "Created"
 *   "Restarting (1) 3 seconds ago"
 */
function parsePsOutput(output) {
  const containers = [];
  const lines = output.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 4) continue;

    const [containerId, name, image, rawStatus] = parts;
    const { status, uptime } = parseStatus(rawStatus);

    containers.push({
      container_id: containerId.trim(),
      name: name.trim(),
      image: image.trim(),
      status,
      uptime: uptime || null,
      cpu_percent: null,
      memory_mb: null,
    });
  }

  return containers;
}

/**
 * Parse docker status string into normalized status + uptime.
 * "Up 2 hours" -> { status: 'running', uptime: '2 hours' }
 * "Up 3 days (healthy)" -> { status: 'running', uptime: '3 days' }
 * "Exited (0) 5 minutes ago" -> { status: 'exited', uptime: null }
 * "Created" -> { status: 'created', uptime: null }
 * "Restarting (1) 3 seconds ago" -> { status: 'restarting', uptime: null }
 * "Paused" -> { status: 'paused', uptime: null }
 */
function parseStatus(rawStatus) {
  const s = rawStatus.trim();

  if (s.startsWith('Up')) {
    // Remove health annotation like "(healthy)" or "(unhealthy)"
    const uptime = s.replace(/^Up\s+/, '').replace(/\s*\(.*\)\s*$/, '').trim();
    return { status: 'running', uptime };
  }
  if (s.startsWith('Exited')) {
    return { status: 'exited', uptime: null };
  }
  if (s.startsWith('Restarting')) {
    return { status: 'restarting', uptime: null };
  }
  if (s.startsWith('Paused')) {
    return { status: 'paused', uptime: null };
  }
  if (s.startsWith('Created')) {
    return { status: 'created', uptime: null };
  }
  if (s.startsWith('Dead')) {
    return { status: 'dead', uptime: null };
  }
  if (s.startsWith('Removing')) {
    return { status: 'removing', uptime: null };
  }

  return { status: s.toLowerCase(), uptime: null };
}

/**
 * Parse `docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'`
 *
 * Example lines:
 *   "ct-frontend\t0.15%\t128.5MiB / 7.77GiB"
 *   "ct-backend\t2.30%\t2.1GiB / 7.77GiB"
 *
 * Returns Map<name, { cpu_percent, memory_mb }>
 */
function parseStatsOutput(output) {
  const stats = new Map();
  const lines = output.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [name, cpuStr, memStr] = parts;

    const cpu_percent = parseFloat(cpuStr.replace('%', '')) || 0;
    const memory_mb = parseMemToMb(memStr);

    stats.set(name.trim(), { cpu_percent, memory_mb });
  }

  return stats;
}

/**
 * Parse memory string like "128.5MiB / 7.77GiB" to MB.
 * Only cares about the used portion (before the slash).
 */
function parseMemToMb(memStr) {
  const used = memStr.split('/')[0].trim();

  const match = used.match(/([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)/i);
  if (!match) return null;

  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 'b': return Math.round(value / 1024 / 1024 * 100) / 100;
    case 'kib': case 'kb': return Math.round(value / 1024 * 100) / 100;
    case 'mib': case 'mb': return Math.round(value * 100) / 100;
    case 'gib': case 'gb': return Math.round(value * 1024 * 100) / 100;
    case 'tib': case 'tb': return Math.round(value * 1024 * 1024 * 100) / 100;
    default: return null;
  }
}

/**
 * Check for stopped/crashed containers and fire container_down alerts.
 * Only alerts for containers that EXIST but are in an unhealthy/stopped state.
 * Destroyed containers (no longer in docker ps -a) are handled separately
 * by handleDestroyedContainers() and do NOT trigger alerts here.
 * Respects cooldown to avoid alert spam.
 */
function checkContainerAlerts(host, containers) {
  const db = getDb();

  // Find enabled container_down alert rules that apply to this host (or all hosts)
  const alertRules = db.prepare(`
    SELECT * FROM alerts
    WHERE metric = 'container_down'
      AND enabled = 1
      AND (host_id IS NULL OR host_id = ?)
  `).all(host.id);

  if (alertRules.length === 0) return;

  // Only alert for containers that EXIST but are not running.
  // "destroyed" status containers are handled by handleDestroyedContainers.
  const nonRunning = containers.filter(
    (c) => c.status !== 'running' && c.status !== 'destroyed'
  );
  if (nonRunning.length === 0) return;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const container of nonRunning) {
    for (const rule of alertRules) {
      // Check cooldown — skip if we already fired for this container recently
      const recent = db.prepare(`
        SELECT id FROM alert_history
        WHERE alert_id = ?
          AND host_id = ?
          AND message LIKE ?
          AND fired_at > datetime('now', ?)
          AND resolved_at IS NULL
      `).get(rule.id, host.id, `%${container.name}%`, `-${rule.cooldown_minutes} minutes`);

      if (recent) continue;

      const message = `Container "${container.name}" is ${container.status} on ${host.name}`;

      db.prepare(`
        INSERT INTO alert_history (alert_id, host_id, fired_at, metric_value, message)
        VALUES (?, ?, ?, ?, ?)
      `).run(rule.id, host.id, now, 0, message);

      broadcast('alert', {
        host_id: host.id,
        host_name: host.name,
        severity: rule.severity,
        message,
        container: container.name,
        status: container.status,
        fired_at: now,
      });

      console.log(`[alert] ${rule.severity}: ${message}`);
    }
  }
}

/**
 * Collect Docker containers from all enabled hosts.
 * Top-level entry point called by the scheduler.
 */
async function collectDockerAll() {
  const db = getDb();
  const hosts = db.prepare('SELECT * FROM hosts WHERE enabled = 1').all();

  const results = await Promise.allSettled(
    hosts.map(async (host) => {
      const containers = await collectDocker(host);
      checkContainerAlerts(host, containers);
      await healCrashedContainers(host, containers);
      return { host: host.name, count: containers.length };
    })
  );

  const summary = results.map((r) => {
    if (r.status === 'fulfilled') {
      return `${r.value.host}: ${r.value.count} containers`;
    }
    return `ERR: ${r.reason?.message}`;
  });

  console.log(`[docker] ${summary.join(', ')}`);
}

module.exports = {
  collectDocker,
  collectDockerAll,
  checkContainerAlerts,
  handleDestroyedContainers,
  parsePsOutput,
  parseStatsOutput,
  parseStatus,
  parseMemToMb,
};
