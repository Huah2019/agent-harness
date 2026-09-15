import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const cli = join(testDir, "../router.mjs");
const fakeLark = join(testDir, "fake-lark-cli.mjs");
const fakeAgent = join(testDir, "fake-session-agent.mjs");

test("configured generic routing directory dispatches new/resume sessions to target and survives restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "router-sessions-test-"));
  const configPath = join(root, "config.json");
  const target = join(root, "user-project");
  const routing = join(root, "generic-entry");
  const state = join(root, "state");
  mkdirSync(target);
  chmodSync(fakeLark, 0o755);
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args, "--config", configPath], {
    encoding: "utf8", timeout: 20000, env: { ...process.env, FAKE_LARK_OWNER: "ou_test", ...env },
  });
  const event = (text, index, chat = "oc_one") => ({ event_id: `evt_${index}`, message_id: `om_${index}`,
    sender_id: "ou_test", sender_type: "user", chat_id: chat, chat_type: "p2p", message_type: "text",
    content: text, create_time: String(Date.now()), mentions: [] });
  const waitDrain = async (jobCount) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const logPath = join(state, "logs/bridge.ndjson");
      const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
      if ((log.match(/"purpose":"final-/g) || []).length >= jobCount
          && JSON.parse(readFileSync(join(state, "queue.json"), "utf8")).items.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("queued tasks did not finish");
  };
  try {
    const init = run(["init", "--no-autostart", "--sender-id", "ou_test", "--workspace", `main=${target}`,
      "--router-dir", routing, "--state-dir", state, "--backend", "traex",
      "--backend-command", process.execPath, "--lark-command", fakeLark]);
    assert.equal(init.status, 0, init.stderr);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.backends.traex.prefixArgs = [fakeAgent];
    writeFileSync(configPath, JSON.stringify(config));
    assert.equal(config.routing.directory, routing);
    assert.ok(readFileSync(join(routing, "AGENTS.md"), "utf8").includes("飞书会话路由"));
    const doctor = run(["doctor", "--json"]);
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    const events = [event("alpha", 1), event("beta", 2), event("continue alpha", 3), event("continue alpha", 4, "oc_other"), event("hello", 5)];
    const start = run(["start"], { FAKE_LARK_EVENTS: JSON.stringify(events) });
    assert.equal(start.status, 0, start.stdout + start.stderr);
    await waitDrain(5);
    const workers = readFileSync(join(target, "fixture-worker.log"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(workers.length, 3);
    assert.notEqual(workers[0].id, workers[1].id);
    assert.equal(workers[0].id, workers[2].id);
    assert.equal(workers[2].request, "continue alpha");
    assert.equal(workers[2].cwd, realpathSync(target));
    assert.ok(!existsSync(join(routing, "fixture-worker.log")));
    const ledger = JSON.parse(readFileSync(join(state, "routing-sessions.json"), "utf8"));
    assert.equal(ledger.sessions.length, 2);
    assert.ok(ledger.sessions.every((session) => session.status === "ready"));
    assert.equal(run(["stop"]).status, 0);
    const restart = run(["start"], { FAKE_LARK_EVENTS: JSON.stringify([event("continue alpha", 6)]) });
    assert.equal(restart.status, 0, restart.stderr);
    await waitDrain(6);
    const after = readFileSync(join(target, "fixture-worker.log"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(after.length, 4);
    assert.equal(after[3].id, workers[0].id);
  } finally {
    run(["stop"]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("init preserves customized routing rules and rejects malformed routing config", () => {
  const root = mkdtempSync(join(tmpdir(), "router-init-test-"));
  const target = join(root, "project");
  const routing = join(root, "entry");
  const configPath = join(root, "config.json");
  mkdirSync(target); mkdirSync(routing);
  writeFileSync(join(routing, "AGENTS.md"), "custom routing rules");
  const run = (args) => spawnSync(process.execPath, [cli, ...args, "--config", configPath], { encoding: "utf8", timeout: 20000, env: { ...process.env, FAKE_LARK_OWNER: "ou_test" } });
  try {
    const init = run(["init", "--no-autostart", "--sender-id", "ou_test", "--workspace", `main=${target}`, "--router-dir", routing,
      "--backend-command", process.execPath, "--lark-command", fakeLark, "--state-dir", join(root, "state")]);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(readFileSync(join(routing, "AGENTS.md"), "utf8"), "custom routing rules");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.routing = { mode: "agent", directory: "relative/path" };
    writeFileSync(configPath, JSON.stringify(config));
    const doctor = run(["doctor", "--json"]);
    assert.equal(doctor.status, 1);
    assert.match(doctor.stdout, /invalid_routing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stop during successful router shutdown never dispatches a worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "router-stop-routing-test-"));
  const configPath = join(root, "config.json");
  const target = join(root, "project");
  const routing = join(root, "entry");
  const state = join(root, "state");
  mkdirSync(target);
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args, "--config", configPath], {
    encoding: "utf8", timeout: 20000, env: { ...process.env, FAKE_LARK_OWNER: "ou_test", ...env },
  });
  try {
    const init = run(["init", "--no-autostart", "--sender-id", "ou_test", "--workspace", `main=${target}`, "--router-dir", routing,
      "--state-dir", state, "--backend", "traex", "--backend-command", process.execPath, "--lark-command", fakeLark]);
    assert.equal(init.status, 0, init.stderr);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.backends.traex.prefixArgs = [join(testDir, "fake-graceful-routing-agent.mjs")];
    writeFileSync(configPath, JSON.stringify(config));
    const event = { event_id: "stop_evt", message_id: "stop_message", sender_id: "ou_test", sender_type: "user",
      chat_id: "oc_stop", chat_type: "p2p", message_type: "text", content: "work", create_time: String(Date.now()), mentions: [] };
    const start = run(["start"], { FAKE_LARK_EVENTS: JSON.stringify([event]) });
    assert.equal(start.status, 0, start.stdout + start.stderr);
    for (let attempt = 0; attempt < 150 && !existsSync(join(routing, "fixture-router-ready")); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(existsSync(join(routing, "fixture-router-ready")), "router stage must have started");
    const stop = run(["stop"]);
    assert.equal(stop.status, 0, stop.stdout + stop.stderr);
    assert.ok(!existsSync(join(target, "fixture-worker-started")), "no worker may start after shutdown begins");
    const log = readFileSync(join(state, "logs/bridge.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
    const routerDone = log.find((entry) => entry.message === "assistant_done");
    assert.equal(routerDone?.code, 0, "fixture router deliberately finishes with exit code 0");
    assert.ok(!log.some((entry) => entry.message === "route_selected"));
  } finally {
    run(["stop"]);
    rmSync(root, { recursive: true, force: true });
  }
});
