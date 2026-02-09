// Copyright 2026, TheForge, LLC
const config = require('./config');
const { getDb } = require('./db');

function seedFromConfig() {
  const db = getDb();

  // Seed hosts from config.json
  const insertHost = db.prepare(`
    INSERT OR IGNORE INTO hosts (name, type, ssh_host, ssh_user, ssh_key_path)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const host of config.hosts) {
    insertHost.run(
      host.name,
      host.type || 'ssh',
      host.ssh_host || null,
      host.ssh_user || null,
      host.ssh_key_path || null
    );
  }

  // Seed default alert rules (skip if rule with same metric+operator+threshold exists)
  const insertAlert = db.prepare(`
    INSERT INTO alerts (host_id, metric, operator, threshold, severity)
    SELECT ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM alerts WHERE metric = ? AND operator = ? AND threshold = ? AND host_id IS NULL
    )
  `);
  for (const alert of config.defaultAlerts) {
    insertAlert.run(null, alert.metric, alert.operator, alert.threshold, alert.severity,
      alert.metric, alert.operator, alert.threshold);
  }

  // Seed backup entries from config
  const insertBackup = db.prepare(`
    INSERT OR IGNORE INTO backups (name) VALUES (?)
  `);
  for (const backup of config.backups) {
    insertBackup.run(backup.name);
  }

  console.log(`Seeded ${config.hosts.length} host(s), ${config.defaultAlerts.length} default alert rule(s), ${config.backups.length} backup entry(ies)`);
}

module.exports = { seedFromConfig };
