#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT_DIR, "logs");
const PORT_MIN = 8100;
const PORT_MAX = 8999;
const HEALTH_TIMEOUT_MS = 45_000;
const KILL_TIMEOUT_MS = 3_000;
const QA_SCRIPT = path.join(__dirname, "qa-suite.js");

function ensureLogsDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function pickRandomPort(maxAttempts = 20) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1)) + PORT_MIN;
    if (await checkPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Unable to find available port in range ${PORT_MIN}-${PORT_MAX}`);
}

function checkHealth(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(false);
        return;
      }
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(Boolean(data && (data.status === "ok" || data.ok === true)));
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitForHealth(baseUrl, serverProcess) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error("Server exited before becoming healthy");
    }

    // eslint-disable-next-line no-await-in-loop
    const healthy = await checkHealth(`${baseUrl}/api/health`);
    if (healthy) {
      return;
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Timed out waiting for server health");
}

function stopServer(serverProcess) {
  return new Promise((resolve) => {
    if (!serverProcess || serverProcess.killed || serverProcess.exitCode !== null) {
      resolve();
      return;
    }

    const killTimer = setTimeout(() => {
      if (serverProcess.exitCode === null) {
        serverProcess.kill("SIGKILL");
      }
    }, KILL_TIMEOUT_MS);

    serverProcess.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });

    serverProcess.kill("SIGTERM");
  });
}

async function main() {
  let serverProcess;
  let exitCode = 1;

  try {
    ensureLogsDir();

    console.log("[qa] Running doctor checks...");
    await runCommand("node", [path.join("scripts", "doctor.js")], { cwd: ROOT_DIR });

    const port = await pickRandomPort();
    const baseUrl = `http://127.0.0.1:${port}`;

    console.log(`[qa] Starting server on ${baseUrl}...`);
    serverProcess = spawn("node", ["proxy-server.js"], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        BIND: "127.0.0.1",
        LOG_DIR: "logs"
      },
      stdio: "inherit"
    });

    await waitForHealth(baseUrl, serverProcess);
    console.log("[qa] Server healthy. Running smoke tests...");
    await runCommand("bash", [path.join("scripts", "smoke.sh"), baseUrl], { cwd: ROOT_DIR });

    console.log("[qa] Running expanded QA checks...");
    await runCommand("node", [QA_SCRIPT], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        BASE_URL: baseUrl
      }
    });

    console.log("[qa] RESULT: PASS");
    exitCode = 0;
  } catch (error) {
    console.error(`[qa] RESULT: FAIL - ${error.message}`);
    exitCode = 1;
  } finally {
    await stopServer(serverProcess);
    process.exit(exitCode);
  }
}

main();
