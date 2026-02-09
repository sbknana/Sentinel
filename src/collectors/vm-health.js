// Copyright 2026, TheForge, LLC
const fs = require('fs');
const { execFileSync } = require('child_process');
const { Client } = require('ssh2');
const { getDb } = require('../db');
const { broadcast } = require('../sse');
const { evaluateMetricAlerts, evaluateHostDownAlert, resolveHostDownAlert } = require('../alerts/engine');

// Shell script that gathers all system metrics.
// Uses only POSIX-compatible constructs plus /proc (standard Linux).
// Output: pipe-delimited values on a single line.
// SSH exec runs commands through the remote user's shell (usually bash),
// so arithmetic expansion $(( )) works fine over SSH.
// For local exec we use execFileSync with bash explicitly.
const METRICS_SCRIPT = `
read -r _ a1 b1 c1 d1 _ < /proc/stat
sleep 1
read -r _ a2 b2 c2 d2 _ < /proc/stat
idle=$(( d2 - d1 ))
total=$(( (a2+b2+c2+d2) - (a1+b1+c1+d1) ))
if [ "$total" -gt 0 ]; then cpu=$(( (total - idle) * 10000 / total )); else cpu=0; fi

mem_total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
mem_used=$(( mem_total - mem_avail ))
if [ "$mem_total" -gt 0 ]; then mem_pct=$(( mem_used * 10000 / mem_total )); else mem_pct=0; fi

disk_line=$(df -BG / | tail -1)
disk_total=$(echo "$disk_line" | awk '{gsub("G",""); print $2}')
disk_used=$(echo "$disk_line" | awk '{gsub("G",""); print $3}')
disk_pct_raw=$(echo "$disk_line" | awk '{gsub("%",""); print $5}')

read -r l1 l5 l15 _ < /proc/loadavg
uptime_s=$(awk '{printf "%d", $1}' /proc/uptime)

echo "\${cpu}|\${mem_pct}|\${mem_used}|\${mem_total}|\${disk_pct_raw}|\${disk_used}|\${disk_total}|\${l1}|\${l5}|\${l15}|\${uptime_s}"
`.trim();

/**
 * Parse the pipe-delimited output from METRICS_SCRIPT into a metrics object.
 */
function parseMetricsOutput(stdout) {
  // Take the last non-empty line (skip any shell noise)
  const lines = stdout.trim().split('\n');
  const line = lines[lines.length - 1].trim();
  if (!line) return null;

  const parts = line.split('|');
  if (parts.length < 11) return null;

  const cpuCentipercent = parseInt(parts[0], 10);
  const memCentipercent = parseInt(parts[1], 10);
  const memUsedKb = parseInt(parts[2], 10);
  const memTotalKb = parseInt(parts[3], 10);
  const diskPct = parseFloat(parts[4]);
  const diskUsedGb = parseFloat(parts[5]);
  const diskTotalGb = parseFloat(parts[6]);
  const load1 = parseFloat(parts[7]);
  const load5 = parseFloat(parts[8]);
  const load15 = parseFloat(parts[9]);
  const uptimeSeconds = parseInt(parts[10], 10);

  return {
    cpu_percent: Math.round(cpuCentipercent) / 100,
    memory_percent: Math.round(memCentipercent) / 100,
    memory_used_mb: Math.round(memUsedKb / 1024),
    memory_total_mb: Math.round(memTotalKb / 1024),
    disk_percent: isNaN(diskPct) ? null : diskPct,
    disk_used_gb: isNaN(diskUsedGb) ? null : diskUsedGb,
    disk_total_gb: isNaN(diskTotalGb) ? null : diskTotalGb,
    load_1m: isNaN(load1) ? null : load1,
    load_5m: isNaN(load5) ? null : load5,
    load_15m: isNaN(load15) ? null : load15,
    uptime_seconds: isNaN(uptimeSeconds) ? null : uptimeSeconds,
  };
}

/**
 * Collect metrics from the local host using execFileSync with bash.
 * execFileSync avoids shell interpretation issues — the script is passed
 * as a single -c argument to bash, no quoting problems.
 */
function collectLocal() {
  try {
    const stdout = execFileSync('/bin/bash', ['-c', METRICS_SCRIPT], {
      timeout: 10000,
      encoding: 'utf8',
    });
    return parseMetricsOutput(stdout);
  } catch (err) {
    console.error('[collector] Local collection failed:', err.message);
    return null;
  }
}

/**
 * Collect metrics from a remote host via SSH.
 * Returns a promise that resolves with the metrics object or null on failure.
 */
function collectSSH(host) {
  return new Promise((resolve) => {
    const conn = new Client();
    let timer;

    const cleanup = () => {
      clearTimeout(timer);
      try { conn.end(); } catch (_) {}
    };

    // 15-second timeout for the entire SSH operation
    timer = setTimeout(() => {
      console.error(`[collector] SSH timeout for ${host.name} (${host.ssh_host})`);
      cleanup();
      resolve(null);
    }, 15000);

    conn.on('ready', () => {
      conn.exec(METRICS_SCRIPT, (err, stream) => {
        if (err) {
          console.error(`[collector] SSH exec error for ${host.name}:`, err.message);
          cleanup();
          return resolve(null);
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });
        stream.on('close', () => {
          cleanup();
          if (stderr.trim()) {
            console.error(`[collector] SSH stderr from ${host.name}:`, stderr.trim());
          }
          const metrics = parseMetricsOutput(stdout);
          if (!metrics) {
            console.error(`[collector] Failed to parse metrics from ${host.name}. Raw output: ${stdout.trim()}`);
          }
          resolve(metrics);
        });
      });
    });

    conn.on('error', (err) => {
      console.error(`[collector] SSH connection error for ${host.name} (${host.ssh_host}):`, err.message);
      cleanup();
      resolve(null);
    });

    // Build connection config
    const connConfig = {
      host: host.ssh_host,
      port: 22,
      username: host.ssh_user || 'user',
      readyTimeout: 10000,
    };

    // Use SSH key if configured and file exists
    const keyPath = host.ssh_key_path;
    if (keyPath && fs.existsSync(keyPath)) {
      connConfig.privateKey = fs.readFileSync(keyPath);
    }

    conn.connect(connConfig);
  });
}

/**
 * Store a metrics snapshot in the database and broadcast via SSE.
 */
function storeMetrics(hostId, hostName, metrics) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO metrics (host_id, cpu_percent, memory_percent, memory_used_mb,
      memory_total_mb, disk_percent, disk_used_gb, disk_total_gb,
      load_1m, load_5m, load_15m, uptime_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    hostId,
    metrics.cpu_percent,
    metrics.memory_percent,
    metrics.memory_used_mb,
    metrics.memory_total_mb,
    metrics.disk_percent,
    metrics.disk_used_gb,
    metrics.disk_total_gb,
    metrics.load_1m,
    metrics.load_5m,
    metrics.load_15m,
    metrics.uptime_seconds
  );

  // Broadcast to SSE clients
  broadcast('metrics', {
    host_id: hostId,
    host_name: hostName,
    ...metrics,
    collected_at: new Date().toISOString(),
  });
}

/**
 * Run a single collection cycle across all enabled hosts.
 */
async function collectAll() {
  const db = getDb();
  const hosts = db.prepare('SELECT * FROM hosts WHERE enabled = 1').all();

  const promises = hosts.map(async (host) => {
    let metrics = null;

    if (host.type === 'local') {
      metrics = collectLocal();
    } else if (host.type === 'ssh') {
      metrics = await collectSSH(host);
    } else {
      console.error(`[collector] Unknown host type "${host.type}" for ${host.name}`);
      return;
    }

    if (metrics) {
      storeMetrics(host.id, host.name, metrics);
      console.log(`[collector] ${host.name}: CPU=${metrics.cpu_percent}% MEM=${metrics.memory_percent}% DISK=${metrics.disk_percent}% LOAD=${metrics.load_1m}`);
      // Evaluate alert thresholds against collected metrics
      evaluateMetricAlerts(host.id, host.name, metrics);
      // Host is reachable — resolve any service_down alerts
      resolveHostDownAlert(host.id);
    } else {
      console.error(`[collector] ${host.name}: collection failed`);
      // Host unreachable — fire service_down alert if configured
      evaluateHostDownAlert(host.id, host.name);
    }
  });

  await Promise.all(promises);
}

module.exports = { collectAll, collectLocal, collectSSH, parseMetricsOutput };
