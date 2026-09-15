import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../router-lib.mjs";
import {
  buildRoutingPrompt, buildSessionInvocation, loadSessions, parseRoutingDecision,
  routingScope, saveSessions, sessionIdFromOutput, validateRouting,
} from "../routing.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "feishu-routing-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["router", "work", "other", "state"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "router", "AGENTS.md"), "按主题选择会话。\n");
  const config = normalizeConfig({
    allowedSenderIds: ["ou_a"], defaultWorkspace: "main", workspaces: { main: join(root, "work") },
    activeBackend: "codex", backends: {
      codex: { type: "codex", command: "codex", mode: "new" },
      traex: { type: "traex", command: "traex", mode: "new" },
      claude: { type: "claude", command: "claude", continue: false },
    }, routing: { mode: "agent", directory: join(root, "router") }, runtime: { stateDir: join(root, "state") },
  }, join(root, "config.json"));
  const item = { message: { senderId: "ou_a", chatId: "oc_a" }, workspace: "main", backend: "codex", task: { text: "继续刚才的修复" } };
  const session = { id: "session-1", scope: routingScope(config, item), status: "ready", title: "修复", updatedAt: "2026-09-15T00:00:00Z", lastRequest: "检查错误", summary: "已找到错误" };
  return { root, config, item, session };
}

test("routing decisions accept only complete new, scoped resume and reply objects", () => {
  const sessions = [{ id: "known", status: "ready" }, { id: "uncertain", status: "uncertain" }];
  for (const decision of [{ action: "new", title: "新问题" }, { action: "resume", sessionId: "known" }, { action: "reply", text: "请指定任务" }]) {
    assert.deepEqual(parseRoutingDecision(JSON.stringify(decision), sessions), decision);
  }
  for (const text of ["not json", "null", "[]", "{}", '{"action":"delete"}', '{"action":"new","title":" "}', '{"action":"reply","text":""}', '{"action":"new","title":"ok","workspace":"foreign"}']) {
    assert.throws(() => parseRoutingDecision(text, sessions), undefined, text);
  }
  for (const sessionId of ["foreign", "uncertain", "--last", "../known", null]) {
    assert.throws(() => parseRoutingDecision(JSON.stringify({ action: "resume", sessionId }), sessions), /未恢复会话/);
  }
  assert.throws(() => parseRoutingDecision(JSON.stringify({ action: "new", title: "x".repeat(121) }), sessions));
  assert.throws(() => parseRoutingDecision(JSON.stringify({ action: "reply", text: "x".repeat(5001) }), sessions));
});

test("session scopes isolate sender, chat, workspace path, alias and backend configuration", (t) => {
  const { root, config, item } = fixture(t);
  const original = routingScope(config, item);
  for (const changed of [{ ...item, message: { ...item.message, senderId: "ou_b" } }, { ...item, message: { ...item.message, chatId: "oc_b" } }, { ...item, backend: "traex" }]) {
    assert.notEqual(routingScope(config, changed), original);
  }
  config.workspaces.alias = config.workspaces.main;
  assert.notEqual(routingScope(config, { ...item, workspace: "alias" }), original);
  const work = config.workspaces.main;
  config.workspaces.main = join(root, "other");
  assert.notEqual(routingScope(config, item), original);
  symlinkSync(work, join(root, "link"));
  config.workspaces.main = join(root, "link");
  assert.equal(routingScope(config, item), original);
  config.backends.codex.model = "other-model";
  assert.notEqual(routingScope(config, item), original);
});

test("session ledger loads defaults and rejects corrupt or duplicate records without rewriting", (t) => {
  const { config, session } = fixture(t);
  assert.deepEqual(loadSessions(config), { version: 1, sessions: [] });
  const ledger = { version: 1, sessions: [session] };
  saveSessions(config, ledger);
  assert.deepEqual(loadSessions(config), ledger);
  const path = join(config.runtime.stateDir, "routing-sessions.json");
  for (const contents of ["{broken", JSON.stringify({ version: 2, sessions: [] }), JSON.stringify({ version: 1, sessions: [session, session] }), JSON.stringify({ version: 1, sessions: [{ ...session, status: "running" }] })]) {
    writeFileSync(path, contents);
    assert.throws(() => loadSessions(config));
    assert.equal(readFileSync(path, "utf8"), contents);
  }
});

test("routing validates directories, supported adapters and conflicting fixed-session flags", (t) => {
  const { config } = fixture(t);
  assert.deepEqual(validateRouting(config), []);
  for (const routing of [null, [], { mode: "unknown" }, { mode: "agent", directory: "relative" }, { mode: "agent", directory: config.workspaces.main }]) {
    assert.ok(validateRouting({ ...config, routing }).length > 0);
  }
  assert.deepEqual(validateRouting({ ...config, routing: { mode: "direct" } }), []);
  assert.deepEqual(validateRouting({ ...config, routing: undefined }), []);
  for (const patch of [{ type: "generic" }, { mode: "resume" }, { sessionId: "fixed" }, { continue: true }, { prefixArgs: ["--last"] }, { prefixArgs: ["--cd=/tmp"] }, { args: ["--output-last-message", "/tmp/out"] }]) {
    const modified = structuredClone(config);
    Object.assign(modified.backends.codex, patch);
    assert.ok(validateRouting(modified).length > 0, JSON.stringify(patch));
  }
  writeFileSync(join(config.routing.directory, "AGENTS.md"), "x".repeat(65537));
  assert.ok(validateRouting(config).length > 0);
});

test("routing prompt reads generic directory rules and includes only supplied scoped sessions", (t) => {
  const { config, item, session } = fixture(t);
  const prompt = buildRoutingPrompt(config, item, [session]);
  assert.ok(prompt.startsWith("按主题选择会话。"));
  const data = JSON.parse(prompt.slice(prompt.indexOf('{"workspace"')));
  assert.equal(data.workspacePath, config.workspaces.main);
  assert.equal(data.request, item.task.text);
  assert.deepEqual(data.sessions.map((entry) => entry.id), [session.id]);
  assert.equal(data.sessions[0].scope, undefined);
});

test("Codex and Traex worker invocation preserves explicit session, cwd and JSON event output", (t) => {
  const { config } = fixture(t);
  const cwd = config.workspaces.main;
  for (const backend of ["codex", "traex"]) {
    const fresh = buildSessionInvocation(config, backend, cwd, "/tmp/result", null);
    assert.equal(fresh.cwd, cwd);
    assert.equal(fresh.args[0], "exec");
    assert.equal(fresh.args[fresh.args.indexOf("-C") + 1], cwd);
    assert.equal(fresh.args[fresh.args.indexOf("--output-last-message") + 1], "/tmp/result");
    assert.ok(fresh.args.includes("--json"));
    assert.equal(fresh.args.at(-1), "-");
    const resumed = buildSessionInvocation(config, backend, cwd, "/tmp/result", "session-1");
    assert.deepEqual(resumed.args.slice(0, 2), ["exec", "resume"]);
    assert.ok(resumed.args.includes("session-1"));
    assert.ok(!resumed.args.includes("-C"));
    assert.ok(!resumed.args.includes("--last"));
    assert.equal(resumed.cwd, cwd);
    if (backend === "traex") {
      assert.ok(resumed.args.includes('sandbox_mode="workspace-write"'));
      assert.ok(resumed.args.includes('approval_policy="never"'));
    }
    assert.equal(sessionIdFromOutput(fresh, 'noise\n{"type":"thread.started","thread_id":"session-1"}\n'), "session-1");
    assert.equal(sessionIdFromOutput(fresh, '{"type":"thread.started","thread_id":"../bad"}\n'), null);
    assert.equal(sessionIdFromOutput(fresh, '{"type":"item.completed","thread_id":"session-1"}\n'), null);
  }
});

test("Claude worker invocation creates or resumes an explicit session", (t) => {
  const { config } = fixture(t);
  const fresh = buildSessionInvocation(config, "claude", config.workspaces.main, "/tmp/result", null);
  assert.match(fresh.expectedSessionId, /^[a-f0-9-]{36}$/);
  assert.equal(fresh.args[fresh.args.indexOf("--session-id") + 1], fresh.expectedSessionId);
  assert.equal(fresh.args[fresh.args.indexOf("--output-format") + 1], "json");
  const resumed = buildSessionInvocation(config, "claude", config.workspaces.main, "/tmp/result", "session-1");
  assert.equal(resumed.args[resumed.args.indexOf("--resume") + 1], "session-1");
  assert.ok(!resumed.args.includes("--continue"));
});

test("router stage applies read-only sandbox or disables Claude tools and MCP", (t) => {
  const { config } = fixture(t);
  for (const backend of ["codex", "traex"]) {
    const invocation = buildSessionInvocation(config, backend, config.routing.directory, "/tmp/router-result", null, { router: true });
    assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(invocation.cwd, config.routing.directory);
    assert.equal(invocation.args.at(-1), "-");
    assert.ok(!invocation.args.includes("resume"));
    const worker = buildSessionInvocation(config, backend, config.workspaces.main, "/tmp/worker-result", null);
    assert.ok(!worker.args.includes("read-only"));
  }
  const invocation = buildSessionInvocation(config, "claude", config.routing.directory, "/tmp/router-result", null, { router: true });
  assert.equal(invocation.args[invocation.args.indexOf("--tools") + 1], "");
  assert.ok(invocation.args.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(invocation.args[invocation.args.indexOf("--mcp-config") + 1]), { mcpServers: {} });
  assert.ok(invocation.args.includes("--disable-slash-commands"));
  assert.ok(!invocation.args.includes("--resume"));
  assert.ok(!invocation.args.includes("--session-id"));
});

test("Claude session registration requires matching successful backend JSON evidence", (t) => {
  const { config } = fixture(t);
  const invocation = buildSessionInvocation(config, "claude", config.workspaces.main, "/tmp/result", null);
  const result = { session_id: invocation.expectedSessionId, result: "completed", is_error: false };
  assert.equal(sessionIdFromOutput(invocation, JSON.stringify(result)), invocation.expectedSessionId);
  for (const output of ["", "not json", JSON.stringify({ result: "completed" }), JSON.stringify({ ...result, session_id: "foreign" }), JSON.stringify({ ...result, is_error: true })]) {
    assert.equal(sessionIdFromOutput(invocation, output), null);
  }
});
