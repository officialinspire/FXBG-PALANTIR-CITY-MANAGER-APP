const port = Number(process.env.PORT) || 8000;
const url = `http://127.0.0.1:${port}/api/va511/cams`;

async function run() {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || payload.ok !== true) {
    throw new Error("Expected ok === true in response");
  }
  if (!Array.isArray(payload.cams)) {
    throw new Error("Expected cams to be an array");
  }
  const count = Number.isFinite(payload.count) ? payload.count : payload.cams.length;
  console.log(`VA511 cams count: ${count}`);
}

run().catch((err) => {
  console.error("Smoke test failed:", err.message);
  process.exit(1);
});
