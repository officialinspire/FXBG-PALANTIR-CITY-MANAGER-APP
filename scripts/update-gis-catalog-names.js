#!/usr/bin/env node
/**
 * update-gis-catalog-names.js
 *
 * Reads data/gis-catalog.json, resolves human-readable names for entries
 * that are missing a name by querying ArcGIS REST metadata endpoints.
 *
 * Usage:  node scripts/update-gis-catalog-names.js
 *   or:   npm run gis:names
 *
 * Rate-limited to ~200ms between requests. Failures are logged but do not abort.
 */

const fs = require("fs");
const path = require("path");

const CATALOG_PATH = path.join(__dirname, "..", "data", "gis-catalog.json");
const DELAY_MS = 200;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Try to extract an ArcGIS item ID from a content/items URL pattern.
 * e.g. https://www.arcgis.com/home/item.html?id=ABC123
 *      https://www.arcgis.com/sharing/rest/content/items/ABC123/data
 */
function extractArcgisItemId(url) {
  // Pattern: /content/items/<ID>/...
  const itemMatch = url.match(/\/content\/items\/([a-f0-9]+)/i);
  if (itemMatch) return itemMatch[1];
  // Pattern: ?id=<ID>
  try {
    const u = new URL(url);
    const idParam = u.searchParams.get("id");
    if (idParam && /^[a-f0-9]+$/i.test(idParam)) return idParam;
  } catch (_) {}
  return null;
}

/**
 * For a standard ArcGIS REST FeatureServer/MapServer layer URL,
 * fetch the layer metadata to get the layer name.
 * e.g. https://server/arcgis/rest/services/OpenData/OpenData/MapServer/7?f=json
 */
async function fetchArcgisLayerName(layerUrl) {
  // Ensure URL ends without /query and add ?f=json
  let metaUrl = layerUrl.replace(/\/query\??.*$/i, "");
  const sep = metaUrl.includes("?") ? "&" : "?";
  metaUrl = `${metaUrl}${sep}f=json`;

  const resp = await fetch(metaUrl, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data.name || data.title || null;
}

/**
 * For an ArcGIS Online item ID, fetch the item metadata to get the title.
 */
async function fetchArcgisItemTitle(itemId) {
  const url = `https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`;
  const resp = await fetch(url, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data.title || data.name || null;
}

async function main() {
  console.log(`Reading catalog: ${CATALOG_PATH}`);

  if (!fs.existsSync(CATALOG_PATH)) {
    console.error("Catalog file not found:", CATALOG_PATH);
    process.exit(1);
  }

  const raw = fs.readFileSync(CATALOG_PATH, "utf8");
  const catalog = JSON.parse(raw);
  const overlays = catalog.overlays || [];

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of overlays) {
    // Skip if name already present and non-empty
    if (entry.name && String(entry.name).trim() && !entry.name.startsWith("[Unnamed]")) {
      skipped++;
      continue;
    }

    const entryLabel = entry.id || entry.url || "(unknown)";
    console.log(`  Resolving name for: ${entryLabel}`);

    try {
      let resolvedName = null;

      // Strategy 1: ArcGIS item ID in URL
      if (entry.url) {
        const itemId = extractArcgisItemId(entry.url);
        if (itemId) {
          console.log(`    Trying ArcGIS item ID: ${itemId}`);
          resolvedName = await fetchArcgisItemTitle(itemId);
        }
      }

      // Strategy 2: ArcGIS REST layer metadata
      if (!resolvedName && entry.url && entry.type === "arcgis") {
        console.log(`    Trying ArcGIS layer metadata...`);
        resolvedName = await fetchArcgisLayerName(entry.url);
      }

      if (resolvedName) {
        console.log(`    -> Resolved: "${resolvedName}"`);
        entry.name = resolvedName;
        updated++;
      } else {
        console.log(`    -> Could not resolve name, keeping as-is.`);
        failed++;
      }
    } catch (err) {
      console.warn(`    -> Error resolving ${entryLabel}: ${err.message}`);
      failed++;
    }

    // Rate limit
    await sleep(DELAY_MS);
  }

  // Update timestamp
  catalog.updated = new Date().toISOString();

  // Write back
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n", "utf8");

  console.log(`\nDone. Updated: ${updated}, Skipped (already named): ${skipped}, Failed: ${failed}`);
  console.log(`Catalog written to: ${CATALOG_PATH}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
