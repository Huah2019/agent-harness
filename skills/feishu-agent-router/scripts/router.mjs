#!/usr/bin/env node

import { verifyOwner, loadGuests } from "./access.mjs";
import { manageService, serviceInfo } from "./service.mjs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startBridge } from "./bridge.mjs";
import { loadSessions, validateRouting } from "./routing.mjs";
import {
  commandExists,
  ensureRuntimeDirectories,
  hasOption,
  loadConfig,
  normalizeConfig,
  optionValue,
  optionValues,
  parseCommandLine,
  readJsonIfExists,
  resolveDefaultPaths,
  runtimePaths,
  validateConfig,
} from "./router-lib.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const bridgePath = resolve(scriptDir, "bridge.mjs");
const MIN_LARK_CLI_VERSION = [1, 0, 84];

function parseVersion(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function usage() {
  return `Feishu Agent Router

用法:
  node scripts/router.mjs init --sender-id <open_id> --workspace <alias=/abs/path> [options]
  node scripts/router.mjs bind-owner [--config <path>]
  node scripts/router.mjs service-install [--config <path>]
  node scripts/router.mjs service-status [--config <path>]
  node scripts/router.mjs doctor [--config <path>] [--json]
  node scripts/router.mjs start [--config <path>]
  node scripts/router.mjs run [--config <path>]
  node scripts/router.mjs status [--config <path>] [--json]
  node scripts/router.mjs stop [--config <path>]
  node scripts/router.mjs logs [--config <path>]
  node scripts/router.mjs print-config [--config <path>] [--show-identities]

init 选项:
  --sender-id <id>           可选，只能匹配 CLI 当前用户（owner 自动识别）
  --no-autostart             仅创建配置，跳过默认 macOS 登录自动启动
  --workspace <alias=path>   工作区别名和绝对路径，可重复
  --backend <codex|claude|traex> 默认 codex，traex 使用 traex-cli 的 traex 命令
  --router-dir <path>        启用 AI 会话路由，在独立绝对目录生成 AGENTS.md
  --backend-command <command> 覆盖后台命令名或绝对路径；默认从 PATH 查找
  --lark-command <path>      默认 lark-cli
  --lark-profile <name>      可选 lark-cli profile
  --mention-token <text>     群聊中识别 @ 的文本，可重复
  --bot-open-id <open_id>    群聊 mentions 中用于识别机器人的 open_id，可重复
  --state-dir <path>         自定义状态和日志目录
  --force                    覆盖已有配置

默认配置: ${resolveDefaultPaths().configPath}
环境变量 FEISHU_AGENT_ROUTER_CONFIG 可覆盖默认配置路径。`;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function routerIdentity(config, paths) {
  const owner = readJsonIfExists(paths.lockOwnerPath, null, { strict: true });
  const status = readJsonIfExists(paths.statusPath, null, { strict: true });
  const pid = Number(owner?.pid);
  if (
    !Number.isInteger(pid)
    || !owner?.instanceId
    || status?.pid !== pid
    || status?.instanceId !== owner.instanceId
    || !processAlive(pid)
  ) {
    return null;
  }
  if (process.platform !== "win32") {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 3000 });
    const commandLine = String(result.stdout || "");
    const detachedBridge = commandLine.includes(bridgePath);
    const foregroundRouter = commandLine.includes(scriptPath) && /(?:^|\s)run(?:\s|$)/.test(commandLine);
    if (result.status !== 0 || (!detachedBridge && !foregroundRouter) || !commandLine.includes(config.configPath)) {
      return null;
    }
  }
  return { pid, instanceId: owner.instanceId };
}

function removeStaleLock(paths) {
  const owner = readJsonIfExists(paths.lockOwnerPath, null, { strict: true });
  if (!existsSync(paths.lockDir)) return;
  if (owner?.pid && processAlive(Number(owner.pid))) return;
  if (!owner) {
    const ageMs = Date.now() - statSync(paths.lockDir).mtimeMs;
    if (ageMs < 10_000) return;
  }
  if (existsSync(paths.lockOwnerPath)) unlinkSync(paths.lockOwnerPath);
  try {
    rmdirSync(paths.lockDir);
  } catch {
    // Only an empty, exact runtime lock directory is eligible for cleanup.
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function parseWorkspaceOptions(values) {
  const workspaces = {};
  for (const value of values) {
    if (value === true) throw new Error("--workspace 缺少参数");
    const separator = String(value).indexOf("=");
    const alias = separator >= 0 ? String(value).slice(0, separator) : "default";
    const workspacePath = separator >= 0 ? String(value).slice(separator + 1) : String(value);
    if (!alias || !workspacePath) throw new Error(`workspace 格式无效: ${value}`);
    if (!isAbsolute(workspacePath)) throw new Error(`workspace 必须是绝对路径: ${workspacePath}`);
    workspaces[alias] = resolve(workspacePath);
  }
  return workspaces;
}

function createInitialConfig(options, configPath) {
  const senderIds = optionValues(options, "sender-id").map(String).map((value) => value.trim()).filter(Boolean);
  const owner = verifyOwner({ command: String(optionValue(options, "lark-command", "lark-cli")), profile: String(optionValue(options, "lark-profile", "")) }, undefined, { details: true });
  const { ownerId } = owner;
  if (senderIds.length > 1 || (senderIds.length === 1 && senderIds[0] !== ownerId)) throw new Error("--sender-id 只能是飞书 CLI 当前用户；访客须由 owner 在飞书添加并指定到期时间");
  const workspaceValues = optionValues(options, "workspace");
  if (workspaceValues.length === 0) throw new Error("init 至少需要一个 --workspace <alias=/absolute/path>");
  const workspaces = parseWorkspaceOptions(workspaceValues);
  const backendName = String(optionValue(options, "backend", "codex"));
  if (!["codex", "claude", "traex"].includes(backendName)) {
    throw new Error("init 的 --backend 支持 codex、claude 或 traex；generic 请按 reference 编辑配置");
  }
  const backendCommand = String(optionValue(options, "backend-command", backendName));
  const paths = resolveDefaultPaths();
  const rawConfig = {
    version: 1,
    access: owner,
    allowedSenderIds: [ownerId],
    defaultWorkspace: Object.keys(workspaces)[0],
    workspaces,
    activeBackend: backendName,
    backends: {
      [backendName]: backendName !== "claude"
        ? { type: backendName, command: backendCommand, mode: "new", prefixArgs: [] }
        : { type: "claude", command: backendCommand, prefixArgs: [], continue: false, outputFormat: "json" },
    },
    lark: {
      command: String(optionValue(options, "lark-command", "lark-cli")),
      profile: String(optionValue(options, "lark-profile", "")),
    },
    group: {
      requireMention: true,
      mentionTokens: optionValues(options, "mention-token").map(String),
      mentionIds: optionValues(options, "bot-open-id").map(String),
    },
    reply: {
      inThread: true,
      maxChars: 5000,
      maxAttempts: 3,
      commandTimeoutSeconds: 15,
      concurrency: 2,
      pendingLimit: 20,
    },
    safety: { confirmPrefix: "/confirm" },
    runtime: {
      stateDir: resolve(String(optionValue(options, "state-dir", paths.stateDir))),
      queueLimit: 20,
      outboxLimit: 100,
      maxIncomingChars: 20_000,
      taskTimeoutSeconds: 3600,
      startupTimeoutSeconds: 20,
      consumerRestartDelayMs: 3000,
      consumerRestartMaxDelayMs: 60_000,
      consumerStableResetSeconds: 30,
      maxCapturedOutputChars: 1_000_000,
      maxEventAgeSeconds: 86_400,
      dedupeLimit: 10_000,
    },
  };
  if (hasOption(options, "router-dir")) {
    rawConfig.routing = { mode: "agent", directory: optionValue(options, "router-dir") };
  }
  const config = normalizeConfig(rawConfig, configPath);
  const issues = [...validateConfig(config), ...validateRouting(config, { requireDirectory: false })];
  const errors = issues.filter((issue) => issue.level === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
  }
  delete config.configPath;
  return { config, issues };
}

async function runInit(options, configPath) {
  if (existsSync(configPath) && !hasOption(options, "force")) {
    throw new Error(`配置已存在: ${configPath}。如确认覆盖，请增加 --force`);
  }
  const { config, issues } = createInitialConfig(options, configPath);
  if (config.routing?.mode === "agent") {
    const directory = config.routing.directory;
    if (Object.values(config.workspaces).includes(resolve(directory))) throw new Error("路由目录不能与业务工作目录相同");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const rulesPath = resolve(directory, "AGENTS.md");
    if (!existsSync(rulesPath)) writeFileSync(rulesPath, readFileSync(resolve(scriptDir, "../assets/router-AGENTS.md")), { flag: "wx", mode: 0o600 });
    const errors = validateRouting(config).filter((issue) => issue.level === "error");
    if (errors.length) throw new Error(errors.map((issue) => issue.message).join("\n"));
    process.stdout.write(`路由规则（已有文件保留）: ${rulesPath}\n`);
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(configPath, 0o600);
  process.stdout.write(`已创建配置: ${configPath}\n`);
  for (const issue of issues) {
    if (issue.level === "warning") process.stdout.write(`[WARN] ${issue.message}\n`);
  }
  if (!hasOption(options, "no-autostart")) await installService(configPath);
  else process.stdout.write(`已跳过自动启动；下一步运行 doctor 和 start。\n`);
}

function collectDoctorResults(config) {
  const results = [];
  const add = (level, code, message) => results.push({ level, code, message });
  try {
    verifyOwner(config.lark, config.access.ownerId || "__missing_owner__");
    loadGuests(config);
    add("pass", "owner_verified", "唯一 owner 已与飞书 CLI 用户身份核对，访客权限文件有效");
  } catch (error) { add("error", "owner_verification", error.message); }
  add("pass", "config_loaded", `配置可读取: ${config.configPath}`);
  for (const issue of [...validateConfig(config), ...validateRouting(config)]) add(issue.level, issue.code, issue.message);
  if (config.routing?.mode === "agent") {
    try {
      loadSessions(config);
      add("pass", "routing_sessions", "会话账本可读取；按用户、聊天、工作区和后台隔离");
    } catch (error) { add("error", "routing_sessions_corrupt", error.message); }
  }

  if (process.platform !== "win32") {
    const mode = statSync(config.configPath).mode & 0o777;
    if ((mode & 0o077) !== 0) add("warning", "config_permissions", `配置权限为 ${mode.toString(8)}，建议 chmod 600`);
    else add("pass", "config_permissions", "配置文件权限未向 group/other 开放");
  }
  if (commandExists(config.lark.command)) add("pass", "lark_command", `找到 lark-cli: ${config.lark.command}`);
  else add("error", "lark_command_missing", `找不到 lark-cli: ${config.lark.command}`);

  if (commandExists(config.lark.command)) {
    const versionResult = spawnSync(config.lark.command, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    const version = parseVersion(`${versionResult.stdout || ""}\n${versionResult.stderr || ""}`);
    if (versionResult.status !== 0 || !version) {
      add("error", "lark_version_unknown", "无法读取 lark-cli 版本，Router 不能确认 event/reply 契约");
    } else if (!versionAtLeast(version, MIN_LARK_CLI_VERSION)) {
      add("error", "lark_version_too_old", `lark-cli ${version.join(".")} 低于已验证最低版本 ${MIN_LARK_CLI_VERSION.join(".")}`);
    } else {
      add("pass", "lark_version", `lark-cli ${version.join(".")} 满足最低版本 ${MIN_LARK_CLI_VERSION.join(".")}`);
    }
    const schemaArgs = config.lark.profile
      ? ["--profile", config.lark.profile, "event", "schema", "im.message.receive_v1", "--json"]
      : ["event", "schema", "im.message.receive_v1", "--json"];
    const schemaResult = spawnSync(config.lark.command, schemaArgs, {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    if (schemaResult.status === 0) {
      try {
        const schema = JSON.parse(schemaResult.stdout);
        const scopes = Array.isArray(schema.scopes) ? schema.scopes.join(", ") : "unknown";
        add("pass", "lark_event_schema", `事件 im.message.receive_v1 可用，schema scopes: ${scopes}`);
      } catch {
        add("error", "lark_event_schema_invalid", "lark-cli event schema 返回了无法解析的 JSON");
      }
    } else {
      add("error", "lark_event_schema_failed", `无法读取 im.message.receive_v1 schema: ${String(schemaResult.stderr || "").trim().slice(-500)}`);
    }
  }

  for (const [name, backend] of Object.entries(config.backends)) {
    if (commandExists(backend.command)) add("pass", `backend_${name}`, `找到后台 ${name}: ${backend.command}`);
    else {
      const level = name === config.activeBackend ? "error" : "warning";
      add(level, `backend_${name}_missing`, `找不到后台 ${name}: ${backend.command}`);
    }
    if (backend.envAllowlist.length > 0) {
      add("pass", `backend_${name}_env`, `后台 ${name} 显式透传环境变量名: ${backend.envAllowlist.join(", ")}`);
      const sensitiveNames = backend.envAllowlist.filter((variableName) => /TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|PRIVATE|LARK|FEISHU/i.test(variableName));
      if (sensitiveNames.length > 0) {
        add("warning", `backend_${name}_sensitive_env`, `后台 ${name} 显式透传了敏感变量名: ${sensitiveNames.join(", ")}`);
      }
    } else {
      add("pass", `backend_${name}_env`, `后台 ${name} 仅继承 Router 的最小基础环境，不继承飞书或其他凭据变量`);
    }
  }
  const paths = runtimePaths(config);
  for (const [name, filePath] of [
    ["queue", paths.queuePath],
    ["dedupe", paths.dedupePath],
    ["selection", paths.selectionPath],
    ["status", paths.statusPath],
    ["lock_owner", paths.lockOwnerPath],
  ]) {
    if (!existsSync(filePath)) continue;
    try {
      readJsonIfExists(filePath, null, { strict: true });
      add("pass", `runtime_${name}`, `运行状态文件可解析: ${filePath}`);
    } catch (error) {
      add("error", `runtime_${name}_corrupt`, error.message);
    }
  }
  add("warning", "live_roundtrip_pending", "doctor 不会消费事件或发送消息；启动后仍需用飞书 /ping 验证 bot scope 和真实回复");
  return results;
}

function printDoctor(results, jsonOutput) {
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify({ ok: !results.some((item) => item.level === "error"), results }, null, 2)}\n`);
    return;
  }
  const labels = { pass: "PASS", warning: "WARN", error: "FAIL" };
  for (const item of results) process.stdout.write(`[${labels[item.level]}] ${item.message}\n`);
}

function runDoctor(configPath, options) {
  const config = loadConfig(configPath);
  const results = collectDoctorResults(config);
  printDoctor(results, hasOption(options, "json"));
  return results.some((item) => item.level === "error") ? 1 : 0;
}

async function runStart(configPath) {
  const config = loadConfig(configPath);
  const doctorResults = collectDoctorResults(config);
  const errors = doctorResults.filter((item) => item.level === "error");
  if (errors.length > 0) {
    printDoctor(doctorResults, false);
    throw new Error("doctor 存在失败项，Router 未启动");
  }
  const paths = ensureRuntimeDirectories(config);
  const existing = routerIdentity(config, paths);
  if (existing) {
    process.stdout.write(`Router 已在运行，pid=${existing.pid}\n`);
    return;
  }
  if (process.platform === "darwin" && serviceInfo(config, scriptPath).installed) {
    manageService(config, scriptPath, "start");
    await waitService(config);
    return;
  }
  removeStaleLock(paths);
  if (existsSync(paths.pidPath)) unlinkSync(paths.pidPath);
  const stdoutFd = openSync(paths.stdoutPath, "a", 0o600);
  const stderrFd = openSync(paths.stderrPath, "a", 0o600);
  if (process.platform !== "win32") {
    chmodSync(paths.stdoutPath, 0o600);
    chmodSync(paths.stderrPath, 0o600);
  }
  const instanceId = randomUUID();
  const child = spawn(process.execPath, [bridgePath, "--config", config.configPath], {
    cwd: config.runtime.stateDir,
    detached: true,
    env: {
      ...process.env,
      FEISHU_AGENT_ROUTER_CONFIG: config.configPath,
      FEISHU_AGENT_ROUTER_INSTANCE_ID: instanceId,
    },
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  child.unref();
  closeSync(stdoutFd);
  closeSync(stderrFd);
  let snapshot = null;
  const startupAttempts = config.runtime.startupTimeoutSeconds * 10;
  for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
    if (!processAlive(child.pid)) break;
    snapshot = readJsonIfExists(paths.statusPath, null);
    if (snapshot?.pid === child.pid && snapshot.instanceId === instanceId && snapshot.consumer === "ready") break;
    await sleep(100);
  }
  if (
    !processAlive(child.pid)
    || snapshot?.pid !== child.pid
    || snapshot?.instanceId !== instanceId
    || snapshot.consumer !== "ready"
  ) {
    if (processAlive(child.pid)) process.kill(child.pid, "SIGTERM");
    for (let attempt = 0; attempt < 80 && processAlive(child.pid); attempt += 1) await sleep(100);
    const detail = snapshot?.lastConsumerError?.message || `事件消费者未在超时内 ready`;
    const cleanup = processAlive(child.pid) ? `；pid=${child.pid} 仍在清理，未使用 SIGKILL` : "";
    throw new Error(`Router 启动失败：${detail}${cleanup}。请查看 ${paths.stderrPath}`);
  }
  process.stdout.write(`Router 已启动，pid=${child.pid}\n`);
  process.stdout.write(`状态: node ${scriptPath} status --config ${config.configPath}\n`);
  process.stdout.write(`下一步请在飞书向机器人发送 /ping 做真实回环验证。\n`);
}

function statusSnapshot(config) {
  const paths = runtimePaths(config);
  const identity = routerIdentity(config, paths);
  return {
    running: Boolean(identity),
    pid: identity?.pid || null,
    instanceId: identity?.instanceId || null,
    configPath: config.configPath,
    stateDir: config.runtime.stateDir,
    status: readJsonIfExists(paths.statusPath, null, { strict: true }),
    logs: {
      stdout: paths.stdoutPath,
      stderr: paths.stderrPath,
      bridge: paths.bridgeLogPath,
    },
  };
}

function runStatus(configPath, options) {
  const config = loadConfig(configPath);
  const snapshot = statusSnapshot(config);
  if (hasOption(options, "json")) {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  } else {
    process.stdout.write(`运行状态: ${snapshot.running ? "running" : "stopped"}\n`);
    if (snapshot.pid) process.stdout.write(`PID: ${snapshot.pid}\n`);
    if (snapshot.status) {
      process.stdout.write(`事件消费者: ${snapshot.status.consumer}\n`);
      process.stdout.write(`后台: ${snapshot.status.running?.backend || snapshot.status.defaultBackend}\n`);
      process.stdout.write(`工作区: ${snapshot.status.running?.workspace || snapshot.status.defaultWorkspace}\n`);
      process.stdout.write(`队列: ${snapshot.status.queueLength}\n`);
    }
    process.stdout.write(`日志: ${snapshot.logs.bridge}\n`);
  }
  return snapshot.running ? 0 : 1;
}

async function runStop(configPath) {
  const config = loadConfig(configPath);
  const paths = runtimePaths(config);
  const identity = routerIdentity(config, paths);
  if (!identity) {
    if (process.platform === "darwin" && serviceInfo(config, scriptPath).installed) manageService(config, scriptPath, "stop");
    process.stdout.write("没有找到身份可验证的 Router 进程；未发送信号。\n");
    return;
  }
  const { pid } = identity;
  if (process.platform === "darwin" && serviceInfo(config, scriptPath).installed) manageService(config, scriptPath, "stop");
  else process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 100 && routerIdentity(config, paths); attempt += 1) await sleep(100);
  if (routerIdentity(config, paths)) {
    throw new Error(`Router pid=${pid} 未在超时内退出。为避免泄漏飞书事件订阅，未使用 SIGKILL；请检查日志并用 lark-cli event status/stop 处理消费者`);
  }
  if (existsSync(paths.pidPath)) unlinkSync(paths.pidPath);
  process.stdout.write(`Router 已停止，pid=${pid}\n`);
}

function runLogs(configPath) {
  const config = loadConfig(configPath);
  const paths = runtimePaths(config);
  process.stdout.write(`Bridge 日志: ${paths.bridgeLogPath}\n`);
  process.stdout.write(`Daemon stdout: ${paths.stdoutPath}\n`);
  process.stdout.write(`Daemon stderr: ${paths.stderrPath}\n`);
  process.stdout.write(`任务日志目录: ${paths.runsDir}\n`);
}

function runPrintConfig(configPath, options) {
  const config = loadConfig(configPath);
  delete config.configPath;
  if (!hasOption(options, "show-identities")) {
    config.access.ownerId = "[redacted]";
    config.access.ownerLabel = "[redacted]";
    config.allowedSenderIds = config.allowedSenderIds.map((id) => `${id.slice(0, 5)}***${id.slice(-4)}`);
  }
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

async function waitService(config) {
  for (let i = 0; i < config.runtime.startupTimeoutSeconds * 10; i++) {
    const snapshot = statusSnapshot(config);
    if (snapshot.running && snapshot.status?.consumer === "ready") {
      process.stdout.write("服务已启动，事件消费者 ready；已启用 macOS 登录后自动启动。请在飞书发送 /ping 验证真实回环。\n");
      return;
    }
    await sleep(100);
  }
  throw new Error("自动启动服务已安装，但消费者尚未 ready；请查看日志，不能视为接通成功");
}
async function installService(configPath) {
  const config = loadConfig(configPath);
  const errors = collectDoctorResults(config).filter(item => item.level === "error");
  if (errors.length) throw new Error(errors.map(item => item.message).join("\n"));
  const info = serviceInfo(config, scriptPath);
  if (statusSnapshot(config).running && !info.loaded) throw new Error("已有非 launchd 管理的 Router，请先 stop 再 service-install");
  ensureRuntimeDirectories(config);
  manageService(config, scriptPath, "install");
  await waitService(config);
}

async function main() {
  const { positional, options } = parseCommandLine(process.argv.slice(2));
  const command = positional[0];
  const configPath = resolve(String(optionValue(options, "config", resolveDefaultPaths().configPath)));
  if (!command || ["help", "-h", "--help"].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (command === "init") {
    await runInit(options, configPath);
    return 0;
  }
  if (command === "bind-owner") {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    const config = loadConfig(configPath);
    const owner = verifyOwner(config.lark, undefined, { details: true });
    const { ownerId } = owner;
    if (config.access.ownerId && config.access.ownerId !== ownerId) throw new Error("已有 owner 不匹配；拒绝自动更换身份");
    raw.access = owner;
    raw.allowedSenderIds = [ownerId];
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    chmodSync(configPath, 0o600);
    process.stdout.write("已绑定 CLI 用户为唯一 owner；旧的其他允许用户未授予访客权限。\n");
    return 0;
  }
  if (command === "service-install") { await installService(configPath); return 0; }
  if (command === "service-status") { process.stdout.write(JSON.stringify(serviceInfo(loadConfig(configPath), scriptPath)) + "\n"); return 0; }
  if (command === "doctor") return runDoctor(configPath, options);
  if (command === "start") {
    await runStart(configPath);
    return 0;
  }
  if (command === "run") {
    await startBridge(configPath);
    return 0;
  }
  if (command === "status") return runStatus(configPath, options);
  if (command === "stop") {
    await runStop(configPath);
    return 0;
  }
  if (command === "logs") {
    runLogs(configPath);
    return 0;
  }
  if (command === "print-config") {
    runPrintConfig(configPath, options);
    return 0;
  }
  throw new Error(`未知命令: ${command}\n\n${usage()}`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
