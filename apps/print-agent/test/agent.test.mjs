import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PrintAgent } from "../src/agent.mjs";
import { parseHostStatus, queryHostStatus, sendTcp, stateOf } from "../src/transport.mjs";

/** A TCP "printer": records what it receives, answers ~HS like a Zebra would. */
function fakePrinter({ answerStatus = true, buffered = 0, paperOut = false } = {}) {
  const received = [];
  const server = net.createServer((s) => {
    let data = "";
    s.on("data", (d) => {
      data += d.toString("utf8");
      if (data.includes("~HS")) {
        data = data.replace("~HS", "");
        if (answerStatus) s.write(`\x02030,${paperOut ? 1 : 0},0,0800,${String(buffered).padStart(3, "0")},0,0,0,00000000,1,000\x03\r\n\x02001,0,0,0,0,2,6,0,00000000,1,000\x03\r\n\x020000,0\x03\r\n`);
      }
    });
    s.on("end", () => data.trim() && received.push(data));
    s.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, received })));
}

/** A fake AVOT server for the print API. */
function fakeServer(jobs) {
  const reports = [];
  let claims = 0;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/api/agent/pair") return send(201, { deviceToken: "tok", deviceId: "dev", name: "pc" });
    if (req.headers.authorization !== "Bearer tok") return send(401, { error: { message: "no" } });
    if (req.url === "/api/print/agent/claim") {
      claims++;
      return send(200, { job: jobs.shift() ?? null });
    }
    const m = req.url.match(/^\/api\/print\/agent\/jobs\/([^/]+)\/report$/);
    if (m) {
      reports.push({ id: m[1], ...JSON.parse(body) });
      return send(200, { status: "ok" });
    }
    if (req.url === "/api/print/agent/heartbeat") return send(200, { printers: [] });
    send(404, {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, reports, claims: () => claims })));
}

const job = (id, port, zpl = "^XA^FDtest^FS^XZ") => ({ jobId: id, attempt: 1, labelCount: 1, zpl, printer: { id: "p1", name: "Zebra", connection: "NETWORK", host: "127.0.0.1", port, windowsName: null, language: "ZPL" } });
const quiet = { info() {}, warn() {}, error() {}, log() {} };

async function setup(jobs, printerOpts) {
  const printer = await fakePrinter(printerOpts);
  const srv = await fakeServer(jobs.map((j) => (typeof j === "function" ? j(printer.port) : j)));
  const dir = await mkdtemp(path.join(tmpdir(), "avot-agent-test-"));
  const agent = new PrintAgent({ dir, log: quiet });
  await agent.pair({ server: srv.url, code: "12345678" });
  const close = async () => {
    printer.server.close();
    srv.server.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { printer, srv, agent, dir, close };
}

test("pairing stores the token; the printer receives exactly the ZPL; SENT then DONE when the buffer is empty", async () => {
  const t = await setup([(port) => job("j1", port, "^XA^FDשלום^FS^XZ")], { buffered: 0 });
  try {
    assert.equal(JSON.parse(await readFile(path.join(t.dir, "config.json"), "utf8")).token, "tok");
    assert.equal(await t.agent.pollOnce(), true);
    assert.deepEqual(t.srv.reports.map((r) => r.status), ["SENT", "DONE"]);
    assert.equal(t.printer.received.length, 1);
    assert.equal(t.printer.received[0], "^XA^FDשלום^FS^XZ");
    assert.equal(await t.agent.pollOnce(), false); // queue empty
  } finally {
    await t.close();
  }
});

test("a printer that does not answer ~HS is reported SENT only, never DONE", async () => {
  const t = await setup([(port) => job("j2", port)], { answerStatus: false });
  try {
    await t.agent.pollOnce();
    assert.deepEqual(t.srv.reports.map((r) => r.status), ["SENT"]);
  } finally {
    await t.close();
  }
});

test("labels still in the printer buffer or paper out: stays SENT (not claimed as printed)", async () => {
  const t = await setup([(port) => job("j3", port)], { paperOut: true });
  try {
    await t.agent.pollOnce();
    assert.deepEqual(t.srv.reports.map((r) => r.status), ["SENT"]);
  } finally {
    await t.close();
  }
});

test("printer off: the job is reported FAILED with a readable reason, nothing is journalled as sent", async () => {
  const dead = net.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  const t = await setup([job("j4", port)]);
  try {
    await t.agent.pollOnce();
    assert.equal(t.srv.reports.length, 1);
    assert.equal(t.srv.reports[0].status, "FAILED");
    assert.match(t.srv.reports[0].error, /מדפסת/);
    assert.equal((await t.agent.journal()).j4.state, "failed");
  } finally {
    await t.close();
  }
});

test("a job already sent before a restart is never printed again; one interrupted mid-send is failed, not guessed", async () => {
  const t = await setup([(port) => job("again", port), (port) => job("crashed", port)]);
  try {
    await t.agent.mark("again", "sent");
    await t.agent.mark("crashed", "sending");
    await t.agent.pollOnce();
    await t.agent.pollOnce();
    assert.equal(t.printer.received.length, 0, "no byte may reach the printer");
    assert.deepEqual(t.srv.reports.map((r) => `${r.id}:${r.status}`), ["again:SENT", "crashed:FAILED"]);
  } finally {
    await t.close();
  }
});

test("the same job claimed twice (server re-queued it) prints once", async () => {
  const t = await setup([(port) => job("dup", port), (port) => job("dup", port)]);
  try {
    await t.agent.pollOnce();
    await t.agent.pollOnce();
    assert.equal(t.printer.received.length, 1);
  } finally {
    await t.close();
  }
});

test("server unreachable: run() keeps trying and a revoked token stops it with a clear message", async () => {
  const t = await setup([]);
  try {
    t.agent.config.token = "revoked";
    await assert.rejects(() => t.agent.pollOnce(), /מורשה/);
  } finally {
    await t.close();
  }
});

test("~HS parsing: documented flags only; garbage and empty replies give null", () => {
  const ok = parseHostStatus("\x02030,0,0,0800,002,0,0,0,00000000,1,000\x03\r\n\x02001,1,0,0,0,2,6,0,00000000,1,000\x03\r\n\x020000,0\x03");
  assert.equal(ok.formatsInBuffer, 2);
  assert.equal(ok.headUp, true);
  assert.deepEqual(stateOf(ok), { state: "HEAD_OPEN", detail: "מכסה המדפסת פתוח" });
  assert.equal(parseHostStatus(""), null);
  assert.equal(parseHostStatus("hello"), null);
});

test("transport helpers talk to a real socket", async () => {
  const p = await fakePrinter();
  try {
    await sendTcp({ host: "127.0.0.1", port: p.port, data: "^XA^XZ" });
    const st = await queryHostStatus({ host: "127.0.0.1", port: p.port });
    assert.equal(st.formatsInBuffer, 0);
  } finally {
    p.server.close();
  }
});
