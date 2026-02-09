// Copyright 2026, TheForge, LLC
const { getDb } = require('../db');
const { broadcast } = require('../sse');

// Metrics that this engine evaluates against the latest collected values.
// container_down and backup_stale are handled by their own collectors.
const METRIC_ALERT_TYPES = new Set([
  'cpu_percent',
  'memory_percent',
  'disk_percent',
  'load_1m',
  'load_5m',
  'load_15m',
]);

/**
 * Compare a metric value against a threshold using the given operator.
 * Returns true if the condition is met (alert should fire).
 */
function evaluate(value, operator, threshold) {
  switch (operator) {
    case '>': return value > threshold;
    case '<': return value < threshold;
    case '==': return value === threshold;
    default: return false;
  }
}

/**
 * Check whether an alert is still within its cooldown period.
 * Returns true if a recent unresolved alert exists (should skip firing).
 */
function isInCooldown(db, alertId, hostId, cooldownMinutes) {
  const recent = db.prepare(`
    SELECT id FROM alert_history
    WHERE alert_id = ?
      AND host_id = ?
      AND fired_at > datetime('now', ?)
      AND resolved_at IS NULL
  `).get(alertId, hostId, `-${cooldownMinutes} minutes`);
  return !!recent;
}

/**
 * Fire an alert: insert into alert_history and broadcast via SSE.
 */
function fireAlert(db, rule, hostId, hostName, metricValue) {
  const message = `${rule.metric} is ${metricValue} on ${hostName} (threshold: ${rule.operator} ${rule.threshold})`;

  db.prepare(`
    INSERT INTO alert_history (alert_id, host_id, fired_at, metric_value, message)
    VALUES (?, ?, datetime('now'), ?, ?)
  `).run(rule.id, hostId, metricValue, message);

  broadcast('alert', {
    alert_id: rule.id,
    host_id: hostId,
    host_name: hostName,
    severity: rule.severity,
    metric: rule.metric,
    metric_value: metricValue,
    threshold: rule.threshold,
    operator: rule.operator,
    message,
    fired_at: new Date().toISOString(),
  });

  console.log(`[alert] ${rule.severity}: ${message}`);
}

/**
 * Auto-resolve alerts when the metric returns to normal.
 * Finds unresolved alert_history entries for this rule+host and marks them resolved.
 */
function autoResolve(db, ruleId, hostId) {
  const result = db.prepare(`
    UPDATE alert_history
    SET resolved_at = datetime('now')
    WHERE alert_id = ? AND host_id = ? AND resolved_at IS NULL
  `).run(ruleId, hostId);

  if (result.changes > 0) {
    console.log(`[alert] Auto-resolved ${result.changes} alert(s) for rule ${ruleId} on host ${hostId}`);
  }
}

/**
 * Evaluate all enabled metric-based alert rules against the latest metrics
 * for a specific host. Call this after each metrics collection cycle.
 *
 * @param {number} hostId - The host ID that was just collected
 * @param {string} hostName - The host name (for alert messages)
 * @param {object} metrics - The metrics object from the collector
 */
function evaluateMetricAlerts(hostId, hostName, metrics) {
  if (!metrics) return;

  const db = getDb();

  // Get all enabled alert rules that apply to this host (or all hosts)
  const rules = db.prepare(`
    SELECT * FROM alerts
    WHERE enabled = 1
      AND (host_id IS NULL OR host_id = ?)
      AND metric IN (${[...METRIC_ALERT_TYPES].map(() => '?').join(', ')})
  `).all(hostId, ...METRIC_ALERT_TYPES);

  for (const rule of rules) {
    const value = metrics[rule.metric];
    if (value == null) continue;

    const triggered = evaluate(value, rule.operator, rule.threshold);

    if (triggered) {
      if (!isInCooldown(db, rule.id, hostId, rule.cooldown_minutes)) {
        fireAlert(db, rule, hostId, hostName, value);
      }
    } else {
      // Metric is back to normal — auto-resolve any active alerts
      autoResolve(db, rule.id, hostId);
    }
  }
}

/**
 * Evaluate a "service_down" alert when a host fails metric collection.
 * This fires when SSH/local collection returns null (host unreachable).
 *
 * @param {number} hostId - The host ID that failed collection
 * @param {string} hostName - The host name
 */
function evaluateHostDownAlert(hostId, hostName) {
  const db = getDb();

  const rules = db.prepare(`
    SELECT * FROM alerts
    WHERE enabled = 1
      AND metric = 'service_down'
      AND (host_id IS NULL OR host_id = ?)
  `).all(hostId);

  for (const rule of rules) {
    if (!isInCooldown(db, rule.id, hostId, rule.cooldown_minutes)) {
      const message = `Host "${hostName}" is unreachable (metric collection failed)`;

      db.prepare(`
        INSERT INTO alert_history (alert_id, host_id, fired_at, metric_value, message)
        VALUES (?, ?, datetime('now'), ?, ?)
      `).run(rule.id, hostId, 0, message);

      broadcast('alert', {
        alert_id: rule.id,
        host_id: hostId,
        host_name: hostName,
        severity: rule.severity,
        metric: 'service_down',
        message,
        fired_at: new Date().toISOString(),
      });

      console.log(`[alert] ${rule.severity}: ${message}`);
    }
  }
}

/**
 * Resolve service_down alerts when a host comes back online.
 *
 * @param {number} hostId - The host ID that successfully collected
 */
function resolveHostDownAlert(hostId) {
  const db = getDb();

  const rules = db.prepare(`
    SELECT id FROM alerts
    WHERE enabled = 1 AND metric = 'service_down'
      AND (host_id IS NULL OR host_id = ?)
  `).all(hostId);

  for (const rule of rules) {
    autoResolve(db, rule.id, hostId);
  }
}

module.exports = {
  evaluateMetricAlerts,
  evaluateHostDownAlert,
  resolveHostDownAlert,
  evaluate,
  isInCooldown,
  METRIC_ALERT_TYPES,
};
