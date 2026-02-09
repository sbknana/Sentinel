// Copyright 2026, TheForge, LLC
const { execFile } = require('child_process');
const { getDb } = require('../db');
const config = require('../config');
const { broadcast } = require('../sse');

const RESTIC_TIMEOUT_MS = 30000;

/**
 * Run restic snapshots for a given repo and return the latest snapshot time.
 * Returns { lastSuccess, details } or { error, details }.
 */
function checkResticRepo(backupConfig) {
  return new Promise((resolve) => {
    const env = { ...process.env };

    // Support password from config or env var named RESTIC_PASSWORD_<NAME>
    const envKey = `RESTIC_PASSWORD_${backupConfig.name.toUpperCase().replace(/-/g, '_')}`;
    if (process.env[envKey]) {
      env.RESTIC_PASSWORD = process.env[envKey];
    } else if (backupConfig.password_file) {
      env.RESTIC_PASSWORD_FILE = backupConfig.password_file;
    }

    // Support S3/REST/SFTP backends via env vars
    if (backupConfig.aws_access_key_id) {
      env.AWS_ACCESS_KEY_ID = backupConfig.aws_access_key_id;
    }
    if (backupConfig.aws_secret_access_key) {
      env.AWS_SECRET_ACCESS_KEY = backupConfig.aws_secret_access_key;
    }

    const args = ['snapshots', '--repo', backupConfig.repo_path, '--json', '--latest', '1'];

    execFile('restic', args, { timeout: RESTIC_TIMEOUT_MS, env }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr ? stderr.trim() : err.message;
        resolve({ error: true, details: msg });
        return;
      }

      try {
        const snapshots = JSON.parse(stdout);
        if (!snapshots || snapshots.length === 0) {
          resolve({ error: false, lastSuccess: null, details: 'No snapshots found in repository' });
          return;
        }

        const latest = snapshots[0];
        const lastSuccess = latest.time; // ISO 8601 timestamp from restic
        const hostname = latest.hostname || 'unknown';
        const paths = (latest.paths || []).join(', ');
        resolve({
          error: false,
          lastSuccess,
          details: `host=${hostname} paths=${paths}`,
        });
      } catch (parseErr) {
        resolve({ error: true, details: `Failed to parse restic output: ${parseErr.message}` });
      }
    });
  });
}

/**
 * Determine backup status based on last success time and stale threshold.
 */
function computeStatus(lastSuccess, staleHours) {
  if (!lastSuccess) return 'error';

  const lastTime = new Date(lastSuccess).getTime();
  if (isNaN(lastTime)) return 'error';

  const ageMs = Date.now() - lastTime;
  const ageHours = ageMs / (1000 * 60 * 60);

  return ageHours > staleHours ? 'stale' : 'ok';
}

/**
 * Check all configured backups and update the database.
 * Returns array of results for each backup.
 */
async function collectBackupStatus() {
  const db = getDb();
  const results = [];

  for (const backupConfig of config.backups) {
    if (backupConfig.type !== 'restic') {
      // Only restic is supported for now
      continue;
    }

    const staleHours = backupConfig.stale_hours || 24;
    const now = new Date().toISOString();
    let status, lastSuccess, details;

    const result = await checkResticRepo(backupConfig);

    if (result.error) {
      status = 'error';
      lastSuccess = null;
      details = result.details;
    } else {
      lastSuccess = result.lastSuccess;
      status = computeStatus(lastSuccess, staleHours);
      details = result.details;
    }

    // Update the backups table
    db.prepare(`
      UPDATE backups
      SET last_check = ?, last_success = ?, status = ?, details = ?
      WHERE name = ?
    `).run(now, lastSuccess, status, details, backupConfig.name);

    const entry = { name: backupConfig.name, status, lastSuccess, lastCheck: now, details, staleHours };
    results.push(entry);

    // Broadcast via SSE
    broadcast('backup', entry);

    // If stale or error, fire an alert (if alert engine exists, we insert into alert_history)
    if (status === 'stale' || status === 'error') {
      fireBackupAlert(db, backupConfig.name, status, lastSuccess, staleHours);
    } else {
      resolveBackupAlerts(db, backupConfig.name);
    }
  }

  return results;
}

/**
 * Fire an alert for a stale/error backup if not already active (respects cooldown).
 */
function fireBackupAlert(db, backupName, status, lastSuccess, staleHours) {
  // Find a matching alert rule for backup_stale
  const alertRule = db.prepare(
    "SELECT * FROM alerts WHERE metric = 'backup_stale' AND enabled = 1"
  ).get();

  if (!alertRule) return; // No alert rule configured for backups

  // Check cooldown: don't re-fire if an unresolved alert exists within cooldown period
  const existing = db.prepare(`
    SELECT * FROM alert_history
    WHERE alert_id = ? AND message LIKE ? AND resolved_at IS NULL
    AND fired_at > datetime('now', ?)
  `).get(alertRule.id, `%${backupName}%`, `-${alertRule.cooldown_minutes} minutes`);

  if (existing) return; // Already alerted, within cooldown

  const ageHours = lastSuccess
    ? ((Date.now() - new Date(lastSuccess).getTime()) / (1000 * 60 * 60)).toFixed(1)
    : 'unknown';

  const message = status === 'stale'
    ? `Backup "${backupName}" is stale: last success ${ageHours}h ago (threshold: ${staleHours}h)`
    : `Backup "${backupName}" check failed: error reading repository`;

  // alert_history requires a host_id; use NULL-safe approach — backup alerts aren't host-specific
  // Since host_id is NOT NULL in alert_history, use host_id=1 (claudinator) as the backup host
  const claudinator = db.prepare("SELECT id FROM hosts WHERE name = 'claudinator'").get();
  const hostId = claudinator ? claudinator.id : 1;

  db.prepare(`
    INSERT INTO alert_history (alert_id, host_id, fired_at, metric_value, message)
    VALUES (?, ?, datetime('now'), ?, ?)
  `).run(alertRule.id, hostId, parseFloat(ageHours) || 0, message);

  broadcast('alert', { backup: backupName, status, message, severity: alertRule.severity });
}

/**
 * Resolve any active backup alerts when backup is OK again.
 */
function resolveBackupAlerts(db, backupName) {
  const alertRule = db.prepare(
    "SELECT * FROM alerts WHERE metric = 'backup_stale' AND enabled = 1"
  ).get();

  if (!alertRule) return;

  db.prepare(`
    UPDATE alert_history
    SET resolved_at = datetime('now')
    WHERE alert_id = ? AND message LIKE ? AND resolved_at IS NULL
  `).run(alertRule.id, `%${backupName}%`);
}

module.exports = { collectBackupStatus, checkResticRepo, computeStatus };
