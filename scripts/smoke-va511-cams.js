const port = Number(process.env.PORT) || 8000;
const baseUrl = `http://127.0.0.1:${port}/api/va511/cams`;
const bboxQuery = "-77.75,38.15,-77.25,38.45";
const url = baseUrl;
const urlWithBbox = `${baseUrl}?bbox=${encodeURIComponent(bboxQuery)}&limit=500`;

async function fetchCams(targetUrl, label) {
  const response = await fetch(targetUrl);
  if (!response.ok) {
    throw new Error(`${label} request failed with status ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || payload.ok !== true) {
    throw new Error(`${label} expected ok === true in response`);
  }
  if (!Array.isArray(payload.cams)) {
    throw new Error(`${label} expected cams to be an array`);
  }
  return payload;
}

async function run() {
  const payload = await fetchCams(url, "Default");
  const count = Number.isFinite(payload.count) ? payload.count : payload.cams.length;
  console.log(`VA511 cams count: ${count}`);

  const bboxPayload = await fetchCams(urlWithBbox, "BBox");
  const bboxCount = Number.isFinite(bboxPayload.count) ? bboxPayload.count : bboxPayload.cams.length;
  if (bboxPayload.cams.length > 500) {
    throw new Error("BBox response exceeded limit 500");
  }
  console.log(`VA511 cams (bbox) count: ${bboxCount}`);
}

run().catch((err) => {
  console.error("Smoke test failed:", err.message);
  process.exit(1);
});
