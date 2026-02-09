#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const catalogPath = path.join(__dirname, '..', 'data', 'gis-catalog.json');

const readCatalog = () => {
  const raw = fs.readFileSync(catalogPath, 'utf8');
  return JSON.parse(raw);
};

const writeCatalog = (catalog) => {
  const formatted = `${JSON.stringify(catalog, null, 2)}\n`;
  fs.writeFileSync(catalogPath, formatted, 'utf8');
};

const extractItemId = (value) => {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const patterns = [
    /content\/items\/([0-9a-f]{32})/i,
    /items\/([0-9a-f]{32})/i,
    /datasets\/([0-9a-f]{32})/i,
    /[?&]itemId=([0-9a-f]{32})/i,
    /([0-9a-f]{32})/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
};

const resolvePortalBase = (entry) => {
  if (entry.portalBase) {
    return entry.portalBase;
  }
  const url = entry.url || entry.layerUrl || '';
  if (url.includes('gis.spotsylvania.va.us/portal')) {
    return 'https://gis.spotsylvania.va.us/portal';
  }
  return 'https://www.arcgis.com';
};

const resolveItemId = (entry) => {
  if (entry.itemId) {
    return entry.itemId;
  }
  return extractItemId(entry.url) || extractItemId(entry.layerUrl);
};

const resolveLayerUrl = (itemUrl) => {
  if (!itemUrl || typeof itemUrl !== 'string') {
    return null;
  }
  const trimmed = itemUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/FeatureServer') || trimmed.endsWith('/MapServer')) {
    return `${trimmed}/0`;
  }
  return null;
};

const updateEntryFromItem = (entry, item, updates) => {
  if (!entry.name && item.title) {
    entry.name = item.title;
  }
  if (item.url && /FeatureServer|MapServer/i.test(item.url)) {
    entry.kind = 'featureLayer';
    const layerUrl = resolveLayerUrl(item.url);
    if (layerUrl) {
      entry.layerUrl = layerUrl;
    }
  }
  if (updates.itemId) {
    entry.itemId = updates.itemId;
  }
  if (updates.portalBase) {
    entry.portalBase = updates.portalBase;
  }
};

const updateCatalog = async () => {
  const catalog = readCatalog();
  const summary = [];

  const sections = Object.keys(catalog).filter((key) => Array.isArray(catalog[key]));

  for (const section of sections) {
    for (const entry of catalog[section]) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const itemId = resolveItemId(entry);
      if (!itemId) {
        summary.push({
          key: entry.key || '(unknown)',
          name: entry.name || '',
          kind: entry.kind || '',
          layerUrl: entry.layerUrl ? 'yes' : 'no',
          status: 'skipped',
        });
        continue;
      }
      const portalBase = resolvePortalBase(entry);
      entry.itemId = itemId;
      entry.portalBase = portalBase;
      const url = `${portalBase}/sharing/rest/content/items/${itemId}?f=pjson`;

      try {
        const response = await fetch(url);
        if (!response.ok) {
          summary.push({
            key: entry.key || '(unknown)',
            name: entry.name || '',
            kind: entry.kind || '',
            layerUrl: entry.layerUrl ? 'yes' : 'no',
            status: `failed (${response.status})`,
          });
          continue;
        }
        const item = await response.json();
        if (item.error) {
          summary.push({
            key: entry.key || '(unknown)',
            name: entry.name || '',
            kind: entry.kind || '',
            layerUrl: entry.layerUrl ? 'yes' : 'no',
            status: 'failed (error)',
          });
          continue;
        }
        updateEntryFromItem(entry, item, { itemId, portalBase });
        summary.push({
          key: entry.key || '(unknown)',
          name: entry.name || item.title || '',
          kind: entry.kind || '',
          layerUrl: entry.layerUrl ? 'yes' : 'no',
          status: 'ok',
        });
      } catch (error) {
        summary.push({
          key: entry.key || '(unknown)',
          name: entry.name || '',
          kind: entry.kind || '',
          layerUrl: entry.layerUrl ? 'yes' : 'no',
          status: 'failed',
        });
      }
    }
  }

  writeCatalog(catalog);
  console.table(summary, ['key', 'name', 'kind', 'layerUrl', 'status']);
};

updateCatalog();
