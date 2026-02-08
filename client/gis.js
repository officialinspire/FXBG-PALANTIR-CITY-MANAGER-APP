export async function getGisCatalog() {
  const res = await fetch("/api/gis/catalog");
  if (!res.ok) {
    throw new Error(`Failed to load GIS catalog: ${res.status}`);
  }
  return res.json();
}

export async function ensureGisCached(key) {
  const res = await fetch(`/api/gis/fetch?key=${encodeURIComponent(key)}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to cache GIS layer: ${res.status} ${text}`);
  }
  return res.json();
}

export async function loadGisGeojson(key) {
  const res = await fetch(`/api/gis/data?key=${encodeURIComponent(key)}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load GIS data: ${res.status} ${text}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    throw new Error(`Unexpected GIS payload: ${contentType}`);
  }
  return res.json();
}
