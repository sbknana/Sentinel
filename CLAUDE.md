# CLAUDE.md — Sentinel

## Project Overview

**TheForge project_id:** 26
**Status:** Planning
**Category:** Infrastructure
**Copyright:** 2026, TheForge, LLC

Real-time infrastructure monitoring and alerting dashboard for TheForge ecosystem. Monitors VMs, Docker containers, services, orchestrator progress, and backup status. Runs on Claudinator:3000 (the Ubuntu host machine). Provides instant visibility into all infrastructure without manually SSHing into each VM.

---

## Problem Statement

Every session involves manually SSHing into 3+ VMs to check health, services, disk space, and orchestrator status. This is tedious, error-prone, and offers no proactive alerting. Sentinel replaces that manual workflow with a single dashboard that auto-refreshes and alerts when things go wrong.

---

## Tech Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| Runtime | Node.js 22+ | Already available on Claudinator, good for async I/O |
| Server | Express.js | Minimal, well-known, sufficient for this use case |
| Database | SQLite (better-sqlite3) | No external DB server needed, perfect for time-series metrics at this scale |
| Real-time | Server-Sent Events (SSE) | Simpler than WebSockets, one-way push is all we need |
| Frontend | Vanilla HTML/CSS/JS | No build step, no framework overhead, ship fast |
| SSH | ssh2 (npm) | Pure JS SSH client, no shell-out needed for VM metrics |
| Scheduling | node-cron | Lightweight cron-style scheduling for collection intervals |
| Process manager | systemd | Run Sentinel as a system service on Claudinator |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Claudinator (Host)                     │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │               Sentinel (Node.js :3000)               │ │
│  │                                                       │ │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────────────┐ │ │
│  │  │ Collector │  │   API    │  │   SSE Broadcaster  │ │ │
│  │  │  Engine   │  │  Server  │  │                    │ │ │
│  │  └────┬─────┘  └────┬─────┘  └────────┬───────────┘ │ │
│  │       │              │                 │             │ │
│  │       v              v                 v             │ │
│  │  ┌──────────────────────────────────────────┐       │ │
│  │  │          SQLite (sentinel.db)             │       │ │
│  │  │  metrics | alerts | config | alert_history│       │ │
│  │  └──────────────────────────────────────────┘       │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  SSH (10.10.10.x)      SSH (10.10.10.x)     Local        │
│       │                      │                │           │
│       v                      v                v           │
│  ┌─────────┐          ┌──────────┐     ┌────────────┐    │
│  │ VM: CT  │          │ VM: AD   │     │ TheForge   │    │
│  │ Docker  │          │ Docker   │     │  SQLite DB │    │
│  └─────────┘          └──────────┘     └────────────┘    │
```

### Components

1. **Collector Engine** — Runs on configurable intervals (default: 30s). SSHes into each VM, gathers system metrics, Docker container status, and service health. Also reads TheForge DB locally for task/orchestrator data. Stores all metrics in SQLite with timestamps.

2. **API Server** — Express REST API serving current and historical metric data, alert configuration, and dashboard state.

3. **SSE Broadcaster** — Pushes real-time metric updates to all connected dashboard clients. Clients receive updates as they're collected without polling.

4. **Alert Engine** — Evaluates metrics against configurable thresholds after each collection cycle. Fires alerts, stores alert history, optionally triggers self-healing actions.

5. **Web Dashboard** — Static HTML/CSS/JS served by Express. Dark-themed, responsive. Cards for each VM, service status indicators, task progress, backup recency.

---

## Infrastructure Being Monitored

| Name | Type | Bridge IP | What It Runs |
|------|------|-----------|-------------|
| Claudinator | Host (Ubuntu) | localhost | Sentinel, TheForge, ForgeTeam orchestrator |
| CryptoTrader VM | KVM/QEMU | 10.10.10.x | Docker: CryptoTrader frontend + backend |
| ArcaneDesk VM | KVM/QEMU | 10.10.10.x | Docker: ArcaneDesk services |

> **Note:** Exact bridge IPs should be configured in `config.json`, not hardcoded. Additional VMs can be added to config at any time.

---

## Data Model (SQLite)

### `hosts` — Monitored machines
```sql
CREATE TABLE hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,        -- 'claudinator', 'cryptotrader-vm', 'arcanedesk-vm'
    type TEXT NOT NULL,                -- 'local' or 'ssh'
    ssh_host TEXT,                     -- '10.10.10.x' (null for local)
    ssh_user TEXT,                     -- SSH username (null for local)
    ssh_key_path TEXT,                 -- path to SSH private key (null for local)
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `metrics` — Time-series system metrics
```sql
CREATE TABLE metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id INTEGER NOT NULL REFERENCES hosts(id),
    collected_at TEXT NOT NULL DEFAULT (datetime('now')),
    cpu_percent REAL,
    memory_percent REAL,
    memory_used_mb INTEGER,
    memory_total_mb INTEGER,
    disk_percent REAL,
    disk_used_gb REAL,
    disk_total_gb REAL,
    load_1m REAL,
    load_5m REAL,
    load_15m REAL,
    uptime_seconds INTEGER
);
CREATE INDEX idx_metrics_host_time ON metrics(host_id, collected_at);
```

### `containers` — Docker container snapshots
```sql
CREATE TABLE containers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id INTEGER NOT NULL REFERENCES hosts(id),
    collected_at TEXT NOT NULL DEFAULT (datetime('now')),
    container_id TEXT NOT NULL,
    name TEXT NOT NULL,
    image TEXT,
    status TEXT NOT NULL,             -- 'running', 'exited', 'paused', etc.
    uptime TEXT,
    cpu_percent REAL,
    memory_mb REAL,
    auto_restart INTEGER NOT NULL DEFAULT 0  -- self-healing enabled
);
CREATE INDEX idx_containers_host_time ON containers(host_id, collected_at);
```

### `alerts` — Alert threshold configuration
```sql
CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id INTEGER,                  -- null = applies to all hosts
    metric TEXT NOT NULL,             -- 'cpu_percent', 'disk_percent', 'memory_percent', 'container_down', 'backup_stale'
    operator TEXT NOT NULL,           -- '>', '<', '=='
    threshold REAL NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',  -- 'info', 'warning', 'critical'
    enabled INTEGER NOT NULL DEFAULT 1,
    cooldown_minutes INTEGER NOT NULL DEFAULT 15
);
```

### `alert_history` — Fired alerts log
```sql
CREATE TABLE alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER NOT NULL REFERENCES alerts(id),
    host_id INTEGER NOT NULL REFERENCES hosts(id),
    fired_at TEXT NOT NULL DEFAULT (datetime('now')),
    metric_value REAL,
    message TEXT,
    resolved_at TEXT
);
CREATE INDEX idx_alert_history_fired ON alert_history(fired_at);
```

### `backups` — Backup status tracking
```sql
CREATE TABLE backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,        -- 'local-restic', 'offsite-linode'
    last_check TEXT,
    last_success TEXT,
    status TEXT,                       -- 'ok', 'stale', 'error'
    details TEXT
);
```

### Retention Policy
- **metrics**: Keep 7 days of 30-second granularity, then downsample to 5-minute averages for 30 days, then delete.
- **containers**: Keep 7 days, then delete.
- **alert_history**: Keep 90 days.

---

## API Endpoints

### System Status
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Overall system health summary (all hosts, all containers, active alerts) |
| GET | `/api/hosts` | List all monitored hosts with current status |
| GET | `/api/hosts/:id` | Single host detail with latest metrics |
| GET | `/api/hosts/:id/metrics` | Historical metrics for a host. Query params: `from`, `to`, `interval` |

### Containers
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/containers` | All containers across all hosts with current status |
| GET | `/api/containers/:hostId` | Containers for a specific host |
| POST | `/api/containers/:hostId/:name/restart` | Manually restart a container |

### Alerts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/alerts` | List all alert rules |
| POST | `/api/alerts` | Create a new alert rule |
| PUT | `/api/alerts/:id` | Update an alert rule |
| DELETE | `/api/alerts/:id` | Delete an alert rule |
| GET | `/api/alerts/history` | Fired alerts log. Query params: `from`, `to`, `severity` |
| POST | `/api/alerts/:id/acknowledge` | Acknowledge an active alert |

### TheForge Integration
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/forge/tasks` | Active tasks across all projects (reads TheForge DB directly) |
| GET | `/api/forge/tasks/:projectId` | Tasks for a specific project |
| GET | `/api/forge/activity` | Recent orchestrator activity (completed tasks, decisions, session notes) |

### Backups
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/backups` | Backup status for all configured backup jobs |

### Real-Time
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events` | SSE stream. Events: `metric`, `container`, `alert`, `forge-update` |

### Config
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Current configuration (hosts, collection interval, thresholds) |
| PUT | `/api/config` | Update configuration |

---

## Configuration (`config.json`)

```json
{
    "port": 3000,
    "collection_interval_seconds": 30,
    "theforge_db_path": "/srv/forge-share/AI_Stuff/ForgeTeam/theforge.db",
    "hosts": [
        {
            "name": "claudinator",
            "type": "local"
        },
        {
            "name": "cryptotrader-vm",
            "type": "ssh",
            "ssh_host": "10.10.10.2",
            "ssh_user": "user",
            "ssh_key_path": "/home/user/.ssh/id_ed25519"
        },
        {
            "name": "arcanedesk-vm",
            "type": "ssh",
            "ssh_host": "10.10.10.3",
            "ssh_user": "user",
            "ssh_key_path": "/home/user/.ssh/id_ed25519"
        }
    ],
    "default_alerts": [
        { "metric": "disk_percent", "operator": ">", "threshold": 90, "severity": "critical" },
        { "metric": "memory_percent", "operator": ">", "threshold": 85, "severity": "warning" },
        { "metric": "cpu_percent", "operator": ">", "threshold": 95, "severity": "warning" }
    ],
    "retention": {
        "metrics_full_days": 7,
        "metrics_downsampled_days": 30,
        "containers_days": 7,
        "alert_history_days": 90
    },
    "backups": [
        {
            "name": "local-restic",
            "type": "restic",
            "repo_path": "/path/to/restic/repo",
            "stale_hours": 24
        }
    ]
}
```

---

## Project Structure

```
/srv/forge-share/AI_Stuff/Sentinel/
├── CLAUDE.md                  # This file
├── package.json               # Node.js project config
├── config.json                # Runtime configuration
├── .gitignore
├── .env                       # Secrets (SSH passphrases, etc.) — NOT committed
├── src/
│   ├── index.js               # Entry point — starts server + collectors
│   ├── server.js              # Express app setup, routes, SSE
│   ├── db.js                  # SQLite initialization + schema migrations
│   ├── collectors/
│   │   ├── system.js          # CPU, RAM, disk, load, uptime collection
│   │   ├── docker.js          # Docker container status collection
│   │   ├── backup.js          # Backup recency checker
│   │   └── forge.js           # TheForge DB reader (tasks, decisions, activity)
│   ├── alerts/
│   │   ├── engine.js          # Threshold evaluation + alert firing
│   │   └── healing.js         # Self-healing: auto-restart containers
│   ├── routes/
│   │   ├── status.js          # /api/status, /api/hosts
│   │   ├── containers.js      # /api/containers
│   │   ├── alerts.js          # /api/alerts
│   │   ├── forge.js           # /api/forge
│   │   ├── backups.js         # /api/backups
│   │   └── config.js          # /api/config
│   └── ssh.js                 # SSH connection pool + command execution
├── public/
│   ├── index.html             # Dashboard SPA
│   ├── style.css              # Dark theme styles
│   └── app.js                 # Dashboard JS (SSE client, DOM updates)
└── tests/
    ├── collectors.test.js     # Collector unit tests
    ├── alerts.test.js         # Alert engine tests
    └── api.test.js            # API endpoint tests
```

---

## Key Design Decisions

### 1. SSH via `ssh2` npm package (not shell exec)
Pure JavaScript SSH client avoids shell injection risks and provides connection pooling. Each VM connection is reused across collection cycles.

### 2. SQLite for metrics storage (not Prometheus/InfluxDB)
At our scale (3 hosts, 30-second intervals), SQLite handles the load easily. No need for a separate time-series database. Retention policies keep the DB small.

### 3. SSE over WebSockets
Server-Sent Events are simpler, automatically reconnect, and work through proxies. We only need server-to-client push. The dashboard doesn't send data back through the stream.

### 4. Vanilla frontend (no React/Vue/Svelte)
The dashboard is a single page with cards. No complex state management needed. Vanilla JS with SSE event listeners keeps it simple and eliminates build tooling.

### 5. TheForge read-only integration
Sentinel reads TheForge's SQLite DB directly (it's on the same machine). It never writes to TheForge — it's a viewer only. This avoids any conflict with the orchestrator.

### 6. Config-driven host list
Hosts are defined in `config.json`, not hardcoded. Adding a new VM to monitor is a config change, not a code change.

### 7. Self-healing is opt-in per container
The `auto_restart` flag on each container must be explicitly enabled. Sentinel never auto-restarts anything by default.

---

## Default Alert Thresholds

| Metric | Threshold | Severity |
|--------|-----------|----------|
| Disk usage | > 90% | Critical |
| Memory usage | > 85% | Warning |
| CPU usage | > 95% (sustained 2min) | Warning |
| Container down | status != running | Critical |
| Backup stale | > 24h since last success | Warning |

---

## Collector Commands (SSH)

These are the Linux commands executed on each host during collection:

```bash
# CPU usage (percentage)
top -bn1 | grep "Cpu(s)" | awk '{print $2}'

# Memory
free -m | awk '/Mem:/ {print $2, $3}'

# Disk
df -h / | awk 'NR==2 {print $2, $3, $5}'

# Load average
cat /proc/loadavg | awk '{print $1, $2, $3}'

# Uptime (seconds)
cat /proc/uptime | awk '{print $1}'

# Docker containers
docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}'

# Docker stats (running containers only)
docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'
```

For the `local` host (Claudinator), these run directly via `child_process.exec` instead of SSH.

---

## Dashboard Layout

```
┌─────────────────────────────────────────────────────────────┐
│  SENTINEL          ● All Systems Operational    [Settings]  │
├──────────┬──────────┬──────────┬───────────────────────────┤
│ Claudin. │ CT VM    │ AD VM    │  Active Alerts            │
│ ── ── ── │ ── ── ── │ ── ── ── │  ● Disk >90% CT VM       │
│ CPU: 12% │ CPU: 45% │ CPU: 8%  │  ● Backup stale (24h+)   │
│ RAM: 62% │ RAM: 71% │ RAM: 34% │                           │
│ DSK: 45% │ DSK: 78% │ DSK: 22% │                           │
│ Load:0.5 │ Load:2.1 │ Load:0.3 │                           │
│ Up: 14d  │ Up: 7d   │ Up: 7d   │                           │
├──────────┴──────────┴──────────┴───────────────────────────┤
│  Docker Containers                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐│
│  │ ct-frontend   │ │ ct-backend   │ │ ad-main             ││
│  │ ● Running     │ │ ● Running    │ │ ● Running           ││
│  │ CPU: 2% M:128M│ │ CPU:15% M:2G │ │ CPU: 5% M: 512M    ││
│  └──────────────┘ └──────────────┘ └──────────────────────┘│
├─────────────────────────────────────────────────────────────┤
│  ForgeTeam Activity                                         │
│  Task 183: Write Sentinel spec .............. in_progress   │
│  Task 184: Project scaffolding .............. todo          │
│  Task 185: VM health collector .............. todo          │
│  Last orchestrator run: 2 hours ago                         │
├─────────────────────────────────────────────────────────────┤
│  Backups                                                    │
│  local-restic: ● OK  (last: 3h ago)                        │
│  offsite-linode: ● Stale  (last: 26h ago) ⚠                │
└─────────────────────────────────────────────────────────────┘
```

---

## Common Commands

```bash
# Install dependencies
cd /srv/forge-share/AI_Stuff/Sentinel && npm install

# Start in development mode
node /srv/forge-share/AI_Stuff/Sentinel/src/index.js

# Run tests
cd /srv/forge-share/AI_Stuff/Sentinel && npm test

# Check status via API
curl http://localhost:3000/api/status

# View SSE stream
curl -N http://localhost:3000/api/events
```

---

## Deployment

Sentinel runs as a systemd service on Claudinator:

```ini
# /etc/systemd/system/sentinel.service
[Unit]
Description=Sentinel Infrastructure Monitor
After=network.target

[Service]
Type=simple
User=user
WorkingDirectory=/srv/forge-share/AI_Stuff/Sentinel
ExecStart=/usr/bin/node /srv/forge-share/AI_Stuff/Sentinel/src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
sudo systemctl enable sentinel
sudo systemctl start sentinel

# Check status
sudo systemctl status sentinel

# View logs
journalctl -u sentinel -f
```

---

## Security Considerations

- SSH keys are stored in the user's `.ssh` directory, never in the repo
- SSH passphrases (if any) go in `.env`, which is gitignored
- The API listens only on localhost:3000 by default (no external exposure)
- Container restart actions are gated behind the `auto_restart` flag
- TheForge DB is read-only from Sentinel's perspective
- No authentication on the API (internal tool, localhost only). Add auth if ever exposed externally.

---

## Dependencies

```json
{
    "dependencies": {
        "express": "^4.21",
        "better-sqlite3": "^11",
        "ssh2": "^1.16",
        "node-cron": "^3.0"
    },
    "devDependencies": {
        "vitest": "^3"
    }
}
```

---

## Future Considerations

- **Phase 2:** Historical charts (sparklines in dashboard cards using `<canvas>`)
- **Phase 2:** Notification channels (email, Slack webhook, desktop notification)
- **Phase 3:** Multi-host dashboard comparison view
- **Phase 3:** Custom metrics collection via plugin system
- Not planned: External access / authentication (strictly internal tool)
