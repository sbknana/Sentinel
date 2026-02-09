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

  // Seed default alert rules (only if alerts table is empty)
  const alertCount = db.prepare('SELECT COUNT(*) AS count FROM alerts').get();
  if (alertCount.count === 0) {
    const insertAlert = db.prepare(`
      INSERT INTO alerts (host_id, metric, operator, threshold, severity)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const alert of config.defaultAlerts) {
      insertAlert.run(null, alert.metric, alert.operator, alert.threshold, alert.severity);
    }
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
