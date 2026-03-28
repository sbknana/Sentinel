# Sentinel

Real-time infrastructure monitoring for your entire server fleet — see everything that's happening across all your VMs, Docker containers, and background tasks in one place.

![Sentinel Dashboard](https://raw.githubusercontent.com/sbknana/Sentinel/master/docs/screenshots/dashboard-overview.png)

## What is this?

Sentinel is a monitoring dashboard that watches over your infrastructure 24/7. Instead of SSHing into each server to check if things are running, you get a single web interface showing the health of all your hosts, containers, services, and automated tasks. It's designed for small teams running multiple VMs who need instant visibility without the complexity of enterprise monitoring tools.

## Features

- **Real-time monitoring** — see updates as they happen, no page refresh needed
- **Multi-host management** — track dozens of VMs from a single dashboard
- **Container visibility** — know which Docker containers are running where
- **Task orchestration** — watch automated deployments and maintenance tasks
- **Smart alerting** — get notified when something actually needs your attention
- **Activity timeline** — complete audit log of infrastructure changes
- **SSH-based collection** — no agents to install on your servers
- **Backup tracking** — verify your backup jobs are running on schedule
- **One-click restarts** — quickly recover containers without SSHing

## Quick Start

```bash
# Clone the repository
git clone https://github.com/sbknana/Sentinel.git
cd Sentinel

# Install dependencies
npm install

# Set up your configuration
cp config.example.json config.json
# Edit config.json with your host details

# Start the server
npm start

# Open your browser
# http://localhost:3000
```

## Documentation

- [Full Documentation](docs/README.md) — comprehensive setup and usage guide
- [Architecture](docs/ARCHITECTURE.md) — system design and components
- [Deployment Guide](docs/DEPLOYMENT.md) — production deployment instructions
- [API Reference](docs/API.md) — REST API endpoints and SSE streams

## Tech Stack

- **Backend**: Express.js + Node.js
- **Database**: SQLite (better-sqlite3)
- **SSH**: ssh2 for remote metric collection
- **Scheduling**: node-cron for periodic checks
- **Frontend**: Vanilla JavaScript (no framework dependencies)

## License

Copyright © 2026, Forgeborn. All rights reserved.
