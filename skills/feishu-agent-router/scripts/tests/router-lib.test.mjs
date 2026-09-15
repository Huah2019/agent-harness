import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EventDedupe,
  buildAgentPrompt,
  buildBackendEnvironment,
  buildBackendInvocation,
  commandExists,
  controlHelp,
  extractIncomingText,
  loadSelection,
  normalizeConfig,
  normalizeIncomingEvent,
  parseControlCommand,
  parseReplyResult,
  saveSelection,
  shouldAcceptMessage,
  stripMentionTokens,
  validateConfig,
} from "../router-lib.mjs";

function withTemporaryDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "feishu-agent-router-test-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function testConfig(workspacePath, stateDir = join(workspacePath, "state")) {
  return normalizeConfig({
    version: 1,
    allowedSenderIds: ["ou_allowed"],
    defaultWorkspace: "main",
    workspaces: { main: workspacePath },
    activeBackend: "codex",
    backends: {
      codex: { type: "codex", command: "codex", mode: "new" },
      claude: { type: "claude", command: "aiden", prefixArgs: ["x", "claude"], continue: false },
    },
    group: { requireMention: true, mentionTokens: ["@router"] },
    runtime: { stateDir },
  }, join(workspacePath, "config.json"));
}

test("help reflects sender selection and real paths without dumping credentials or backend arguments", () => withTemporaryDirectory((directory) => {
  const config = testConfig(directory);
  config.workspaces.other = join(directory, "other");
  config.routing = { mode: "agent", directory: join(directory, "entry") };
  config.backends.claude.prefixArgs.push("SECRET_ARGUMENT_SENTINEL");
  config.lark.appSecret = "SECRET_VALUE_SENTINEL";
  const help = controlHelp({ backend: "claude", workspace: "other" }, config);
  assert.ok(help.includes(`实际工作目录: ${config.workspaces.other}`));
  assert.ok(help.includes(`路由目录: ${config.routing.directory}`));
  assert.ok(help.includes(`配置文件: ${config.configPath}`));
  assert.ok(help.includes(`日志目录: ${join(config.runtime.stateDir, "logs")}`));
  assert.ok(help.includes("后台: claude"));
  assert.ok(!help.includes("SECRET_"));
  assert.ok(!help.includes(config.access.ownerId));
  delete config.routing;
  assert.ok(controlHelp({ backend: "codex", workspace: "main" }, config).includes("未启用独立路由目录"));
}));

test("valid shared config has no errors and warns when all mention matchers are absent", () => withTemporaryDirectory((directory) => {
  const config = testConfig(directory);
  assert.deepEqual(validateConfig(config).filter((issue) => issue.level === "error"), []);

  config.group.mentionTokens = [];
  assert.ok(validateConfig(config).some((issue) => issue.code === "empty_mention_matchers"));
}));

test("config rejects missing workspace and unsafe resume setup", () => withTemporaryDirectory((directory) => {
  const config = testConfig(directory);
  config.defaultWorkspace = "missing";
  config.backends.codex.mode = "resume";
  const issueCodes = validateConfig(config).map((issue) => issue.code);
  assert.ok(issueCodes.includes("missing_default_workspace"));
  assert.ok(issueCodes.includes("missing_codex_session"));
}));

test("session reuse is rejected across multiple workspaces even for one sender", () => withTemporaryDirectory((directory) => {
  const config = testConfig(directory);
  config.workspaces.secondary = directory;
  config.backends.codex.mode = "resume";
  config.backends.codex.sessionId = "fixed-session";
  config.backends.claude.continue = true;
  const issueCodes = validateConfig(config).map((issue) => issue.code);
  assert.ok(issueCodes.includes("shared_codex_session"));
  assert.ok(issueCodes.includes("shared_claude_session"));
}));

test("control commands only select configured aliases later in the bridge", () => withTemporaryDirectory((directory) => {
  const config = testConfig(directory);
  assert.deepEqual(parseControlCommand("/backend list", config), { kind: "backend-list" });
  assert.deepEqual(parseControlCommand("/workspace service-b", config), { kind: "workspace-switch", target: "service-b" });
  assert.deepEqual(parseControlCommand("/confirm git push origin feat-x", config), {
    kind: "task",
    text: "git push origin feat-x",
    confirmed: true,
  });
  assert.deepEqual(parseControlCommand("/confirm\n保留  两个空格\n和换行", config), {
    kind: "task",
    text: "保留  两个空格\n和换行",
    confirmed: true,
  });
  assert.deepEqual(parseControlCommand("git push origin feat-x", config), {
    kind: "task",
    text: "git push origin feat-x",
    confirmed: false,
  });
}));

test("sender, mention and persistent event dedupe are enforced", () => withTemporaryDirectory((directory) => {
  const config = testConfig(directory);
  const dedupePath = join(directory, "dedupe.json");
  const dedupe = new EventDedupe(dedupePath, 10);
  const message = normalizeIncomingEvent({
    event_id: "evt-1",
    sender_id: "ou_allowed",
    sender_type: "user",
    chat_id: "chat-1",
    chat_type: "group",
    message_id: "om_msg_1",
    message_type: "text",
    text: "@router status",
    create_time: String(Date.now()),
  });
  assert.deepEqual(shouldAcceptMessage(message, config, dedupe), { ok: true, dedupeId: "om_msg_1" });
  dedupe.add("om_msg_1");
  assert.equal(shouldAcceptMessage(message, config, dedupe).reason, "duplicate_event");
  assert.equal(shouldAcceptMessage({ ...message, eventId: "evt-2", senderId: "ou_other" }, config, dedupe).reason, "sender_not_allowed");
  assert.equal(shouldAcceptMessage({ ...message, eventId: "evt-bot", messageId: "msg-bot", senderType: "app" }, config, dedupe).reason, "sender_not_user");
  assert.equal(shouldAcceptMessage({ ...message, eventId: "evt-3", messageId: "om_msg_3", text: "status" }, config, dedupe).reason, "group_mention_missing");

  const reloaded = new EventDedupe(dedupePath, 10);
  assert.equal(reloaded.has("om_msg_1"), true);
  assert.equal(stripMentionTokens(message.text, config.group.mentionTokens), "status");
}));

test("dedupe uses a TTL and fails closed at capacity instead of evicting protected ids", () => withTemporaryDirectory((directory) => {
  const dedupe = new EventDedupe(join(directory, "dedupe.json"), 3, 3600);
  dedupe.add("om_1");
  dedupe.add("om_2");
  dedupe.add("om_3");
  assert.equal(dedupe.canAdd("om_4"), false);
  assert.throws(() => dedupe.add("om_4"), /容量已满/);
  assert.equal(dedupe.has("om_1"), true);

  const expiring = new EventDedupe(join(directory, "expiring.json"), 3, 1);
  expiring.add("om_old", Date.now() - 2000);
  assert.equal(expiring.has("om_old"), false);
  assert.equal(expiring.canAdd("om_new"), true);
}));

test("event content stays plain text even when it looks like JSON", () => {
  const content = '{"action":"keep-as-user-text"}';
  assert.equal(extractIncomingText({ content }), content);
  assert.equal(extractIncomingText({ content: {
    content: [
      [{ tag: "text", text: "第一行" }],
      [{ tag: "text", text: "第二行" }],
    ],
  } }), "第一行\n第二行");
});

test("backend invocation keeps workspace and CLI adapter arguments explicit", () => withTemporaryDirectory((directory) => {
  const config = testConfig(directory);
  assert.deepEqual(buildBackendInvocation(config, "codex", directory, "/tmp/out.md"), {
    command: "codex",
    args: ["exec", "-C", directory, "--skip-git-repo-check", "--output-last-message", "/tmp/out.md", "-"],
    cwd: directory,
    outputMode: "file",
  });
  assert.deepEqual(buildBackendInvocation(config, "claude", directory, "/tmp/out.md"), {
    command: "aiden",
    args: ["x", "claude", "--print", "--output-format", "json"],
    cwd: directory,
    outputMode: "json-result",
  });
}));

test("backend environment does not inherit Router credentials unless explicitly named", () => {
  const sourceEnv = {
    PATH: "/bin",
    HOME: "/Users/example",
    LARK_APP_SECRET: "must-not-leak",
    OPENAI_API_KEY: "explicit-key",
  };
  assert.deepEqual(buildBackendEnvironment({ envAllowlist: [] }, sourceEnv), {
    PATH: "/bin",
    HOME: "/Users/example",
  });
  assert.deepEqual(buildBackendEnvironment({ envAllowlist: ["OPENAI_API_KEY"] }, sourceEnv), {
    PATH: "/bin",
    HOME: "/Users/example",
    OPENAI_API_KEY: "explicit-key",
  });
});

test("workspace and backend selections are isolated per allowed sender", () => withTemporaryDirectory((directory) => {
  const config = testConfig(directory);
  config.allowedSenderIds = ["ou_alice", "ou_bob"];
  config.workspaces.secondary = directory;
  saveSelection(config, "ou_alice", { backend: "claude", workspace: "secondary" });
  assert.deepEqual(loadSelection(config, "ou_alice"), { backend: "claude", workspace: "secondary" });
  assert.deepEqual(loadSelection(config, "ou_bob"), { backend: "codex", workspace: "main" });
}));

test("agent prompt distinguishes ordinary requests from explicit confirmation", () => withTemporaryDirectory((directory) => {
  const prompt = buildAgentPrompt({
    message: { senderId: "ou_allowed", chatId: "chat", chatType: "p2p", messageId: "msg" },
    userText: "部署服务",
    workspaceAlias: "main",
    workspacePath: directory,
    backendName: "codex",
    confirmed: false,
  });
  assert.match(prompt, /"explicit_confirmation": false/);
  assert.match(prompt, /普通消息不构成 git push、部署、删除/);
  assert.match(prompt, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}));

test("lark reply is successful only when ok and a persisted message id are present", () => {
  assert.deepEqual(parseReplyResult(1, ""), { ok: false, reason: "exit_code_1" });
  assert.deepEqual(parseReplyResult(0, "not-json"), { ok: false, reason: "invalid_json" });
  assert.equal(parseReplyResult(0, '{"ok":true,"data":{}}').reason, "missing_message_id");
  assert.equal(
    parseReplyResult(0, '{"ok":true,"data":{"message":{"message_id":"om_reply"}}}').messageId,
    "om_reply",
  );
  assert.equal(parseReplyResult(0, '{"ok":true,"message_id":"om_root"}').messageId, "om_root");
  assert.equal(parseReplyResult(0, '{"ok":true,"message_id":"not-a-message"}').reason, "invalid_message_id");
});

test("relative paths and unsafe remote permission flags are rejected before normalization", () => withTemporaryDirectory((directory) => {
  const config = normalizeConfig({
    version: 1,
    allowedSenderIds: ["ou_one", "ou_two"],
    defaultWorkspace: "main",
    workspaces: { main: "relative/project" },
    activeBackend: "claude",
    backends: {
      claude: {
        type: "claude",
        command: "claude",
        prefixArgs: ["--permission-mode", "bypassPermissions"],
        continue: true,
      },
    },
    group: { requireMention: false },
    runtime: { stateDir: "relative/state" },
  }, join(directory, "config.json"));
  const issueCodes = validateConfig(config, { checkFileSystem: false }).map((issue) => issue.code);
  assert.ok(issueCodes.includes("workspace_not_absolute"));
  assert.ok(issueCodes.includes("state_dir_not_absolute"));
  assert.ok(issueCodes.includes("unsafe_permission_mode"));
  assert.ok(issueCodes.includes("shared_claude_session"));

  config.backends.claude.permissionMode = undefined;
  config.backends.claude.prefixArgs = ["--dangerously-skip-permissions=true"];
  assert.ok(validateConfig(config, { checkFileSystem: false }).some((issue) => issue.code === "unsafe_permission_mode"));
  config.backends.claude.prefixArgs = ["--sandbox=danger-full-access"];
  assert.ok(validateConfig(config, { checkFileSystem: false }).some((issue) => issue.code === "unsafe_permission_mode"));
}));

test("malformed config fields are diagnosed and executable directories are rejected", () => withTemporaryDirectory((directory) => {
  assert.throws(() => normalizeConfig(null), /配置根节点必须是 JSON object/);
  const config = normalizeConfig({
    version: 1,
    allowedSenderIds: ["ou_allowed"],
    defaultWorkspace: "main",
    workspaces: { main: directory },
    activeBackend: "codex",
    backends: { codex: { type: "codex", command: process.execPath } },
    lark: { command: 123 },
    group: { requireMention: false },
    runtime: { stateDir: join(directory, "state") },
  }, join(directory, "config.json"));
  assert.ok(validateConfig(config).some((issue) => issue.code === "invalid_lark_command"));
  assert.equal(commandExists(directory), false);
}));

test("traex adapter uses exec output files and explicit workspace, permission and session flags", () => withTemporaryDirectory((directory) => {
  const config = testConfig(directory);
  config.backends.traex = { type: "traex", command: "traex", mode: "new", model: "test-model" };
  assert.deepEqual(buildBackendInvocation(config, "traex", directory, "/tmp/out.md"), {
    command: "traex",
    args: ["exec", "-c", 'permission_mode="custom"', "-c", 'approval_policy="never"', "-c", 'sandbox_mode="workspace-write"', "--model", "test-model", "-C", directory, "--skip-git-repo-check", "--output-last-message", "/tmp/out.md", "-"],
    cwd: directory,
    outputMode: "file",
  });
  config.backends.traex.mode = "resume";
  config.backends.traex.sessionId = "test-session";
  config.backends.traex.permissionMode = "plan";
  assert.deepEqual(buildBackendInvocation(config, "traex", directory, "/tmp/out.md").args,
    ["exec", "resume", "--permission-mode", "plan", "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"', "--model", "test-model", "--output-last-message", "/tmp/out.md", "--skip-git-repo-check", "test-session", "-"]);
}));

test("traex validates mode, session isolation and permission bypass spellings", () => withTemporaryDirectory((directory) => {
  const config = testConfig(directory);
  config.backends.traex = { type: "traex", command: "traex", prefixArgs: [], envAllowlist: [], mode: "new" };
  const codes = () => validateConfig(config).filter((issue) => issue.level === "error").map((issue) => issue.code);
  assert.deepEqual(codes(), []);
  config.backends.traex.permissionMode = "auto";
  assert.ok(codes().includes("invalid_traex_permission_mode"));
  delete config.backends.traex.permissionMode;
  config.backends.traex.mode = "continue";
  assert.ok(codes().includes("invalid_backend_mode"));
  config.backends.traex.mode = "resume";
  assert.ok(codes().includes("missing_traex_session"));
  config.backends.traex.sessionId = "--last";
  assert.ok(codes().includes("missing_traex_session"));
  config.backends.traex.sessionId = "test-session";
  assert.deepEqual(codes(), []);
  config.allowedSenderIds.push("ou_second");
  assert.ok(codes().includes("shared_traex_session"));
  config.allowedSenderIds.pop();
  config.backends.traex.permissionMode = "bypass_permissions";
  assert.ok(codes().includes("unsafe_permission_mode"));
  delete config.backends.traex.permissionMode;
  for (const args of [["--permission-mode", "bypass_permissions"], ["--permission-mode=bypass_permissions"], ["-y"], ["--sandbox", "danger-full-access"]]) {
    config.backends.traex.prefixArgs = args;
    assert.ok(codes().includes("unsafe_permission_mode"), JSON.stringify(args));
  }
}));

test("normalization infers traex adapter and preserves routing configuration independently", () => withTemporaryDirectory((directory) => {
  const raw = {
    allowedSenderIds: ["ou_allowed"],
    workspaces: { main: directory },
    defaultWorkspace: "main",
    activeBackend: "traex",
    backends: { traex: { mode: "new" } },
    routing: { enabled: true, directory: "/tmp/router", options: { custom: true } },
  };
  const config = normalizeConfig(raw, join(directory, "config.json"));
  assert.equal(config.backends.traex.type, "traex");
  assert.equal(config.backends.traex.command, "traex");
  assert.deepEqual(config.routing, raw.routing);
  config.routing.options.custom = false;
  assert.equal(raw.routing.options.custom, true);
}));

 test("backend aliases default to adapter commands and preserve explicit overrides", () => withTemporaryDirectory((directory) => {
  for (const type of ["codex", "claude", "traex"]) {
    for (const command of [undefined, `/opt/custom/${type}`]) {
      const config = normalizeConfig({ backends: { custom: { type, ...(command ? { command } : {}) } } }, join(directory, "config.json"));
      assert.equal(config.backends.custom.command, command || type);
    }
  }
}));
