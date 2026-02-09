// Copyright 2026, TheForge, LLC
const { Client } = require('ssh2');
const fs = require('fs');
const { execFile } = require('child_process');

/**
 * Execute a command on a host. Uses SSH for remote hosts, child_process for local.
 * Returns stdout as a string. Throws on connection or command failure.
 */
function execOnHost(host, command, timeoutMs = 10000) {
  if (host.type === 'local') {
    return execLocal(command, timeoutMs);
  }
  return execSsh(host, command, timeoutMs);
}

function execLocal(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', ['-c', command], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Local exec failed: ${err.message}`));
      resolve(stdout);
    });
  });
}

function execSsh(host, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.end();
        reject(new Error(`SSH timeout after ${timeoutMs}ms to ${host.name}`));
      }
    }, timeoutMs);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          settled = true;
          conn.end();
          return reject(new Error(`SSH exec failed on ${host.name}: ${err.message}`));
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => { stdout += data.toString(); });
        stream.stderr.on('data', (data) => { stderr += data.toString(); });

        stream.on('close', () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            conn.end();
            resolve(stdout);
          }
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`SSH connection to ${host.name} (${host.ssh_host}): ${err.message}`));
      }
    });

    const connectConfig = {
      host: host.ssh_host,
      port: host.ssh_port || 22,
      username: host.ssh_user,
      readyTimeout: timeoutMs,
    };

    if (host.ssh_key_path) {
      try {
        connectConfig.privateKey = fs.readFileSync(host.ssh_key_path);
      } catch (e) {
        clearTimeout(timer);
        settled = true;
        return reject(new Error(`Cannot read SSH key ${host.ssh_key_path}: ${e.message}`));
      }
    }

    conn.connect(connectConfig);
  });
}

module.exports = { execOnHost };
