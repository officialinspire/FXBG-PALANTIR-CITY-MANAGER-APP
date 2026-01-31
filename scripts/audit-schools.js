#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const DATA_PATH = path.join(__dirname, "..", "data", "schools_fxbg.json");

function inferSchoolLevel(name) {
  const label = String(name || "").toLowerCase();
  if (!label) return "unknown";

  const isElementary = /elementary|\belem\b|\belem\.|primary|intermediate/.test(label);
  if (isElementary) return "elementary";

  const isMiddle = /middle|\bms\b|intermediate/.test(label);
  if (isMiddle) return "middle";

  const isHigh = /high|\bhs\b|secondary/.test(label);
  if (isHigh) return "high";

  return "unknown";
}

function pickName(record) {
  return (
    record?.name ||
    record?.schoolName ||
    record?.school_name ||
    record?.NAME ||
    record?.School_Name ||
    "Unknown School"
  );
}

function pickCounty(record) {
  return (
    record?.county ||
    record?.locality ||
    record?.district ||
    record?.jurisdiction ||
    record?.city ||
    "Unknown"
  );
}

if (!fs.existsSync(DATA_PATH)) {
  console.error(`[audit] Missing data file: ${DATA_PATH}`);
  process.exit(1);
}

let raw = "";
try {
  raw = fs.readFileSync(DATA_PATH, "utf8");
} catch (err) {
  console.error(`[audit] Failed to read ${DATA_PATH}: ${err.message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error(`[audit] Invalid JSON in ${DATA_PATH}: ${err.message}`);
  process.exit(1);
}

const schools = Array.isArray(parsed) ? parsed : (parsed?.schools || []);
const countsByCounty = new Map();
const namesByCounty = new Map();
const levelCounts = {
  elementary: 0,
  middle: 0,
  high: 0,
  unknown: 0
};

for (const record of schools) {
  const name = pickName(record);
  const county = pickCounty(record);
  const level = inferSchoolLevel(name);

  countsByCounty.set(county, (countsByCounty.get(county) || 0) + 1);
  levelCounts[level] += 1;

  if (!namesByCounty.has(county)) {
    namesByCounty.set(county, []);
  }
  namesByCounty.get(county).push(name);
}

console.log("Schools Coverage Audit");
console.log("======================");
console.log(`Total schools: ${schools.length}`);

console.log("\nCounts by county/locality:");
Array.from(countsByCounty.keys())
  .sort()
  .forEach((county) => {
    console.log(`- ${county}: ${countsByCounty.get(county)}`);
  });

console.log("\nCounts by inferred level:");
Object.entries(levelCounts).forEach(([level, count]) => {
  console.log(`- ${level}: ${count}`);
});

console.log("\nTop 20 school names per county/locality:");
Array.from(namesByCounty.keys())
  .sort()
  .forEach((county) => {
    const names = namesByCounty.get(county) || [];
    const top = names.slice().sort().slice(0, 20);
    console.log(`\n${county} (${names.length} total)`);
    top.forEach((name) => console.log(`  - ${name}`));
  });
