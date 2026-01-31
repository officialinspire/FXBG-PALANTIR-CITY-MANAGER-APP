#!/usr/bin/env node
/**
 * build-schools-nces.js
 *
 * Downloads NCES Public School Locations data for Stafford County, Spotsylvania County,
 * and Fredericksburg City, Virginia from a stable NCES ArcGIS download endpoint.
 *
 * Outputs: data/schools_fxbg.json
 *
 * Usage:
 *   npm run build:schools
 *   node scripts/build-schools-nces.js
 *   node scripts/build-schools-nces.js --force
 *   node scripts/build-schools-nces.js --input /path/to/file.csv
 *   node scripts/build-schools-nces.js --url https://example.com/file.csv
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CACHE_MAX_AGE_HOURS = 24;
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'schools_fxbg.json');
const TARGET_LOCALITIES = [
  'Stafford County',
  'Spotsylvania County',
  'Fredericksburg city'
];

const DEFAULT_NCES_URL =
  'https://data-nces.opendata.arcgis.com/api/download/v1/items/bb54cfd626b74fb695cf8534b5f97c12/csv?layers=0';

function parseArgs(argv) {
  const args = { force: false, input: null, url: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      args.force = true;
    } else if (arg === '--input') {
      args.input = argv[i + 1] || null;
      i += 1;
    } else if (arg === '--url') {
      args.url = argv[i + 1] || null;
      i += 1;
    }
  }
  return args;
}

function shouldSkipRebuild(forceFlag) {
  if (forceFlag) {
    return false;
  }

  if (!fs.existsSync(OUTPUT_PATH)) {
    return false;
  }

  try {
    const stats = fs.statSync(OUTPUT_PATH);
    const ageMs = Date.now() - stats.mtimeMs;
    const ageHours = ageMs / (1000 * 60 * 60);

    if (ageHours < CACHE_MAX_AGE_HOURS) {
      console.log('[schools] up-to-date; skipping rebuild');
      return true;
    }
    return false;
  } catch (err) {
    return false;
  }
}

function fetchCsv(url) {
  return new Promise((resolve, reject) => {
    console.log(`[schools] Downloading CSV: ${url}`);

    const req = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchCsv(res.headers.location).then(resolve).catch(reject);
      }

      const statusCode = res.statusCode || 0;
      const contentType = res.headers['content-type'] || 'unknown';
      console.log(`[schools] HTTP ${statusCode} content-type: ${contentType}`);

      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        const size = Buffer.byteLength(data, 'utf8');
        const preview = data.slice(0, 200).trim();
        const isHtml = /text\/html|application\/html/i.test(contentType) || /^</.test(preview);

        if (statusCode !== 200) {
          console.error(`[schools] Download failed: HTTP ${statusCode}`);
          if (preview) {
            console.error(`[schools] Response preview: ${preview}`);
          }
          return reject(new Error(`Download failed with status ${statusCode}`));
        }

        if (isHtml || size < 1000) {
          console.error('[schools] Download returned unexpected content');
          console.error(`[schools] size=${size} bytes`);
          if (preview) {
            console.error(`[schools] Response preview: ${preview}`);
          }
          return reject(new Error('Download content invalid'));
        }

        return resolve(data);
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

function parseCsv(content) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i += 1;
      }
      row.push(current);
      current = '';
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    current += char;
  }

  row.push(current);
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }

  return rows;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

function findColumnIndex(headers, candidates) {
  const normalized = headers.map((header) => normalizeHeader(header));
  for (const candidate of candidates) {
    const target = normalizeHeader(candidate);
    const index = normalized.indexOf(target);
    if (index !== -1) {
      return index;
    }
  }
  return -1;
}

function getRowValue(row, index) {
  if (index < 0) {
    return '';
  }
  return String(row[index] ?? '').trim();
}

function normalizeCounty(value) {
  return String(value || '').trim().toLowerCase();
}

function isVirginia(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return false;
  }
  const upper = raw.toUpperCase();
  if (upper === 'VA' || upper === 'VIRGINIA') {
    return true;
  }
  if (/^0*51$/.test(raw)) {
    return true;
  }
  return false;
}

function buildSchoolId(ncesId, name, lat, lon) {
  if (ncesId) {
    return ncesId;
  }
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return `${safeName}-${lat.toFixed(4)}-${lon.toFixed(4)}`;
}

function parseGradeRange(low, high) {
  if (!low && !high) {
    return null;
  }
  if (low && high && low === high) {
    return low;
  }
  if (low && high) {
    return `${low}-${high}`;
  }
  return low || high || null;
}

function ensureOutputDir() {
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
}

function validateCoordinates(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return false;
  }
  if (lat < 36 || lat > 40) {
    return false;
  }
  if (lon < -83 || lon > -75) {
    return false;
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  const inputPath = args.input || process.env.NCES_SCHOOLS_CSV_PATH || null;
  const url = args.url || process.env.NCES_SCHOOLS_URL || DEFAULT_NCES_URL;

  if (shouldSkipRebuild(args.force)) {
    process.exit(0);
  }

  let csvContent = '';
  if (inputPath) {
    const resolvedPath = path.resolve(inputPath);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`[schools] Input CSV not found: ${resolvedPath}`);
      process.exit(1);
    }
    console.log(`[schools] Using local CSV: ${resolvedPath}`);
    csvContent = fs.readFileSync(resolvedPath, 'utf8');
  } else {
    try {
      csvContent = await fetchCsv(url);
    } catch (err) {
      console.error(`[schools] Download failed: ${err.message}`);
      process.exit(1);
    }
  }

  const rows = parseCsv(csvContent);
  if (rows.length < 2) {
    console.error('[schools] CSV appears empty or malformed');
    process.exit(1);
  }

  const headers = rows[0];
  const dataRows = rows.slice(1);

  const latIndex = findColumnIndex(headers, ['LAT', 'Latitude', 'LATITUDE']);
  const lonIndex = findColumnIndex(headers, ['LON', 'Longitude', 'LONGITUDE', 'LONG']);
  const nameIndex = findColumnIndex(headers, ['NAME', 'Name of institution', 'SCHOOL_NAME']);
  const countyIndex = findColumnIndex(headers, ['County name', 'COUNTY_NAME', 'COUNTY']);
  const stateIndex = findColumnIndex(headers, ['STATE', 'ST', 'STATE_ABBR', 'State']);
  const idIndex = findColumnIndex(headers, ['NCESSCH', 'NCES_SCHOOL_ID', 'NCES School ID', 'NCESID']);
  const addressIndex = findColumnIndex(headers, ['ADDRESS', 'Street', 'STREET', 'LOCATION_ADDRESS']);
  const gradesLowIndex = findColumnIndex(headers, ['GSLO', 'GRADE_LOW', 'LOW_GRADE']);
  const gradesHighIndex = findColumnIndex(headers, ['GSHI', 'GRADE_HIGH', 'HIGH_GRADE']);

  const targetLocalities = new Set(TARGET_LOCALITIES.map((name) => normalizeCounty(name)));

  let totalRows = 0;
  let keptRows = 0;
  let skippedMissingCoords = 0;
  let skippedValidation = 0;

  const schools = [];

  for (const row of dataRows) {
    if (!row || row.length === 0) {
      continue;
    }
    totalRows += 1;

    const countyValue = getRowValue(row, countyIndex);
    const countyNormalized = normalizeCounty(countyValue);
    if (countyNormalized && !targetLocalities.has(countyNormalized)) {
      continue;
    }

    if (stateIndex >= 0) {
      const stateValue = getRowValue(row, stateIndex);
      if (!isVirginia(stateValue)) {
        continue;
      }
    }

    const latValue = getRowValue(row, latIndex);
    const lonValue = getRowValue(row, lonIndex);
    const lat = Number(latValue);
    const lon = Number(lonValue);

    if (!latValue || !lonValue) {
      skippedMissingCoords += 1;
      continue;
    }

    if (!validateCoordinates(lat, lon)) {
      skippedValidation += 1;
      continue;
    }

    const name = getRowValue(row, nameIndex) || 'Unknown School';
    const id = buildSchoolId(getRowValue(row, idIndex), name, lat, lon);

    const school = {
      id,
      name,
      county: countyValue || null,
      state: 'VA',
      lat,
      lon,
      address: getRowValue(row, addressIndex) || null,
      grades: parseGradeRange(getRowValue(row, gradesLowIndex), getRowValue(row, gradesHighIndex))
    };

    schools.push(school);
    keptRows += 1;
  }

  if (schools.length < 10) {
    console.error(`[schools] Suspiciously small dataset (${schools.length} schools). Aborting.`);
    process.exit(1);
  }

  ensureOutputDir();

  const output = JSON.stringify(schools, null, 2);
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error('[schools] Output validation failed: not a non-empty JSON array');
    process.exit(1);
  }

  fs.writeFileSync(OUTPUT_PATH, output, 'utf8');

  const stats = fs.statSync(OUTPUT_PATH);
  console.log('[schools] Build summary:');
  console.log(`  total rows read: ${totalRows}`);
  console.log(`  kept rows: ${keptRows}`);
  console.log(`  skipped missing coords: ${skippedMissingCoords}`);
  console.log(`  skipped validation: ${skippedValidation}`);
  console.log(`  output: ${OUTPUT_PATH}`);
  console.log(`  size: ${stats.size} bytes`);
}

main().catch((err) => {
  console.error(`[schools] Build failed: ${err.message}`);
  process.exit(1);
});
