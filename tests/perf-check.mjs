// Response-time check of the main screens against a running server with load-test data
// (npm run seed:perf). Usage: node tests/perf-check.mjs [baseUrl]
const BASE = process.argv[2] ?? "http://localhost:3000";
const res = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: BASE },
  body: JSON.stringify({ email: process.env.E2E_ADMIN_EMAIL ?? "admin@avot.local", password: process.env.E2E_ADMIN_PASSWORD ?? "Avot-Dev-2026!" }),
});
const cookie = res.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("login failed");
const get = async (path) => {
  const t = performance.now();
  const r = await fetch(BASE + path, { headers: { cookie } });
  const body = await r.text();
  return { ms: Math.round(performance.now() - t), status: r.status, kb: Math.round(body.length / 1024), body };
};
const catalogs = JSON.parse((await get("/api/catalogs?status=ALL")).body).catalogs.filter((c) => c.number.startsWith("LOAD-"));
if (!catalogs.length) throw new Error("no load-test catalogs — run npm run seed:perf");
const lots = JSON.parse((await get(`/api/catalogs/${catalogs[0].id}/lots`)).body).lots;
const busiest = lots.reduce((a, b) => (b.photoCount > a.photoCount ? b : a));
const checks = [
  ["dashboard", "/"],
  ["catalog list", "/catalogs?status=ALL"],
  [`catalog lots page (${lots.length} lots)`, `/catalogs/${catalogs[0].id}`],
  [`lot page (${busiest.photoCount} photos)`, `/lots/${busiest.id}`],
  [`gallery page (${busiest.photoCount} photos)`, `/lots/${busiest.id}/gallery`],
  ["capture screen", `/capture/${busiest.id}`],
  ["assets API", `/api/lots/${busiest.id}/assets`],
  ["search 'ספר בדיקה 77'", `/search?q=${encodeURIComponent("ספר בדיקה 77")}`],
  ["reports", "/reports"],
];
console.log(`load: ${catalogs.length} catalogs; first has ${lots.length} lots, ${lots.reduce((a, l) => a + l.photoCount, 0)} photos\n`);
for (const [name, path] of checks) {
  await get(path); // warm
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await get(path));
  const med = runs.map((r) => r.ms).sort((a, b) => a - b)[1];
  console.log(`${String(med).padStart(5)} ms  ${String(runs[0].kb).padStart(5)} KB  ${runs[0].status}  ${name}`);
}
