// Copyright 2026, TheForge, LLC
const { getDb } = require('../db');
const { execOnHost } = require('../ssh');
const { broadcast } = require('../sse');

// Commands from CLAUDE.md spec
const DOCKER_PS_CMD = "docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'";
const DOCKER_STATS_CMD = "docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'";

/**
 * Collect Docker container data from a single host.
 * Runs docker ps -a for all containers and docker stats for resource usage.
 * Stores results in the containers table and broadcasts via SSE.
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
  if (containers.length === 0) {
    return [];
  }

  // Get resource usage for running containers
  let statsOutput = '';
  try {
    statsOutput = await execOnHost(host, DOCKER_STATS_CMD);
  } catch (err) {
    // docker stats can fail if no containers are running — not fatal
    console.warn(`[docker] Failed to get stats on ${host.name}: ${err.message}`);
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

  // Store in database
  const insert = db.prepare(`
    INSERT INTO containers (host_id, collected_at, container_id, name, image, status, uptime, cpu_percent, memory_mb)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        c.memory_mb
      );
    }
  });

  insertMany(containers);

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

  const nonRunning = containers.filter((c) => c.status !== 'running');
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

module.exports = { collectDocker, collectDockerAll, checkContainerAlerts, parsePsOutput, parseStatsOutput, parseStatus, parseMemToMb };
