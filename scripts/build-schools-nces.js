#!/usr/bin/env node
/**
 * build-schools-nces.js
 *
 * Downloads NCES Public School Locations data for Stafford County, Spotsylvania County,
 * and Fredericksburg City, Virginia from the NCES EDGE ArcGIS FeatureServer.
 *
 * Outputs: data/schools_fxbg.json
 *
 * Usage: npm run build:schools
 *        node scripts/build-schools-nces.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// NCES EDGE ArcGIS FeatureServer for Public School Locations (2023-24 data)
// See: https://nces.ed.gov/programs/edge/geographic/schoollocations
const NCES_BASE_URL = 'https://services1.arcgis.com/Ua5sjt3LWTPigjyD/arcgis/rest/services/Public_School_Location_2324/FeatureServer/0/query';

// Virginia localities we want (FXBG metro area)
// Note: "Fredericksburg city" is an independent city in Virginia, not a county
const TARGET_LOCALITIES = [
  'Stafford County',
  'Spotsylvania County',
  'Fredericksburg city'
];

// Output path
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'schools_fxbg.json');

/**
 * Fetch JSON from a URL using HTTPS
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    console.log(`[NCES] Fetching: ${url.slice(0, 100)}...`);

    const req = https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Handle redirect
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        return;
      }

      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Build query URL for NCES FeatureServer
 */
function buildQueryUrl(localities) {
  // Build WHERE clause for each locality
  // NMCNTY (County Name) field contains the county/city name
  // STATE field contains state abbreviation
  const whereConditions = localities.map(loc => `NMCNTY='${loc}'`).join(' OR ');
  const where = `STATE='VA' AND (${whereConditions})`;

  const params = new URLSearchParams({
    where: where,
    outFields: 'NCESSCH,NAME,LAT,LON,STREET,CITY,STATE,ZIP,NMCNTY,GSLO,GSHI,LEVEL,STATUS,PHONE',
    returnGeometry: 'false',
    f: 'json',
    resultRecordCount: '2000'
  });

  return `${NCES_BASE_URL}?${params.toString()}`;
}

/**
 * Try fetching with different dataset years (fallback if current year fails)
 */
async function fetchWithFallback(localities) {
  // Try multiple dataset versions (newest to oldest)
  const datasetYears = [
    'Public_School_Location_2324',  // 2023-24 (newest)
    'Public_School_Location_2223',  // 2022-23
    'Public_School_Location_202122', // 2021-22
    'Public_School_Location_202021'  // 2020-21
  ];

  for (const dataset of datasetYears) {
    try {
      const baseUrl = `https://services1.arcgis.com/Ua5sjt3LWTPigjyD/arcgis/rest/services/${dataset}/FeatureServer/0/query`;

      const whereConditions = localities.map(loc => `NMCNTY='${loc}'`).join(' OR ');
      const where = `STATE='VA' AND (${whereConditions})`;

      const params = new URLSearchParams({
        where: where,
        outFields: 'NCESSCH,NAME,LAT,LON,STREET,CITY,STATE,ZIP,NMCNTY,GSLO,GSHI,LEVEL,STATUS,PHONE',
        returnGeometry: 'false',
        f: 'json',
        resultRecordCount: '2000'
      });

      const url = `${baseUrl}?${params.toString()}`;
      console.log(`[NCES] Trying dataset: ${dataset}`);

      const data = await fetchJson(url);

      if (data.features && data.features.length > 0) {
        console.log(`[NCES] Success with ${dataset}: ${data.features.length} schools found`);
        return data;
      }

      console.log(`[NCES] No data from ${dataset}, trying next...`);
    } catch (err) {
      console.log(`[NCES] Failed ${dataset}: ${err.message}, trying next...`);
    }
  }

  throw new Error('All NCES dataset sources failed');
}

/**
 * Parse grade range from GSLO/GSHI fields
 */
function parseGradeRange(gslo, gshi) {
  if (!gslo && !gshi) return null;

  const formatGrade = (g) => {
    if (g === 'PK') return 'Pre-K';
    if (g === 'KG') return 'K';
    if (g === 'UG') return 'Ungraded';
    return g;
  };

  if (gslo === gshi) return formatGrade(gslo);
  return `${formatGrade(gslo)}-${formatGrade(gshi)}`;
}

/**
 * Format address from parts
 */
function formatAddress(street, city, state, zip) {
  const parts = [street, city, state].filter(Boolean);
  if (zip) parts.push(zip);
  return parts.join(', ') || null;
}

/**
 * Transform NCES feature to our schema
 */
function transformSchool(feature) {
  const attrs = feature.attributes || {};

  const lat = Number(attrs.LAT);
  const lon = Number(attrs.LON);

  // Validate coordinates
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.warn(`[NCES] Invalid coords for ${attrs.NAME}: lat=${attrs.LAT}, lon=${attrs.LON}`);
    return null;
  }

  // Skip closed schools
  if (attrs.STATUS === '2' || attrs.STATUS === 2) {
    console.log(`[NCES] Skipping closed school: ${attrs.NAME}`);
    return null;
  }

  return {
    ncesId: String(attrs.NCESSCH || ''),
    name: String(attrs.NAME || 'Unknown School'),
    lat: lat,
    lon: lon,
    address: formatAddress(attrs.STREET, attrs.CITY, attrs.STATE, attrs.ZIP),
    county: String(attrs.NMCNTY || ''),
    grades: parseGradeRange(attrs.GSLO, attrs.GSHI),
    level: String(attrs.LEVEL || ''),
    phone: attrs.PHONE ? String(attrs.PHONE) : null
  };
}

/**
 * Main function
 */
async function main() {
  console.log('[NCES] Starting NCES Public School Locations fetch...');
  console.log(`[NCES] Target localities: ${TARGET_LOCALITIES.join(', ')}`);

  try {
    // Fetch data (with fallback to older datasets)
    const data = await fetchWithFallback(TARGET_LOCALITIES);

    if (!data.features || data.features.length === 0) {
      throw new Error('No school data returned from NCES API');
    }

    console.log(`[NCES] Raw records received: ${data.features.length}`);

    // Transform and filter
    const schools = data.features
      .map(transformSchool)
      .filter(Boolean);

    console.log(`[NCES] Valid schools after transformation: ${schools.length}`);

    // Group by county for logging
    const byCounty = {};
    for (const school of schools) {
      byCounty[school.county] = (byCounty[school.county] || 0) + 1;
    }
    console.log('[NCES] Schools by locality:');
    for (const [county, count] of Object.entries(byCounty)) {
      console.log(`  - ${county}: ${count}`);
    }

    // Ensure output directory exists
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write output file
    const output = {
      generated: new Date().toISOString(),
      source: 'NCES EDGE Public School Locations',
      localities: TARGET_LOCALITIES,
      count: schools.length,
      schools: schools
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
    console.log(`[NCES] Written ${schools.length} schools to ${OUTPUT_PATH}`);

    // Validate output
    const stats = fs.statSync(OUTPUT_PATH);
    console.log(`[NCES] Output file size: ${(stats.size / 1024).toFixed(1)} KB`);

    console.log('[NCES] Build complete!');
    process.exit(0);

  } catch (err) {
    console.error('[NCES] Build failed:', err.message);
    process.exit(1);
  }
}

main();
