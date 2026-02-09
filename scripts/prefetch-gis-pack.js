#!/usr/bin/env node
"use strict";

const path = require("path");
const {
  fetchGisEntry,
  isGisCacheItemValid,
  listGisCatalogEntries,
  loadGisCachedData,
  readGisCacheIndex,
  readGisCatalog,
  removeGisCacheFiles,
  updateGisCacheIndexItem
} = require(path.join("..", "proxy-server"));

const PACK_DEFINITIONS = {
  core: {
    label: "Core: map + basic boundaries/roads",
    groups: new Set(["basemapEnhancers", "toggleLayers", "cityLayers"]),
    tiers: new Set(["core"])
  },
  field: {
    label: "Field: FXBG + Stafford + Spotsy operational layers",
    groups: new Set(["basemapEnhancers", "toggleLayers", "cityLayers", "environmentalTopo", "spotsy", "fredBusMode"]),
    tiers: new Set(["core", "optional", "field", "heavy"])
  }
};

const DEFAULT_MAX_MB = 250;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "n/a";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

async function buildPackEntries(packKey, catalog) {
  const def = PACK_DEFINITIONS[packKey];
  const entries = listGisCatalogEntries(catalog);
  return entries.filter((entry) => {
    if (!entry?.offline) return false;
    if (!def.groups.has(entry.category)) return false;
    return def.tiers.has(entry.offline?.tier);
  });
}

async function calculateCachedBytes(entries) {
  const index = await readGisCacheIndex();
  let total = 0;
  for (const entry of entries) {
    const item = index.items?.[entry.key];
    if (!item?.cached) continue;
    const valid = await isGisCacheItemValid(entry.key, item);
    if (valid) total += item.bytes || 0;
  }
  return total;
}

async function main() {
  const packKey = process.argv[2];
  if (!packKey || !PACK_DEFINITIONS[packKey]) {
    console.error("Usage: node scripts/prefetch-gis-pack.js <core|field>");
    process.exit(1);
  }

  const maxMb = Number(process.env.GIS_PREFETCH_MAX_MB || DEFAULT_MAX_MB);
  const maxBytes = Number.isFinite(maxMb) && maxMb > 0 ? maxMb * 1024 * 1024 : DEFAULT_MAX_MB * 1024 * 1024;

  const catalog = await readGisCatalog();
  const entries = await buildPackEntries(packKey, catalog);
  const label = PACK_DEFINITIONS[packKey].label;

  console.log(`[GIS Prefetch] Pack: ${packKey} (${label})`);
  console.log(`[GIS Prefetch] Layers: ${entries.length}`);
  console.log(`[GIS Prefetch] Max total bytes: ${formatBytes(maxBytes)}\n`);

  let runningBytes = await calculateCachedBytes(entries);
  const summary = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const index = await readGisCacheIndex();
    const cachedItem = index.items?.[entry.key];
    const cachedValid = cachedItem?.cached ? await isGisCacheItemValid(entry.key, cachedItem) : false;
    const cachedBytes = cachedItem?.bytes || 0;
    const prefix = `[${i + 1}/${entries.length}] ${entry.key}`;

    if (cachedValid) {
      console.log(`${prefix} already cached (${formatBytes(cachedBytes)})`);
      summary.push({
        key: entry.key,
        name: entry.name || "",
        status: "cached",
        bytes: cachedBytes,
        note: "already cached"
      });
      continue;
    }

    const estMb = Number(entry?.offline?.estSizeMB);
    const estBytes = Number.isFinite(estMb) ? estMb * 1024 * 1024 : null;
    if (estBytes !== null && runningBytes + estBytes > maxBytes) {
      console.warn(`${prefix} skipped (estimate ${formatBytes(estBytes)} exceeds remaining budget)`);
      summary.push({
        key: entry.key,
        name: entry.name || "",
        status: "skipped",
        bytes: 0,
        note: "budget_exceeded"
      });
      continue;
    }

    console.log(`${prefix} downloading...`);
    const fetchResult = await fetchGisEntry(entry.key, entry);
    if (!fetchResult.ok) {
      console.warn(`${prefix} failed: ${fetchResult.error || "download_failed"}`);
      summary.push({
        key: entry.key,
        name: entry.name || "",
        status: "failed",
        bytes: 0,
        note: fetchResult.error || "download_failed"
      });
      continue;
    }

    const dataResult = await loadGisCachedData(entry.key);
    if (!dataResult.ok) {
      console.warn(`${prefix} failed to read cache (${dataResult.error || "not_cached"})`);
      summary.push({
        key: entry.key,
        name: entry.name || "",
        status: "failed",
        bytes: 0,
        note: dataResult.error || "not_cached"
      });
      continue;
    }

    const layerBytes = dataResult.payload?.length || fetchResult.bytes || 0;
    if (runningBytes + layerBytes > maxBytes) {
      console.warn(`${prefix} skipped after download (over budget by ${formatBytes(runningBytes + layerBytes - maxBytes)})`);
      await removeGisCacheFiles(entry.key, cachedItem);
      await updateGisCacheIndexItem(entry.key, (current) => ({
        ...current,
        key: entry.key,
        cached: false,
        bytes: 0,
        cachedAt: null,
        lastUsedAt: null
      }));
      summary.push({
        key: entry.key,
        name: entry.name || "",
        status: "skipped",
        bytes: 0,
        note: "budget_exceeded"
      });
      continue;
    }

    runningBytes += layerBytes;
    console.log(`${prefix} cached (${formatBytes(layerBytes)})`);
    summary.push({
      key: entry.key,
      name: entry.name || "",
      status: fetchResult.cached ? "cached" : "downloaded",
      bytes: layerBytes,
      note: ""
    });
  }

  console.log("\n[GIS Prefetch] Summary");
  console.table(summary.map((row) => ({
    key: row.key,
    name: row.name,
    status: row.status,
    bytes: formatBytes(row.bytes),
    note: row.note
  })));
  console.log(`[GIS Prefetch] Total bytes (pack): ${formatBytes(runningBytes)}`);
}

main().catch((err) => {
  console.error("[GIS Prefetch] Failed:", err?.message || err);
  process.exit(1);
});
