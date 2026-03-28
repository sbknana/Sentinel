// Copyright 2026, Forgeborn
const express = require('express');
const Database = require('better-sqlite3');
const config = require('../config');

const router = express.Router();

/**
 * Open the TheForge DB in read-only mode.
 * Returns null if the path is not configured or the file is inaccessible.
 */
function getForgeDb() {
  if (!config.theforgeDbPath) return null;
  try {
    return new Database(config.theforgeDbPath, { readonly: true });
  } catch {
    return null;
  }
}

// GET /api/forge/tasks - active tasks across all projects
router.get('/tasks', (req, res) => {
  const db = getForgeDb();
  if (!db) {
    return res.status(503).json({ error: 'TheForge DB not available' });
  }
  try {
    const tasks = db.prepare(`
      SELECT t.id, t.title, t.description, t.status, t.priority, t.blocked_by,
             t.due_date, t.completed_at, t.created_at, t.complexity,
             t.project_id, p.name AS project_name, p.codename AS project_codename
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.status IN ('todo', 'in_progress', 'blocked')
      ORDER BY
        CASE t.status
          WHEN 'in_progress' THEN 0
          WHEN 'blocked' THEN 1
          WHEN 'todo' THEN 2
        END,
        CASE t.priority
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END,
        t.created_at DESC
    `).all();

    // Summary counts
    const counts = db.prepare(`
      SELECT status, COUNT(*) AS count FROM tasks
      GROUP BY status
    `).all();
    const summary = {};
    for (const row of counts) {
      summary[row.status] = row.count;
    }

    res.json({ summary, tasks });
  } finally {
    db.close();
  }
});

// GET /api/forge/tasks/:projectId - tasks for a specific project
router.get('/tasks/:projectId', (req, res) => {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) {
    return res.status(400).json({ error: 'Invalid project ID' });
  }
  const db = getForgeDb();
  if (!db) {
    return res.status(503).json({ error: 'TheForge DB not available' });
  }
  try {
    const project = db.prepare(
      'SELECT id, name, codename, status, summary FROM projects WHERE id = ?'
    ).get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const tasks = db.prepare(`
      SELECT id, title, description, status, priority, blocked_by,
             due_date, completed_at, created_at, complexity
      FROM tasks
      WHERE project_id = ?
      ORDER BY
        CASE status
          WHEN 'in_progress' THEN 0
          WHEN 'blocked' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'done' THEN 3
        END,
        CASE priority
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END,
        created_at DESC
    `).all(projectId);

    const counts = db.prepare(`
      SELECT status, COUNT(*) AS count FROM tasks
      WHERE project_id = ?
      GROUP BY status
    `).all(projectId);
    const summary = {};
    for (const row of counts) {
      summary[row.status] = row.count;
    }

    res.json({ project, summary, tasks });
  } finally {
    db.close();
  }
});

// GET /api/forge/activity - recent orchestrator activity
router.get('/activity', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const db = getForgeDb();
  if (!db) {
    return res.status(503).json({ error: 'TheForge DB not available' });
  }
  try {
    // Recently completed tasks
    const recentCompletions = db.prepare(`
      SELECT t.id, t.title, t.status, t.priority, t.completed_at, t.complexity,
             t.project_id, p.name AS project_name, p.codename AS project_codename
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'done' AND t.completed_at IS NOT NULL
      ORDER BY t.completed_at DESC
      LIMIT ?
    `).all(limit);

    // Recent decisions
    const recentDecisions = db.prepare(`
      SELECT d.id, d.topic, d.decision, d.rationale, d.decided_at,
             d.project_id, p.name AS project_name, p.codename AS project_codename
      FROM decisions d
      JOIN projects p ON p.id = d.project_id
      ORDER BY d.decided_at DESC
      LIMIT ?
    `).all(limit);

    // Recent session notes
    const recentSessions = db.prepare(`
      SELECT s.id, s.summary, s.key_points, s.next_steps, s.session_date, s.created_at,
             s.project_id, p.name AS project_name, p.codename AS project_codename
      FROM session_notes s
      LEFT JOIN projects p ON p.id = s.project_id
      ORDER BY s.created_at DESC
      LIMIT ?
    `).all(limit);

    // Unresolved open questions
    const openQuestions = db.prepare(`
      SELECT q.id, q.question, q.context, q.priority, q.asked_at,
             q.project_id, p.name AS project_name, p.codename AS project_codename
      FROM open_questions q
      JOIN projects p ON p.id = q.project_id
      WHERE q.resolved = 0
      ORDER BY
        CASE q.priority
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END,
        q.asked_at DESC
      LIMIT ?
    `).all(limit);

    // Stale items: in_progress tasks older than 24 hours with no recent completion
    const staleItems = db.prepare(`
      SELECT t.id, t.title, t.status, t.priority, t.created_at, t.complexity,
             t.project_id, p.name AS project_name, p.codename AS project_codename
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.status = 'in_progress'
        AND t.created_at < datetime('now', '-1 day')
      ORDER BY t.created_at ASC
    `).all();

    // Project overview: projects with active work
    const activeProjects = db.prepare(`
      SELECT p.id, p.name, p.codename, p.status,
        SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo_count,
        SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
        SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done_count
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      GROUP BY p.id
      HAVING todo_count > 0 OR in_progress_count > 0 OR blocked_count > 0
      ORDER BY in_progress_count DESC, todo_count DESC
    `).all();

    res.json({
      recent_completions: recentCompletions,
      recent_decisions: recentDecisions,
      recent_sessions: recentSessions,
      open_questions: openQuestions,
      stale_items: staleItems,
      active_projects: activeProjects,
    });
  } finally {
    db.close();
  }
});

// GET /api/forge/projects/:id/detail - full project context
router.get('/projects/:id/detail', (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  if (isNaN(projectId)) {
    return res.status(400).json({ error: 'Invalid project ID' });
  }
  const db = getForgeDb();
  if (!db) {
    return res.status(503).json({ error: 'TheForge DB not available' });
  }
  try {
    const project = db.prepare(
      'SELECT id, name, codename, category, status, summary, show_on_website FROM projects WHERE id = ?'
    ).get(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const tasks = db.prepare(`
      SELECT id, title, description, status, priority, complexity, created_at, completed_at
      FROM tasks WHERE project_id = ?
      ORDER BY
        CASE status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 WHEN 'done' THEN 3 END,
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        created_at DESC
    `).all(projectId);

    const taskCounts = db.prepare(`
      SELECT status, COUNT(*) AS count FROM tasks WHERE project_id = ? GROUP BY status
    `).all(projectId);
    const counts = {};
    for (const row of taskCounts) counts[row.status] = row.count;

    const decisions = db.prepare(`
      SELECT id, topic, decision, rationale, alternatives_considered, decided_at
      FROM decisions WHERE project_id = ?
      ORDER BY decided_at DESC LIMIT 20
    `).all(projectId);

    const sessions = db.prepare(`
      SELECT id, summary, key_points, next_steps, session_date, created_at
      FROM session_notes WHERE project_id = ?
      ORDER BY created_at DESC LIMIT 10
    `).all(projectId);

    const questions = db.prepare(`
      SELECT id, question, context, priority, asked_at, resolved
      FROM open_questions WHERE project_id = ?
      ORDER BY resolved ASC,
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
        asked_at DESC
      LIMIT 20
    `).all(projectId);

    res.json({ project, counts, tasks, decisions, sessions, questions });
  } finally {
    db.close();
  }
});

// GET /api/forge/projects - all projects with task counts
router.get('/projects', (req, res) => {
  const db = getForgeDb();
  if (!db) {
    return res.status(503).json({ error: 'TheForge DB not available' });
  }
  try {
    const projects = db.prepare(`
      SELECT p.id, p.name, p.codename, p.category, p.status, p.summary, p.show_on_website,
        SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo_count,
        SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
        SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done_count
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      GROUP BY p.id
      ORDER BY
        CASE p.status
          WHEN 'active' THEN 0
          WHEN 'planning' THEN 1
          WHEN 'concept' THEN 2
          ELSE 3
        END,
        p.name
    `).all();
    res.json(projects);
  } finally {
    db.close();
  }
});


// GET /api/forge/agents - running ForgeTeam agent status
router.get('/agents', async (req, res) => {
  try {
    const { execSync } = require('child_process');

    // Check for running claude processes
    let agents = [];
    try {
      const psOutput = execSync('ps aux | grep "claude" | grep -v grep', {
        timeout: 5000,
        encoding: 'utf-8',
      });
      const lines = psOutput.trim().split('\n').filter(Boolean);
      agents = lines.map((line) => {
        const parts = line.split(/\s+/);
        return {
          pid: parts[1],
          cpu: parts[2],
          mem: parts[3],
          started: parts[8],
          command: parts.slice(10).join(' '),
        };
      });
    } catch {
      // No claude processes running — that's fine
    }

    // Check for orchestrator process
    let orchestratorRunning = false;
    try {
      const orchOutput = execSync('ps aux | grep forge_orchestrator | grep -v grep', {
        timeout: 5000,
        encoding: 'utf-8',
      });
      orchestratorRunning = orchOutput.trim().length > 0;
    } catch {
      // Not running
    }

    // Read latest orchestrator logs (scan /tmp/ for all forge-orchestrator*.log files)
    let logLines = [];
    const fs = require('fs');
    try {
      const tmpFiles = fs.readdirSync('/tmp/');
      const logPaths = tmpFiles
        .filter((f) => f.startsWith('forge-') && f.endsWith('.log'))
        .map((f) => `/tmp/${f}`);
      for (const logPath of logPaths) {
        try {
          const logContent = fs.readFileSync(logPath, 'utf-8');
          const lines = logContent.trim().split('\n').filter(Boolean).slice(-20);
          logLines.push(...lines.map((l) => ({ source: logPath, line: l })));
        } catch {
          // Skip unreadable logs
        }
      }
    } catch {
      // /tmp not readable
    }

    // Also check .forge-checkpoints for recent agent activity
    let checkpoints = [];
    const checkpointDir = '/srv/forge-share/AI_Stuff/ForgeTeam/.forge-checkpoints';
    try {
      if (fs.existsSync(checkpointDir)) {
        const files = fs.readdirSync(checkpointDir);
        checkpoints = files.map((f) => {
          const stat = fs.statSync(`${checkpointDir}/${f}`);
          return { file: f, modified: stat.mtime.toISOString(), size: stat.size };
        }).sort((a, b) => new Date(b.modified) - new Date(a.modified)).slice(0, 10);
      }
    } catch {
      // Skip
    }

    res.json({
      running_agents: agents.length,
      agents,
      orchestrator_running: orchestratorRunning,
      recent_logs: logLines,
      checkpoints,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
