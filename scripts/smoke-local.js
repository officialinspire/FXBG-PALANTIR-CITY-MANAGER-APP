#!/usr/bin/env node

const net = require('net');
const { spawn } = require('child_process');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close((err) => {
        if (err) return reject(err);
        if (!port) return reject(new Error('Failed to determine free port'));
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}

function waitForHealth(baseUrl, timeoutMs = 20000) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      fetch(`${baseUrl}/health`)
        .then((res) => {
          if (res.ok) {
            resolve();
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`Timed out waiting for ${baseUrl}/health (status ${res.status})`));
            return;
          }
          setTimeout(attempt, 300);
        })
        .catch((err) => {
          if (Date.now() - started > timeoutMs) {
            reject(new Error(`Timed out waiting for ${baseUrl}/health (${err.message})`));
            return;
          }
          setTimeout(attempt, 300);
        });
    };

    attempt();
  });
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`[smoke:local] Starting proxy-server.js on ${baseUrl}`);

  const server = spawn(process.execPath, ['proxy-server.js'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

  const cleanup = () => {
    if (!server.killed) {
      server.kill('SIGTERM');
    }
  };

  let exitCode = 1;
  try {
    await waitForHealth(baseUrl);
    console.log('[smoke:local] Health endpoint is ready. Running smoke test...');

    exitCode = await new Promise((resolve, reject) => {
      const smoke = spawn('bash', ['scripts/smoke.sh', baseUrl], {
        stdio: 'inherit',
        env: process.env
      });

      smoke.on('error', reject);
      smoke.on('exit', (code) => resolve(code ?? 1));
    });

    if (exitCode === 0) {
      console.log('[smoke:local] RESULT: PASS');
    } else {
      console.error(`[smoke:local] RESULT: FAIL (exit ${exitCode})`);
    }
  } finally {
    cleanup();
    await new Promise((resolve) => server.once('exit', () => resolve()));
    console.log('[smoke:local] Server stopped.');
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`[smoke:local] ERROR: ${err.message}`);
  process.exit(1);
});
