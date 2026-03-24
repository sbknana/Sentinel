# Docker Auto-Remove Destroyed Containers — Task #1624

## Problem

Sentinel monitors Docker containers by polling `docker ps -a` on each host. When temporary/ephemeral containers (from EQUIPA worktree test runs, CI tasks, etc.) were destroyed (`docker rm`), they disappeared from `docker ps -a` but Sentinel's database still had their last snapshot. On the next poll cycle, `checkContainerAlerts()` would fire `container_down` alerts for containers that no longer exist, creating noise.

## Solution

### Core Logic (`src/collectors/docker.js`)

Added `handleDestroyedContainers()` which runs after each Docker poll:

1. **Compares** the current `docker ps -a` output against the previous snapshot in the DB
2. **Detects** containers that were in the previous poll but are no longer present (destroyed)
3. **For non-persistent (ephemeral) containers:**
   - Inserts a final snapshot with `status = 'destroyed'` for timeline continuity
   - Resolves any open alerts for that container automatically
   - Logs the auto-removal to `healing_log` with `action = 'auto_remove'`
   - Broadcasts a `container_removed` SSE event
   - Console log: `Container "{name}" destroyed — removed from monitoring`
4. **For persistent containers** (production services):
   - Fires a CRITICAL alert: `Persistent container "{name}" was DESTROYED`
   - Respects cooldown to avoid duplicate alerts

### `checkContainerAlerts()` Updated

Now filters out `status === 'destroyed'` containers — they are handled by the new destroyed-container logic, not the generic "down" alert path.

### Healing Module (`src/alerts/healing.js`)

Skips containers with `status === 'destroyed'` — no point attempting to restart a container that was removed.

### Database Schema (`src/db/index.js`)

- Added `persistent INTEGER NOT NULL DEFAULT 0` column to `containers` table
- Includes migration for existing databases (ALTER TABLE if column missing)

### API Routes (`src/routes/containers.js`)

- **`GET /api/containers`** — Now excludes `status = 'destroyed'` containers by default. Pass `?include_destroyed=1` to include them.
- **`PUT /api/containers/:hostId/:name/persistent`** — Toggle the `persistent` flag for a container. Body: `{ "enabled": true/false }`. Persistent containers alert when destroyed; non-persistent ones are silently removed.

## How Detection Works

| Scenario | Previous Poll | Current `docker ps -a` | Result |
|---|---|---|---|
| Container running | `running` | Present, `running` | Normal — no action |
| Container stopped | `running` | Present, `exited` | Alert: "container is exited" |
| Container destroyed (ephemeral) | `running` or `exited` | **Not present** | Auto-removed, alert resolved |
| Container destroyed (persistent) | `running` or `exited` | **Not present** | CRITICAL alert fired |

## Files Changed

- `src/collectors/docker.js` — Core auto-removal logic
- `src/db/index.js` — Schema: `persistent` column + migration
- `src/routes/containers.js` — API: persistent toggle + filter destroyed
- `src/alerts/healing.js` — Skip destroyed containers

## Usage: Mark a Container as Persistent

```bash
# Mark a production container as persistent (alerts if destroyed)
curl -X PUT http://localhost:3002/api/containers/1/my-production-app/persistent \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true}'

# Mark an ephemeral container as non-persistent (default — silently removed when destroyed)
curl -X PUT http://localhost:3002/api/containers/1/test-runner-xyz/persistent \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'
```

All containers default to non-persistent (`persistent = 0`), meaning they are silently removed when destroyed. Only containers explicitly marked as persistent will generate alerts when they disappear from `docker ps -a`.
