#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const schoolsPath = path.join(root, 'data', 'schools_fxbg.json');
const overridesPath = path.join(root, 'data', 'schools_address_overrides.json');
const placesPath = path.join(root, 'data', 'places.json');
const geocachePath = path.join(root, 'data', 'geocode-cache.json');
const outPath = path.join(root, 'logs', 'precision-audit.csv');

function norm(v) { return String(v || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function distMeters(a, b, c, d) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(c - a);
  const dLon = toRad(d - b);
  const A = Math.sin(dLat/2)**2 + Math.cos(toRad(a))*Math.cos(toRad(c))*Math.sin(dLon/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(A), Math.sqrt(1 - A));
}

const schools = JSON.parse(fs.readFileSync(schoolsPath, 'utf8'));
const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
const places = JSON.parse(fs.readFileSync(placesPath, 'utf8'));
const geocache = fs.existsSync(geocachePath) ? JSON.parse(fs.readFileSync(geocachePath,'utf8')) : {items:{}};

const overrideMap = new Map();
for (const item of overrides.items || []) {
  overrideMap.set(norm(item.name), item);
  for (const a of (item.aliases || [])) overrideMap.set(norm(a), item);
}
const placeMap = new Map();
for (const item of places.items || []) {
  for (const k of [item.id, item.name, ...(item.aliases || [])]) {
    if (k) placeMap.set(norm(k), item);
  }
}

const rows = ['name,address,nces_lat,nces_lon,resolved_lat,resolved_lon,distance_m,method,confidence,override_used'];
for (const school of schools) {
  const ov = overrideMap.get(norm(school.name));
  const address = (ov && ov.address) || school.address || '';
  const ncesLat = Number(school.lat);
  const ncesLon = Number(school.lon);
  let method = 'fallback';
  let conf = 10;
  let resolvedLat = '';
  let resolvedLon = '';
  const placeHit = placeMap.get(norm(school.name));
  if (placeHit && Number.isFinite(Number(placeHit.lat)) && Number.isFinite(Number(placeHit.lng))) {
    resolvedLat = Number(placeHit.lat);
    resolvedLon = Number(placeHit.lng);
    method = 'precision_pack';
    conf = 98;
  } else {
    const key = norm(address);
    const cached = (geocache.items || {})[key];
    if (cached && Number.isFinite(Number(cached.lat)) && Number.isFinite(Number(cached.lon))) {
      resolvedLat = Number(cached.lat);
      resolvedLon = Number(cached.lon);
      method = 'address_geocache';
      conf = 80;
    }
  }
  const distance = (Number.isFinite(ncesLat) && Number.isFinite(ncesLon) && Number.isFinite(resolvedLat) && Number.isFinite(resolvedLon))
    ? Math.round(distMeters(ncesLat, ncesLon, resolvedLat, resolvedLon))
    : '';
  rows.push([
    `"${String(school.name || '').replace(/"/g,'""')}"`,
    `"${String(address || '').replace(/"/g,'""')}"`,
    Number.isFinite(ncesLat) ? ncesLat : '',
    Number.isFinite(ncesLon) ? ncesLon : '',
    resolvedLat,
    resolvedLon,
    distance,
    method,
    conf,
    ov ? 'yes' : 'no'
  ].join(','));
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, rows.join('\n') + '\n', 'utf8');
console.log(`Wrote ${rows.length - 1} rows -> ${path.relative(root, outPath)}`);
