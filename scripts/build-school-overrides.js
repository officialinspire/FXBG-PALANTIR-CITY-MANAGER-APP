#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const src = path.join(repoRoot, 'school-list.txt');
const out = path.join(repoRoot, 'data', 'schools_address_overrides.json');

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function parseLine(line) {
  const parts = line.split(/\s+—\s+/);
  if (parts.length < 2) return null;
  const name = normalizeName(parts[0]);
  const address = normalizeName(parts.slice(1).join(' — '));
  if (!name || !address) return null;
  return { name, address };
}

function build() {
  const raw = fs.readFileSync(src, 'utf8');
  const items = [];
  const seen = new Set();

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^=+/.test(line) || /^[A-Z\s()\-+\/.]+$/.test(line)) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    const key = parsed.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ ...parsed, aliases: [] });
  }

  const payload = { version: 1, items };
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${items.length} school overrides -> ${path.relative(repoRoot, out)}`);
}

build();
