// Copyright 2026, Forgeborn
const express = require('express');
const tls = require('tls');
const net = require('net');
const { execFile } = require('child_process');
const { getDb } = require('../db');
const config = require('../config');
const { execOnHost } = require('../ssh');

const router = express.Router();

// ============================================================
// CACHE — 60 second TTL to avoid hammering servers
// ============================================================

const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

async function cachedFetch(key, fetchFn) {
  const hit = getCached(key);
  if (hit) return hit;
  const data = await fetchFn();
  setCache(key, data);
  return data;
}

// ============================================================
// HELPERS
// ============================================================

function execLocal(command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', ['-c', command], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

// ============================================================
// SSL CERTIFICATE CHECKS — using tls.connect()
// ============================================================

const DOMAINS = [
  'loom.forgeborn.dev',
  'tcgkungfu.com',
  'forgeborn.dev',
];

function checkSSLCert(domain) {
  return new Promise((resolve) => {
    const socket = tls.connect(443, domain, { servername: domain, rejectUnauthorized: false }, () => {
      try {
        const cert = socket.getPeerCertificate();
        socket.end();

        if (!cert || !cert.valid_to) {
          resolve({ domain, status: 'red', days_left: null, expires: null, issued: null, subject: '', error: 'No certificate returned' });
          return;
        }

        const expiresDate = new Date(cert.valid_to);
        const issuedDate = new Date(cert.valid_from);
        const now = new Date();
        const daysLeft = Math.floor((expiresDate - now) / (1000 * 60 * 60 * 24));

        let status = 'green';
        if (daysLeft <= 7) status = 'red';
        else if (daysLeft <= 30) status = 'yellow';

        const subject = cert.subject ? (cert.subject.CN || '') : '';

        resolve({
          domain,
          status,
          days_left: daysLeft,
          expires: cert.valid_to,
          issued: cert.valid_from,
          subject,
          issuer: cert.issuer ? (cert.issuer.O || '') : '',
        });
      } catch (e) {
        socket.end();
        resolve({ domain, status: 'red', days_left: null, expires: null, issued: null, subject: '', error: e.message });
      }
    });

    socket.setTimeout(10000, () => {
      socket.destroy();
      resolve({ domain, status: 'red', days_left: null, expires: null, issued: null, subject: '', error: 'Connection timeout' });
    });

    socket.on('error', (err) => {
      resolve({ domain, status: 'red', days_left: null, expires: null, issued: null, subject: '', error: err.message });
    });
  });
}

// ============================================================
// SERVICE HEALTH CHECKS — TCP connect to known services
// ============================================================

const SERVICES = [
  { name: 'Sentinel', host: 'localhost', port: 3002, description: 'Infrastructure monitor' },
  { name: 'ArcaneDesk Web', host: '10.10.10.3', port: 3000, description: 'ArcaneDesk frontend' },
  { name: 'CryptoTrader Web', host: '10.10.10.2', port: 3000, description: 'CryptoTrader frontend' },
];

function checkService(service) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const socket = new net.Socket();

    socket.setTimeout(5000);

    socket.connect(service.port, service.host, () => {
      const latency = Date.now() - startTime;
      socket.destroy();
      resolve({
        name: service.name,
        host: service.host,
        port: service.port,
        description: service.description,
        status: 'up',
        latency_ms: latency,
      });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({
        name: service.name,
        host: service.host,
        port: service.port,
        description: service.description,
        status: 'down',
        latency_ms: null,
        error: 'Connection timeout',
      });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({
        name: service.name,
        host: service.host,
        port: service.port,
        description: service.description,
        status: 'down',
        latency_ms: null,
        error: err.message,
      });
    });
  });
}

// ============================================================
// FAIL2BAN STATS
// ============================================================

async function getFail2banStats(host) {
  try {
    const cmd = 'sudo fail2ban-client status 2>/dev/null || echo "fail2ban_not_available"';
    const output = await execOnHost(host, cmd, 10000);
    if (output.includes('fail2ban_not_available')) {
      return { host: host.name, available: false, jails: [] };
    }
    const jailMatch = output.match(/Jail list:\s*(.*)/);
    const jailNames = jailMatch ? jailMatch[1].split(',').map(j => j.trim()).filter(Boolean) : [];

    const jails = [];
    for (const jail of jailNames) {
      try {
        const jailOutput = await execOnHost(host, `sudo fail2ban-client status ${jail} 2>/dev/null`, 8000);
        const bannedMatch = jailOutput.match(/Currently banned:\s*(\d+)/);
        const totalMatch = jailOutput.match(/Total banned:\s*(\d+)/);
        const failedMatch = jailOutput.match(/Currently failed:\s*(\d+)/);
        const totalFailedMatch = jailOutput.match(/Total failed:\s*(\d+)/);
        const ipListMatch = jailOutput.match(/Banned IP list:\s*(.*)/);
        jails.push({
          name: jail,
          currently_banned: bannedMatch ? parseInt(bannedMatch[1]) : 0,
          total_banned: totalMatch ? parseInt(totalMatch[1]) : 0,
          currently_failed: failedMatch ? parseInt(failedMatch[1]) : 0,
          total_failed: totalFailedMatch ? parseInt(totalFailedMatch[1]) : 0,
          banned_ips: ipListMatch ? ipListMatch[1].trim().split(/\s+/).filter(Boolean) : [],
        });
      } catch {
        jails.push({ name: jail, error: 'Could not fetch status' });
      }
    }

    return { host: host.name, available: true, jails };
  } catch (e) {
    return { host: host.name, available: false, error: e.message, jails: [] };
  }
}

// ============================================================
// OPEN PORT SCAN
// ============================================================

async function getOpenPorts(host) {
  try {
    const cmd = "ss -tlnp 2>/dev/null | tail -n +2 | awk '{print $4}' | sed 's/.*://' | sort -un";
    const output = await execOnHost(host, cmd, 10000);
    const ports = output.split('\n').filter(Boolean).map(p => parseInt(p)).filter(p => !isNaN(p));
    return { host: host.name, ports, count: ports.length };
  } catch (e) {
    return { host: host.name, ports: [], count: 0, error: e.message };
  }
}

// ============================================================
// SYSTEM RESOURCE ALERTS
// ============================================================

async function getSystemAlerts(host) {
  try {
    const cmd = `
      echo "CPU:$(top -bn1 | head -3 | grep 'Cpu' | awk '{print 100 - $8}' 2>/dev/null || echo 'N/A')"
      echo "MEM:$(free -m 2>/dev/null | awk '/Mem:/{printf "%.1f", $3/$2*100}' || echo 'N/A')"
      echo "DISK:$(df -h / 2>/dev/null | awk 'NR==2{print $5}' | tr -d '%' || echo 'N/A')"
      echo "LOAD:$(cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}' || echo 'N/A')"
      echo "UPTIME:$(uptime -p 2>/dev/null || echo 'N/A')"
    `;
    const output = await execOnHost(host, cmd, 10000);
    const lines = output.split('\n');
    const data = {};
    for (const line of lines) {
      const [key, ...rest] = line.split(':');
      if (key && rest.length > 0) data[key.trim()] = rest.join(':').trim();
    }

    const cpu = parseFloat(data.CPU) || 0;
    const mem = parseFloat(data.MEM) || 0;
    const disk = parseFloat(data.DISK) || 0;
    const load = data.LOAD || '';
    const uptime = data.UPTIME || '';

    const alerts = [];
    if (cpu > 90) alerts.push({ metric: 'CPU', value: cpu, severity: 'red', message: `CPU at ${cpu.toFixed(1)}%` });
    else if (cpu > 70) alerts.push({ metric: 'CPU', value: cpu, severity: 'yellow', message: `CPU at ${cpu.toFixed(1)}%` });

    if (mem > 85) alerts.push({ metric: 'Memory', value: mem, severity: 'red', message: `Memory at ${mem.toFixed(1)}%` });
    else if (mem > 70) alerts.push({ metric: 'Memory', value: mem, severity: 'yellow', message: `Memory at ${mem.toFixed(1)}%` });

    if (disk > 90) alerts.push({ metric: 'Disk', value: disk, severity: 'red', message: `Disk at ${disk}%` });
    else if (disk > 75) alerts.push({ metric: 'Disk', value: disk, severity: 'yellow', message: `Disk at ${disk}%` });

    return {
      host: host.name,
      cpu, mem, disk, load, uptime,
      alerts,
      status: alerts.some(a => a.severity === 'red') ? 'red' : alerts.length > 0 ? 'yellow' : 'green',
    };
  } catch (e) {
    return { host: host.name, cpu: 0, mem: 0, disk: 0, load: '', uptime: '', alerts: [], status: 'red', error: e.message };
  }
}

// ============================================================
// BACKUP STATUS (reuse existing)
// ============================================================

function getBackupStatus() {
  const db = getDb();
  const backups = db.prepare('SELECT * FROM backups ORDER BY name').all();
  const configMap = {};
  for (const b of config.backups) {
    configMap[b.name] = b;
  }
  return backups.map((b) => {
    const cfg = configMap[b.name] || {};
    const ageHours = b.last_success
      ? ((Date.now() - new Date(b.last_success).getTime()) / (1000 * 60 * 60))
      : null;
    const staleHours = cfg.stale_hours || 24;
    let status = 'green';
    if (ageHours === null) status = 'red';
    else if (ageHours > staleHours) status = 'red';
    else if (ageHours > staleHours * 0.8) status = 'yellow';
    return {
      name: b.name,
      description: cfg.description || '',
      status,
      last_success: b.last_success,
      age_hours: ageHours ? parseFloat(ageHours.toFixed(1)) : null,
      stale_hours: staleHours,
    };
  });
}

// ============================================================
// NPM AUDIT / DEPENDENCY VULNERABILITIES
// ============================================================

async function getNpmAuditSummary() {
  const projects = [
    { name: 'Sentinel', path: '/srv/forge-share/AI_Stuff/Sentinel' },
    { name: 'MTG-Kiosk', path: '/srv/forge-share/AI_Stuff/MTG-Kiosk' },
  ];

  const results = [];
  for (const proj of projects) {
    try {
      const cmd = `cd "${proj.path}" && npm audit --json 2>/dev/null | head -200`;
      const output = await execLocal(cmd, 30000);
      const data = JSON.parse(output);
      const meta = data.metadata || {};
      const vulns = meta.vulnerabilities || {};
      results.push({
        project: proj.name,
        total: (vulns.low || 0) + (vulns.moderate || 0) + (vulns.high || 0) + (vulns.critical || 0),
        critical: vulns.critical || 0,
        high: vulns.high || 0,
        moderate: vulns.moderate || 0,
        low: vulns.low || 0,
        status: (vulns.critical || 0) > 0 ? 'red' : (vulns.high || 0) > 0 ? 'yellow' : 'green',
      });
    } catch {
      results.push({ project: proj.name, total: 0, critical: 0, high: 0, moderate: 0, low: 0, status: 'green', error: 'audit unavailable' });
    }
  }
  return results;
}

// ============================================================
// API ENDPOINTS (all cached at 60s)
// ============================================================

// GET /api/guard/ssl - SSL certificate status
router.get('/ssl', async (req, res) => {
  try {
    const results = await cachedFetch('ssl', () => Promise.all(DOMAINS.map(checkSSLCert)));
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/guard/services - Service health (TCP ping)
router.get('/services', async (req, res) => {
  try {
    const results = await cachedFetch('services', () => Promise.all(SERVICES.map(checkService)));
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/guard/fail2ban - Fail2ban stats from all hosts
router.get('/fail2ban', async (req, res) => {
  try {
    const results = await cachedFetch('fail2ban', async () => {
      const db = getDb();
      const hosts = db.prepare('SELECT * FROM hosts WHERE enabled = 1 ORDER BY name').all();
      return Promise.all(hosts.map(getFail2banStats));
    });
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/guard/ports - Open port scan
router.get('/ports', async (req, res) => {
  try {
    const results = await cachedFetch('ports', async () => {
      const db = getDb();
      const hosts = db.prepare('SELECT * FROM hosts WHERE enabled = 1 ORDER BY name').all();
      return Promise.all(hosts.map(getOpenPorts));
    });
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/guard/deps - npm audit summary
router.get('/deps', async (req, res) => {
  try {
    const results = await cachedFetch('deps', getNpmAuditSummary);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/guard/backups - Backup status with traffic light
router.get('/backups', async (req, res) => {
  try {
    const results = await cachedFetch('backups', async () => getBackupStatus());
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/guard/resources - System resource alerts
router.get('/resources', async (req, res) => {
  try {
    const results = await cachedFetch('resources', async () => {
      const db = getDb();
      const hosts = db.prepare('SELECT * FROM hosts WHERE enabled = 1 ORDER BY name').all();
      return Promise.all(hosts.map(getSystemAlerts));
    });
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/guard/summary - Quick overall summary
router.get('/summary', async (req, res) => {
  try {
    const [ssl, backups, services] = await Promise.all([
      cachedFetch('ssl', () => Promise.all(DOMAINS.map(checkSSLCert))),
      cachedFetch('backups', async () => getBackupStatus()),
      cachedFetch('services', () => Promise.all(SERVICES.map(checkService))),
    ]);

    const sslIssues = ssl.filter(s => s.status !== 'green').length;
    const backupIssues = backups.filter(b => b.status !== 'green').length;
    const servicesDown = services.filter(s => s.status === 'down').length;

    const criticalCount = ssl.filter(s => s.status === 'red').length +
      backups.filter(b => b.status === 'red').length + servicesDown;
    const overallStatus = criticalCount > 0 ? 'red' :
      (sslIssues > 0 || backupIssues > 0) ? 'yellow' : 'green';

    res.json({
      status: overallStatus,
      ssl_issues: sslIssues,
      backup_issues: backupIssues,
      services_down: servicesDown,
      critical: criticalCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
