import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const routerPath = resolve(testDir, "..", "router.mjs");
const fakeLarkPath = join(testDir, "fake-lark-cli.mjs");
const fakeProcessTreeAgentPath = join(testDir, "fake-process-tree-agent.mjs");

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runRouter(args, timeout = 20_000, extraEnv = {}) {
  return spawnSync(process.execPath, [routerPath, ...args], {
    encoding: "utf8",
    timeout,
    env: {
      ...process.env,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      ...extraEnv,
    },
  });
}

function runRouterAsync(args, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [routerPath, ...args], {
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ status: code, stdout, stderr }));
  });
}

test("CLI initializes, waits for ready, handles a ping once, and stops gracefully", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-cli-test-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  mkdirSync(workspace);
  chmodSync(fakeLarkPath, 0o755);
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${workspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--bot-open-id", "ou_test_bot",
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);

    const doctor = runRouter(["doctor", "--config", configPath, "--json"]);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).ok, true);

    const fakeEvent = JSON.stringify({
      event_id: "evt-test-ping",
      chat_id: "oc_test",
      chat_type: "p2p",
      sender_id: "ou_test_user",
      sender_type: "user",
      message_id: "om_test_ping",
      message_type: "text",
      content: "/ping",
      mentions: [],
      create_time: String(Date.now()),
    });
    const start = runRouter(
      ["start", "--config", configPath],
      20_000,
      { FAKE_LARK_EVENT: fakeEvent, FAKE_LARK_REPEAT_EVENT: "1" },
    );
    assert.equal(start.status, 0, `${start.stdout}\n${start.stderr}`);
    assert.match(start.stdout, /Router 已启动/);

    const status = runRouter(["status", "--config", configPath, "--json"]);
    assert.equal(status.status, 0, status.stderr);
    const snapshot = JSON.parse(status.stdout);
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.status.consumer, "ready");

    const bridgeLogPath = join(stateDir, "logs", "bridge.ndjson");
    let bridgeLog = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (existsSync(bridgeLogPath)) bridgeLog = readFileSync(bridgeLogPath, "utf8");
      if (bridgeLog.includes('"replyMessageId":"om_fake_reply"')) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.match(bridgeLog, /"message":"reply_succeeded"/);
    assert.match(bridgeLog, /"replyMessageId":"om_fake_reply"/);
    assert.equal((bridgeLog.match(/"message":"reply_succeeded"/g) || []).length, 1);
    assert.match(bridgeLog, /"reason":"duplicate_event"/);

    const stop = runRouter(["stop", "--config", configPath]);
    assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
    assert.match(stop.stdout, /Router 已停止/);
  } finally {
    runRouter(["stop", "--config", configPath]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent start commands produce only one locked bridge", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-lock-test-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  mkdirSync(workspace);
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${workspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);

    const results = await Promise.all([
      runRouterAsync(["start", "--config", configPath]),
      runRouterAsync(["start", "--config", configPath]),
    ]);
    assert.ok(results.some((result) => result.status === 0), JSON.stringify(results));

    const status = runRouter(["status", "--config", configPath, "--json"]);
    assert.equal(status.status, 0, status.stderr);
    const snapshot = JSON.parse(status.stdout);
    assert.equal(snapshot.running, true);
    assert.equal(typeof snapshot.instanceId, "string");

    const bridgeLog = readFileSync(join(stateDir, "logs", "bridge.ndjson"), "utf8");
    assert.equal((bridgeLog.match(/"message":"bridge_start"/g) || []).length, 1);

    const stop = runRouter(["stop", "--config", configPath]);
    assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
  } finally {
    runRouter(["stop", "--config", configPath]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt durable state blocks startup without overwriting the ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-corrupt-state-test-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  const queuePath = join(stateDir, "queue.json");
  mkdirSync(workspace);
  mkdirSync(stateDir);
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${workspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);
    writeFileSync(queuePath, "{malformed", { mode: 0o600 });

    const doctor = runRouter(["doctor", "--config", configPath, "--json"]);
    assert.equal(doctor.status, 1);
    assert.ok(JSON.parse(doctor.stdout).results.some((item) => item.code === "runtime_queue_corrupt"));
    const start = runRouter(["start", "--config", configPath]);
    assert.equal(start.status, 1);
    assert.match(`${start.stdout}\n${start.stderr}`, /状态文件损坏/);
    assert.equal(readFileSync(queuePath, "utf8"), "{malformed");
    assert.equal(existsSync(join(stateDir, "router.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("foreground run instances are visible to status and stoppable through the CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-run-test-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  mkdirSync(workspace);
  let foreground = null;
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${workspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);
    foreground = spawn(process.execPath, [routerPath, "run", "--config", configPath], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let status = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = runRouter(["status", "--config", configPath, "--json"]);
      if (result.stdout.trim()) status = JSON.parse(result.stdout);
      if (status?.running && status.status?.consumer === "ready") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal(status.running, true);
    assert.equal(status.pid, foreground.pid);

    const stopped = new Promise((resolvePromise) => foreground.once("close", resolvePromise));
    const stop = runRouter(["stop", "--config", configPath]);
    assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
    const exitCode = await Promise.race([
      stopped,
      new Promise((_, rejectPromise) => setTimeout(() => rejectPromise(new Error("foreground run did not exit")), 10_000)),
    ]);
    assert.equal(exitCode, 0);
  } finally {
    runRouter(["stop", "--config", configPath]);
    if (foreground && processAlive(foreground.pid)) foreground.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent task events stay serialized and snapshot the sender selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-queue-test-"));
  const mainWorkspace = join(root, "main");
  const secondaryWorkspace = join(root, "secondary");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  mkdirSync(mainWorkspace);
  mkdirSync(secondaryWorkspace);
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${mainWorkspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.workspaces.secondary = secondaryWorkspace;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    const baseEvent = {
      chat_id: "oc_test",
      chat_type: "p2p",
      sender_id: "ou_test_user",
      sender_type: "user",
      message_type: "text",
      mentions: [],
      create_time: String(Date.now()),
    };
    const events = [
      { ...baseEvent, event_id: "evt-task-one", message_id: "om_task_one", content: "first task" },
      { ...baseEvent, event_id: "evt-switch", message_id: "om_switch", content: "/workspace secondary" },
      { ...baseEvent, event_id: "evt-task-two", message_id: "om_task_two", content: "second task" },
    ];
    const start = runRouter(
      ["start", "--config", configPath],
      20_000,
      { FAKE_LARK_EVENTS: JSON.stringify(events) },
    );
    assert.equal(start.status, 0, `${start.stdout}\n${start.stderr}`);

    const bridgeLogPath = join(stateDir, "logs", "bridge.ndjson");
    let entries = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (existsSync(bridgeLogPath)) {
        entries = readFileSync(bridgeLogPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      }
      if (entries.filter((entry) => entry.message === "assistant_done").length === 2) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    const lifecycle = entries
      .filter((entry) => entry.message === "assistant_start" || entry.message === "assistant_done")
      .map((entry) => entry.message);
    assert.deepEqual(lifecycle, ["assistant_start", "assistant_done", "assistant_start", "assistant_done"]);
    assert.deepEqual(
      entries.filter((entry) => entry.message === "assistant_start").map((entry) => entry.workspace),
      ["main", "secondary"],
    );

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const queueState = JSON.parse(readFileSync(join(stateDir, "queue.json"), "utf8"));
      if (queueState.items.length === 0) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir, "queue.json"), "utf8")), { items: [] });

    const stop = runRouter(["stop", "--config", configPath]);
    assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
  } finally {
    runRouter(["stop", "--config", configPath]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed final reply stays in the persistent outbox and is retried after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-outbox-test-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  const replyCounterPath = join(root, "reply-counter.txt");
  mkdirSync(workspace);
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${workspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);
    const event = {
      event_id: "evt-outbox",
      chat_id: "oc_test",
      chat_type: "p2p",
      sender_id: "ou_test_user",
      sender_type: "user",
      message_id: "om_outbox",
      message_type: "text",
      content: "run a task",
      mentions: [],
      create_time: String(Date.now()),
    };
    const firstStart = runRouter(
      ["start", "--config", configPath],
      20_000,
      {
        FAKE_LARK_EVENT: JSON.stringify(event),
        FAKE_LARK_REPLY_COUNTER_FILE: replyCounterPath,
        FAKE_LARK_FAIL_REPLY_FROM: "2",
      },
    );
    assert.equal(firstStart.status, 0, `${firstStart.stdout}\n${firstStart.stderr}`);

    const queuePath = join(stateDir, "queue.json");
    let pending = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (existsSync(queuePath)) pending = JSON.parse(readFileSync(queuePath, "utf8"));
      if (pending?.items?.[0]?.phase === "reply_pending" && pending.items[0].nextAttemptAt > Date.now()) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal(pending.items.length, 1);
    assert.equal(pending.items[0].phase, "reply_pending");

    const firstStop = runRouter(["stop", "--config", configPath]);
    assert.equal(firstStop.status, 0, `${firstStop.stdout}\n${firstStop.stderr}`);
    const secondStart = runRouter(["start", "--config", configPath]);
    assert.equal(secondStart.status, 0, `${secondStart.stdout}\n${secondStart.stderr}`);

    for (let attempt = 0; attempt < 80; attempt += 1) {
      pending = JSON.parse(readFileSync(queuePath, "utf8"));
      if (pending.items.length === 0) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.deepEqual(pending, { items: [] });

    const bridgeLog = readFileSync(join(stateDir, "logs", "bridge.ndjson"), "utf8");
    assert.match(bridgeLog, /"message":"reply_failed"/);
    assert.match(bridgeLog, /"message":"reply_succeeded"/);

    const secondStop = runRouter(["stop", "--config", configPath]);
    assert.equal(secondStop.status, 0, `${secondStop.stdout}\n${secondStop.stderr}`);
  } finally {
    runRouter(["stop", "--config", configPath]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("outbox backpressure prevents unbounded execution during reply outages", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-outbox-limit-test-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  mkdirSync(workspace);
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${workspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.runtime.queueLimit = 1;
    config.runtime.outboxLimit = 1;
    config.reply.maxAttempts = 1;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    mkdirSync(stateDir);
    const oldMessage = {
      eventId: "evt-old",
      chatId: "oc_test",
      chatType: "p2p",
      senderId: "ou_test_user",
      senderType: "user",
      messageId: "om_old_pending",
      messageType: "text",
      mentions: [],
      text: "old task",
      createTime: String(Date.now()),
    };
    writeFileSync(join(stateDir, "queue.json"), `${JSON.stringify({
      items: [{
        jobId: "old-job",
        phase: "reply_pending",
        message: oldMessage,
        task: { kind: "task", text: "old task", confirmed: false },
        backend: "codex",
        workspace: "main",
        acceptedAt: new Date().toISOString(),
        finalText: "old result",
        nextAttemptAt: 0,
      }],
    }, null, 2)}\n`, { mode: 0o600 });
    const newEvent = {
      event_id: "evt-new-during-outage",
      chat_id: "oc_test",
      chat_type: "p2p",
      sender_id: "ou_test_user",
      sender_type: "user",
      message_id: "om_new_during_outage",
      message_type: "text",
      content: "must not execute",
      mentions: [],
      create_time: String(Date.now()),
    };
    const start = runRouter(
      ["start", "--config", configPath],
      20_000,
      { FAKE_LARK_EVENT: JSON.stringify(newEvent), FAKE_LARK_FAIL_REPLY_FROM: "1" },
    );
    assert.equal(start.status, 0, `${start.stdout}\n${start.stderr}`);

    let bridgeLog = "";
    for (let attempt = 0; attempt < 80; attempt += 1) {
      bridgeLog = readFileSync(join(stateDir, "logs", "bridge.ndjson"), "utf8");
      if (bridgeLog.includes('"purpose":"outbox-full"')) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.match(bridgeLog, /"purpose":"outbox-full"/);
    assert.doesNotMatch(bridgeLog, /"message":"assistant_start"/);
    assert.equal(JSON.parse(readFileSync(join(stateDir, "queue.json"), "utf8")).items.length, 1);

    const status = runRouter(["status", "--config", configPath, "--json"]);
    assert.equal(JSON.parse(status.stdout).status.outboxBackpressure, true);
    const stop = runRouter(["stop", "--config", configPath]);
    assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
  } finally {
    runRouter(["stop", "--config", configPath]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("backend process groups are force-cleaned after a wrapper exits", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-process-tree-test-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  const grandchildPidPath = join(root, "grandchild.pid");
  mkdirSync(workspace);
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${workspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.backends.codex.prefixArgs = [fakeProcessTreeAgentPath];
    config.backends.codex.envAllowlist = ["FAKE_AGENT_PID_FILE"];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    const event = {
      event_id: "evt-process-tree",
      chat_id: "oc_test",
      chat_type: "p2p",
      sender_id: "ou_test_user",
      sender_type: "user",
      message_id: "om_process_tree",
      message_type: "text",
      content: "run wrapper",
      mentions: [],
      create_time: String(Date.now()),
    };
    const start = runRouter(
      ["start", "--config", configPath],
      20_000,
      { FAKE_LARK_EVENT: JSON.stringify(event), FAKE_AGENT_PID_FILE: grandchildPidPath },
    );
    assert.equal(start.status, 0, `${start.stdout}\n${start.stderr}`);

    let grandchildPid = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(grandchildPidPath)) grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
      const queue = existsSync(join(stateDir, "queue.json"))
        ? JSON.parse(readFileSync(join(stateDir, "queue.json"), "utf8"))
        : null;
      if (grandchildPid && queue?.items?.length === 0) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.ok(Number.isInteger(grandchildPid));
    for (let attempt = 0; attempt < 40 && processAlive(grandchildPid); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal(processAlive(grandchildPid), false, `grandchild pid ${grandchildPid} leaked`);
    const bridgeLog = readFileSync(join(stateDir, "logs", "bridge.ndjson"), "utf8");
    assert.match(bridgeLog, /"message":"assistant_process_group_force_kill"/);

    const stop = runRouter(["stop", "--config", configPath]);
    assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
  } finally {
    runRouter(["stop", "--config", configPath]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop terminates and waits for a hanging lark reply command", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-reply-lifecycle-test-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  const replyPidPath = join(root, "reply.pid");
  mkdirSync(workspace);
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${workspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);
    const event = {
      event_id: "evt-hanging-reply",
      chat_id: "oc_test",
      chat_type: "p2p",
      sender_id: "ou_test_user",
      sender_type: "user",
      message_id: "om_hanging_reply",
      message_type: "text",
      content: "/ping",
      mentions: [],
      create_time: String(Date.now()),
    };
    const start = runRouter(
      ["start", "--config", configPath],
      20_000,
      { FAKE_LARK_EVENT: JSON.stringify(event), FAKE_LARK_HANG_REPLY_PID_FILE: replyPidPath },
    );
    assert.equal(start.status, 0, `${start.stdout}\n${start.stderr}`);

    let replyPid = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (existsSync(replyPidPath)) replyPid = Number(readFileSync(replyPidPath, "utf8"));
      if (replyPid && processAlive(replyPid)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.ok(Number.isInteger(replyPid));
    assert.equal(processAlive(replyPid), true);

    const statusBeforeStop = runRouter(["status", "--config", configPath, "--json"]);
    assert.equal(JSON.parse(statusBeforeStop.stdout).status.activeReplyCommands, 1);
    const stop = runRouter(["stop", "--config", configPath], 20_000);
    assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
    for (let attempt = 0; attempt < 40 && processAlive(replyPid); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal(processAlive(replyPid), false, `hanging reply pid ${replyPid} leaked`);
  } finally {
    runRouter(["stop", "--config", configPath]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hanging lark reply command times out without blocking the bridge", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-reply-timeout-test-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  const replyPidPath = join(root, "reply.pid");
  mkdirSync(workspace);
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${workspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.reply.maxAttempts = 1;
    config.reply.commandTimeoutSeconds = 3;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const event = {
      event_id: "evt-reply-timeout",
      chat_id: "oc_test",
      chat_type: "p2p",
      sender_id: "ou_test_user",
      sender_type: "user",
      message_id: "om_reply_timeout",
      message_type: "text",
      content: "/ping",
      mentions: [],
      create_time: String(Date.now()),
    };
    const start = runRouter(
      ["start", "--config", configPath],
      20_000,
      { FAKE_LARK_EVENT: JSON.stringify(event), FAKE_LARK_HANG_REPLY_PID_FILE: replyPidPath },
    );
    assert.equal(start.status, 0, `${start.stdout}\n${start.stderr}`);

    let replyPid = null;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (existsSync(replyPidPath)) replyPid = Number(readFileSync(replyPidPath, "utf8"));
      if (replyPid && !processAlive(replyPid)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.ok(Number.isInteger(replyPid));
    assert.equal(processAlive(replyPid), false, `timed out reply pid ${replyPid} leaked`);
    const bridgeLog = readFileSync(join(stateDir, "logs", "bridge.ndjson"), "utf8");
    assert.match(bridgeLog, /"message":"lark_command_timeout"/);
    const status = runRouter(["status", "--config", configPath, "--json"]);
    assert.equal(JSON.parse(status.stdout).status.activeReplyCommands, 0);

    const stop = runRouter(["stop", "--config", configPath]);
    assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
  } finally {
    runRouter(["stop", "--config", configPath]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("control reply floods obey concurrency and pending backpressure limits", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-reply-backpressure-test-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  const replyPidDir = join(root, "reply-pids");
  mkdirSync(workspace);
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${workspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.reply.maxAttempts = 1;
    config.reply.commandTimeoutSeconds = 30;
    config.reply.concurrency = 2;
    config.reply.pendingLimit = 3;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const events = Array.from({ length: 8 }, (_, index) => ({
      event_id: `evt-reply-flood-${index}`,
      chat_id: "oc_test",
      chat_type: "p2p",
      sender_id: "ou_test_user",
      sender_type: "user",
      message_id: `om_reply_flood_${index}`,
      message_type: "text",
      content: "/ping",
      mentions: [],
      create_time: String(Date.now()),
    }));
    const start = runRouter(
      ["start", "--config", configPath],
      20_000,
      { FAKE_LARK_EVENTS: JSON.stringify(events), FAKE_LARK_HANG_REPLY_DIR: replyPidDir },
    );
    assert.equal(start.status, 0, `${start.stdout}\n${start.stderr}`);

    let snapshot = null;
    let bridgeLog = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      snapshot = JSON.parse(runRouter(["status", "--config", configPath, "--json"]).stdout).status;
      const bridgeLogPath = join(stateDir, "logs", "bridge.ndjson");
      if (existsSync(bridgeLogPath)) bridgeLog = readFileSync(bridgeLogPath, "utf8");
      if (snapshot.activeReplyCommands === 2 && snapshot.pendingReplies === 3 && bridgeLog.includes('"message":"reply_backpressure"')) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal(snapshot.activeReplyCommands, 2);
    assert.equal(snapshot.activeReplySlots, 2);
    assert.equal(snapshot.pendingReplies, 3);
    assert.equal(snapshot.replyBackpressure, true);
    assert.match(bridgeLog, /"message":"reply_backpressure"/);
    const replyPids = readdirSync(replyPidDir).map((name) => Number.parseInt(name, 10));
    assert.equal(replyPids.length, 2, `unexpected reply processes: ${replyPids.join(", ")}`);
    assert.equal(replyPids.every(processAlive), true);

    const stop = runRouter(["stop", "--config", configPath], 20_000);
    assert.equal(stop.status, 0, `${stop.stdout}\n${stop.stderr}`);
    for (let attempt = 0; attempt < 40 && replyPids.some(processAlive); attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal(replyPids.some(processAlive), false, `hanging reply pids leaked: ${replyPids.join(", ")}`);
  } finally {
    runRouter(["stop", "--config", configPath]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stop-blocked consumer finalizes automatically after external event-stop relief", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-agent-router-stop-blocked-test-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const configPath = join(root, "config.json");
  const consumerPidPath = join(root, "consumer.pid");
  mkdirSync(workspace);
  let consumerPid = null;
  try {
    const init = runRouter([
      "init", "--no-autostart",
      "--config", configPath,
      "--sender-id", "ou_test_user",
      "--workspace", `main=${workspace}`,
      "--backend", "codex",
      "--backend-command", process.execPath,
      "--lark-command", fakeLarkPath,
      "--state-dir", stateDir,
    ]);
    assert.equal(init.status, 0, init.stderr);
    const start = runRouter(
      ["start", "--config", configPath],
      20_000,
      { FAKE_LARK_STUBBORN_CONSUMER_PID_FILE: consumerPidPath },
    );
    assert.equal(start.status, 0, `${start.stdout}\n${start.stderr}`);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (existsSync(consumerPidPath)) consumerPid = Number(readFileSync(consumerPidPath, "utf8"));
      if (consumerPid && processAlive(consumerPid)) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    const before = JSON.parse(runRouter(["status", "--config", configPath, "--json"]).stdout);
    const bridgePid = before.pid;
    const stop = runRouter(["stop", "--config", configPath], 20_000);
    assert.equal(stop.status, 1);
    assert.match(`${stop.stdout}\n${stop.stderr}`, /未在超时内退出/);
    const blocked = JSON.parse(runRouter(["status", "--config", configPath, "--json"]).stdout);
    assert.equal(blocked.running, true);
    assert.equal(blocked.status.consumer, "stop_blocked");

    process.kill(consumerPid, "SIGUSR1");
    let after = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = runRouter(["status", "--config", configPath, "--json"]);
      after = JSON.parse(status.stdout);
      if (!after.running) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal(after.running, false);
    assert.equal(processAlive(bridgePid), false);
  } finally {
    if (consumerPid && processAlive(consumerPid)) process.kill(consumerPid, "SIGUSR1");
    runRouter(["stop", "--config", configPath]);
    rmSync(root, { recursive: true, force: true });
  }
});
