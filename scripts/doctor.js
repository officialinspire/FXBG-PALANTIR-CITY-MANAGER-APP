#!/usr/bin/env node
/**
 * FXBG Palantir City Manager - Doctor Script
 *
 * Checks system readiness:
 * - Node version
 * - LOG_DIR exists and is writable
 * - .env file exists (with template if missing)
 * - Required environment variables
 * - Optional environment variables (warnings only)
 *
 * Run: npm run doctor
 */

const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT_DIR, ".env");
const ENV_EXAMPLE_PATH = path.join(ROOT_DIR, ".env.example");
const PKG_PATH = path.join(ROOT_DIR, "package.json");

// Colors for terminal output
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m"
};

function ok(msg) {
  console.log(`${colors.green}[OK]${colors.reset} ${msg}`);
}

function warn(msg) {
  console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`);
}

function fail(msg) {
  console.log(`${colors.red}[FAIL]${colors.reset} ${msg}`);
}

function info(msg) {
  console.log(`${colors.cyan}[INFO]${colors.reset} ${msg}`);
}

function header(msg) {
  console.log(`\n${colors.cyan}=== ${msg} ===${colors.reset}`);
}

// Track overall status
let hasBlockingErrors = false;

// Load .env if exists (for checking)
function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) {
    return {};
  }
  const content = fs.readFileSync(ENV_PATH, "utf8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      let value = match[2];
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[match[1]] = value;
    }
  }
  return env;
}

// Check 1: Node version
function checkNodeVersion() {
  header("Node.js Version");

  const version = process.version;
  const majorMatch = version.match(/^v(\d+)/);
  const major = majorMatch ? parseInt(majorMatch[1], 10) : 0;

  // Read engines from package.json
  let allowedVersions = ">=18 <21";
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
    if (pkg.engines && pkg.engines.node) {
      allowedVersions = pkg.engines.node;
    }
  } catch (e) {}

  info(`Current Node version: ${version}`);
  info(`Required: ${allowedVersions}`);

  if (major >= 18) {
    ok(`Node ${version} is supported`);
  } else {
    fail(`Node ${version} is too old. Please upgrade to Node 18+`);
    hasBlockingErrors = true;
  }
}

// Check 2: LOG_DIR
function checkLogDir() {
  header("Log Directory");

  const envVars = loadEnvFile();
  const logDir = envVars.LOG_DIR || process.env.LOG_DIR || "logs";
  const absoluteLogDir = path.isAbsolute(logDir) ? logDir : path.join(ROOT_DIR, logDir);

  info(`LOG_DIR: ${logDir} (${absoluteLogDir})`);

  // Check if directory exists
  if (fs.existsSync(absoluteLogDir)) {
    ok(`Log directory exists`);

    // Check if writable
    try {
      const testFile = path.join(absoluteLogDir, ".doctor-test");
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
      ok(`Log directory is writable`);
    } catch (e) {
      fail(`Log directory is not writable: ${e.message}`);
      hasBlockingErrors = true;
    }
  } else {
    // Try to create it
    try {
      fs.mkdirSync(absoluteLogDir, { recursive: true });
      ok(`Created log directory: ${absoluteLogDir}`);
    } catch (e) {
      fail(`Cannot create log directory: ${e.message}`);
      hasBlockingErrors = true;
    }
  }
}

// Check 3: .env file
function checkEnvFile() {
  header(".env Configuration");

  if (fs.existsSync(ENV_PATH)) {
    ok(`.env file exists`);

    const envVars = loadEnvFile();
    const keyCount = Object.keys(envVars).length;
    info(`Found ${keyCount} environment variable(s) defined`);
  } else {
    warn(`.env file not found`);

    // Show template
    const template = `# FXBG Palantir City Manager Configuration
# Copy this file to .env and fill in your values

# Required: Directory for log files
LOG_DIR=logs

# Optional: Server port (default: 8000)
PORT=8000

# Optional: OpenUV API key for UV index data
# Get yours at: https://www.openuv.io/
OPENUV_API_KEY=

# Optional: WAQI token for air quality data
# Get yours at: https://aqicn.org/data-platform/token/
WAQI_TOKEN=
`;

    console.log(`\n${colors.dim}--- Minimal .env template ---${colors.reset}`);
    console.log(colors.dim + template + colors.reset);
    console.log(`${colors.dim}--- End template ---${colors.reset}\n`);

    info(`Create .env file with at least: LOG_DIR=logs`);

    // Check if .env.example exists
    if (fs.existsSync(ENV_EXAMPLE_PATH)) {
      info(`You can also copy .env.example: cp .env.example .env`);
    }
  }
}

// Check 4: Required environment variables
function checkRequiredEnvVars() {
  header("Required Environment Variables");

  const envVars = loadEnvFile();
  const required = ["LOG_DIR"];

  for (const key of required) {
    const value = envVars[key] || process.env[key];
    if (value) {
      ok(`${key} is set`);
    } else {
      // LOG_DIR has a default
      if (key === "LOG_DIR") {
        warn(`${key} not set, will default to "./logs"`);
      } else {
        fail(`${key} is required but not set`);
        hasBlockingErrors = true;
      }
    }
  }
}

// Check 5: Optional environment variables
function checkOptionalEnvVars() {
  header("Optional Environment Variables");

  const envVars = loadEnvFile();

  const optional = [
    { key: "OPENUV_API_KEY", desc: "OpenUV API (UV index)", url: "https://www.openuv.io/" },
    { key: "WAQI_TOKEN", desc: "WAQI API (air quality)", url: "https://aqicn.org/data-platform/token/" }
  ];

  for (const { key, desc, url } of optional) {
    const value = envVars[key] || process.env[key];
    if (value && value.length > 5 && !value.startsWith("your-")) {
      ok(`${key} is configured (${desc})`);
    } else {
      warn(`${key} not configured - ${desc} will be disabled`);
      info(`  Get an API key at: ${url}`);
    }
  }
}

// Check 6: Port availability (optional)
function checkPort() {
  header("Server Port");

  const envVars = loadEnvFile();
  const port = parseInt(envVars.PORT || process.env.PORT || "8000", 10);

  info(`Server will run on port ${port}`);

  // Quick check if something is listening (non-blocking, best effort)
  const net = require("net");
  const server = net.createServer();

  return new Promise((resolve) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        warn(`Port ${port} is currently in use. Server may fail to start.`);
      }
      resolve();
    });

    server.once("listening", () => {
      server.close();
      ok(`Port ${port} is available`);
      resolve();
    });

    server.listen(port, "127.0.0.1");

    // Timeout fallback
    setTimeout(() => {
      try { server.close(); } catch (e) {}
      resolve();
    }, 500);
  });
}

// Main
async function main() {
  console.log(`\n${colors.cyan}FXBG Palantir City Manager - Doctor${colors.reset}`);
  console.log(`${colors.dim}Checking system readiness...${colors.reset}`);

  checkNodeVersion();
  checkEnvFile();
  checkRequiredEnvVars();
  checkOptionalEnvVars();
  checkLogDir();
  await checkPort();

  // Summary
  header("Summary");

  if (hasBlockingErrors) {
    fail("Some blocking issues were found. Please fix them before starting the server.");
    process.exit(1);
  } else {
    ok("All critical checks passed! You can start the server with: npm start");
    console.log(`\n${colors.dim}Tip: Run 'npm run dev' to start on port 8000${colors.reset}\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Doctor script failed:", err);
  process.exit(1);
});
