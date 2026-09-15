import { verifyOwner, loadGuests, accessRole, commandAllowed, changeGuest, guestHelp } from "./access.mjs";

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createWriteStream,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  buildRoutingPrompt, buildSessionInvocation, loadSessions, parseRoutingDecision,
  routingScope, saveSessions, sessionIdFromOutput, validateRouting,
} from "./routing.mjs";

import {
  EventDedupe,
  buildAgentPrompt,
  buildBackendEnvironment,
  buildBackendInvocation,
  controlHelp,
  ensureRuntimeDirectories,
  loadConfig,
  loadSelection,
  normalizeIncomingEvent,
  parseControlCommand,
  parseReplyResult,
  readJsonIfExists,
  readFinalText,
  saveSelection,
  shouldAcceptMessage,
  stripMentionTokens,
  truncateReply,
  validateConfig,
  writeJsonAtomic,
} from "./router-lib.mjs";

function appendCaptured(current, chunk, limit) {
  const combined = `${current}${chunk.toString()}`;
  return combined.length <= limit ? combined : combined.slice(-limit);
}

function stableIdempotencyKey(messageId, purpose) {
  return createHash("sha256").update(`${messageId}:${purpose}`).digest("hex").slice(0, 32);
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

function processGroupAlive(processGroupId) {
  if (process.platform === "win32" || !Number.isInteger(processGroupId)) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateChildTree(child, signal, processGroupId = child?.pid) {
  if (process.platform !== "win32" && Number.isInteger(processGroupId)) {
    try {
      process.kill(-processGroupId, signal);
      return;
    } catch {
      // Fall back to the direct process if the process group no longer exists.
    }
  }
  if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function waitForProcessGroupExit(processGroupId, timeoutMs) {
  if (process.platform === "win32" || !Number.isInteger(processGroupId)) return Promise.resolve(true);
  if (!processGroupAlive(processGroupId)) return Promise.resolve(true);
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    const poll = () => {
      if (!processGroupAlive(processGroupId)) resolveResult(true);
      else if (Date.now() - startedAt >= timeoutMs) resolveResult(false);
      else setTimeout(poll, 50);
    };
    poll();
  });
}

function acquireRuntimeLock(paths, instanceId) {
  const createLock = () => {
    mkdirSync(paths.lockDir, { mode: 0o700 });
    writeJsonAtomic(paths.lockOwnerPath, { pid: process.pid, instanceId, createdAt: new Date().toISOString() });
  };
  try {
    createLock();
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const owner = readJsonIfExists(paths.lockOwnerPath, null);
  if (owner?.pid && processAlive(Number(owner.pid))) {
    throw new Error(`Router lock 已被 pid=${owner.pid} 持有`);
  }
  const lockAgeMs = Date.now() - statSync(paths.lockDir).mtimeMs;
  if (!owner && lockAgeMs < 10_000) {
    throw new Error("Router lock 正在初始化，请稍后重试");
  }
  if (existsSync(paths.lockOwnerPath)) unlinkSync(paths.lockOwnerPath);
  rmdirSync(paths.lockDir);
  createLock();
}

function releaseRuntimeLock(paths, instanceId) {
  const owner = readJsonIfExists(paths.lockOwnerPath, null);
  if (owner?.instanceId !== instanceId) return;
  if (existsSync(paths.lockOwnerPath)) unlinkSync(paths.lockOwnerPath);
  try {
    rmdirSync(paths.lockDir);
  } catch {
    // A concurrent diagnostic may have already removed an empty stale lock.
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onClose);
      resolveResult(exited);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
    child.once("error", onClose);
  });
}

export async function startBridge(configPath) {
  const config = loadConfig(configPath);
  const configErrors = [...validateConfig(config), ...validateRouting(config)].filter((issue) => issue.level === "error");
  if (configErrors.length > 0) {
    throw new Error(configErrors.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
  }
  if (!config.access.ownerId) throw new Error("缺少唯一 owner，请运行 bind-owner");
  Object.assign(config.access, verifyOwner(config.lark, config.access.ownerId, { details: true }));
  config.access.guests = loadGuests(config);
  const paths = ensureRuntimeDirectories(config);
  if (config.routing?.mode === "agent") loadSessions(config);
  const savedQueue = readJsonIfExists(paths.queuePath, { items: [] }, { strict: true });
  if (!savedQueue || typeof savedQueue !== "object" || !Array.isArray(savedQueue.items)) {
    throw new Error(`queue 状态格式无效，已保留原文件: ${paths.queuePath}`);
  }
  readJsonIfExists(paths.dedupePath, { entries: [] }, { strict: true });
  for (const senderId of config.allowedSenderIds) loadSelection(config, senderId);
  const instanceId = process.env.FEISHU_AGENT_ROUTER_INSTANCE_ID || randomUUID();
  acquireRuntimeLock(paths, instanceId);
  let dedupe;
  const queue = savedQueue.items;
  try {
    writeFileSync(paths.pidPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    dedupe = new EventDedupe(
      paths.dedupePath,
      config.runtime.dedupeLimit,
      config.runtime.maxEventAgeSeconds,
    );
    for (const item of queue) {
      if (
        !item
        || typeof item !== "object"
        || !item.message?.messageId
        || !item.jobId
        || !["queued", "running", "reply_pending"].includes(item.phase)
      ) {
        throw new Error(`queue item 格式无效，已保留原文件: ${paths.queuePath}`);
      }
      dedupe.add(item.message.messageId);
      if (item.phase === "reply_pending") item.nextAttemptAt = 0;
      if (item.phase === "running") {
        item.phase = "reply_pending";
        item.finalText = "Router 上次在任务执行过程中退出，执行结果不确定。为避免重复执行，本次没有自动重跑。请检查本机任务日志后重新发送明确请求。";
        item.nextAttemptAt = 0;
      }
    }
  } catch (error) {
    if (existsSync(paths.pidPath)) unlinkSync(paths.pidPath);
    releaseRuntimeLock(paths, instanceId);
    throw error;
  }

  if (process.platform !== "win32" && existsSync(paths.bridgeLogPath)) chmodSync(paths.bridgeLogPath, 0o600);
  const bridgeLog = createWriteStream(paths.bridgeLogPath, { flags: "a", mode: 0o600 });
  let consumer = null;
  let runningTask = null;
  const activeCommands = new Set();
  let activeReplySlots = 0;
  const replyWaiters = [];
  let draining = false;
  let shuttingDown = false;
  let shutdownReadyForFinalize = false;
  let shutdownFinalized = false;
  let consumerState = "starting";
  let consumerRestartAttempts = 0;
  let consumerReadyAt = null;
  let dedupeBackpressure = false;
  let lastConsumerError = null;
  function persistQueue() {
    writeJsonAtomic(paths.queuePath, { items: queue });
  }

  persistQueue();

  function log(message, extra = {}) {
    const entry = { ts: new Date().toISOString(), message, ...extra };
    bridgeLog.write(`${JSON.stringify(entry)}\n`);
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }

  async function ensureAgentTreeExited(task, reason) {
    if (!task?.child) return true;
    if (task.escalationTimer) {
      clearTimeout(task.escalationTimer);
      task.escalationTimer = null;
    }
    if (process.platform === "win32") {
      return task.child.exitCode !== null || task.child.signalCode !== null;
    }
    const processGroupId = task.processGroupId;
    if (!processGroupAlive(processGroupId)) return true;
    const processKind = task.processKind || "assistant";
    log(`${processKind}_process_group_still_alive`, { jobId: task.jobId, processGroupId, reason });
    terminateChildTree(task.child, "SIGTERM", processGroupId);
    if (await waitForProcessGroupExit(processGroupId, 2000)) return true;
    log(`${processKind}_process_group_force_kill`, { jobId: task.jobId, processGroupId, reason });
    terminateChildTree(task.child, "SIGKILL", processGroupId);
    const stopped = await waitForProcessGroupExit(processGroupId, 1500);
    if (!stopped) log(`${processKind}_process_group_leaked`, { jobId: task.jobId, processGroupId, reason });
    return stopped;
  }

  function writeStatus(extra = {}) {
    writeJsonAtomic(paths.statusPath, {
      pid: process.pid,
      instanceId,
      startedAt: bridgeStartedAt,
      updatedAt: new Date().toISOString(),
      consumer: consumerState,
      defaultBackend: config.activeBackend,
      defaultWorkspace: config.defaultWorkspace,
      running: runningTask
        ? {
          jobId: runningTask.jobId,
          backend: runningTask.backend,
          workspace: runningTask.workspace,
          senderId: runningTask.message.senderId,
          phase: runningTask.phase,
          messageId: runningTask.message.messageId,
          startedAt: runningTask.startedAt,
        }
        : null,
      queueLength: queue.filter((item) => item.phase === "queued").length,
      replyPending: queue.filter((item) => item.phase === "reply_pending").length,
      outboxBackpressure: queue.length >= config.runtime.outboxLimit,
      dedupeBackpressure,
      activeReplyCommands: activeCommands.size,
      activeReplySlots,
      pendingReplies: replyWaiters.length,
      replyBackpressure: replyWaiters.length >= config.reply.pendingLimit,
      lastConsumerError,
      ...extra,
    });
  }

  function larkArgs(args) {
    return config.lark.profile ? ["--profile", config.lark.profile, ...args] : args;
  }

  function acquireReplySlot(purpose) {
    if (shuttingDown) return Promise.resolve(false);
    if (activeReplySlots < config.reply.concurrency) {
      activeReplySlots += 1;
      writeStatus();
      return Promise.resolve(true);
    }
    if (replyWaiters.length >= config.reply.pendingLimit) {
      log("reply_backpressure", {
        purpose,
        activeReplySlots,
        pendingReplies: replyWaiters.length,
      });
      writeStatus({ replyBackpressure: true });
      return Promise.resolve(false);
    }
    return new Promise((resolvePromise) => {
      replyWaiters.push({ purpose, resolve: resolvePromise });
      writeStatus();
    });
  }

  function releaseReplySlot() {
    const waiter = replyWaiters.shift();
    if (waiter) {
      waiter.resolve(true);
    } else {
      activeReplySlots = Math.max(0, activeReplySlots - 1);
    }
    writeStatus();
  }

  function cancelReplyWaiters() {
    for (const waiter of replyWaiters.splice(0)) waiter.resolve(false);
    writeStatus();
  }

  async function finalizeShutdown() {
    if (shutdownFinalized) return;
    shutdownFinalized = true;
    try {
      const pid = Number.parseInt(readFileSync(paths.pidPath, "utf8"), 10);
      if (pid === process.pid) unlinkSync(paths.pidPath);
    } catch {
      // A concurrent stop command may already have removed it.
    }
    releaseRuntimeLock(paths, instanceId);
    await new Promise((resolvePromise) => bridgeLog.end(resolvePromise));
    process.exit(0);
  }

  function runCommand(command, args, options = {}) {
    return new Promise((resolveResult) => {
      const child = spawn(command, args, {
        cwd: options.cwd || config.runtime.stateDir,
        env: { ...process.env, ...(options.env || {}) },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const commandTask = {
        child,
        processGroupId: child.pid,
        processKind: "lark",
        jobId: options.purpose || `command-${child.pid}`,
        escalationTimer: null,
        forceFinishTimer: null,
        timedOut: false,
      };
      activeCommands.add(commandTask);
      writeStatus();
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeoutMs = options.timeoutMs || config.reply.commandTimeoutSeconds * 1000;
      const timeout = setTimeout(() => {
        commandTask.timedOut = true;
        log("lark_command_timeout", { purpose: commandTask.jobId, pid: child.pid, timeoutMs });
        terminateChildTree(child, "SIGTERM", commandTask.processGroupId);
        commandTask.escalationTimer = setTimeout(
          () => terminateChildTree(child, "SIGKILL", commandTask.processGroupId),
          2000,
        );
        commandTask.escalationTimer.unref();
        commandTask.forceFinishTimer = setTimeout(
          () => finish({ code: -2, signal: null }),
          4000,
        );
        commandTask.forceFinishTimer.unref();
      }, timeoutMs);
      timeout.unref();
      const finish = async (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (commandTask.forceFinishTimer) clearTimeout(commandTask.forceFinishTimer);
        await ensureAgentTreeExited(commandTask, commandTask.timedOut ? "command_timeout" : "command_exit");
        activeCommands.delete(commandTask);
        writeStatus();
        if (
          shuttingDown
          && consumerState === "stop_blocked"
          && activeCommands.size === 0
          && !shutdownReadyForFinalize
        ) {
          setImmediate(() => {
            stopConsumerAndFinalize().catch((error) => {
              log("shutdown_resume_failed", { error: error.stack || error.message });
              consumerState = "stop_blocked";
              writeStatus({ stopBlocked: true });
            });
          });
        }
        resolveResult({
          ...result,
          code: commandTask.timedOut ? -2 : result.code,
          timedOut: commandTask.timedOut,
          stdout,
          stderr,
        });
      };
      child.stdout.on("data", (chunk) => {
        stdout = appendCaptured(stdout, chunk, config.runtime.maxCapturedOutputChars);
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendCaptured(stderr, chunk, config.runtime.maxCapturedOutputChars);
      });
      child.on("error", (error) => {
        stderr = appendCaptured(stderr, `\n${error.message}`, config.runtime.maxCapturedOutputChars);
        finish({ code: -1, signal: null });
      });
      child.on("close", (code, signal) => finish({ code, signal }));
      child.stdin.on("error", (error) => {
        stderr = appendCaptured(stderr, `\nstdin: ${error.message}`, config.runtime.maxCapturedOutputChars);
      });
      if (options.stdin) child.stdin.write(options.stdin);
      child.stdin.end();
    });
  }

  async function reply(message, text, purpose) {
    if (!message.messageId) {
      log("reply_skipped", { reason: "missing_source_message_id" });
      return false;
    }
    if (!await acquireReplySlot(purpose)) return false;
    try {
      const args = larkArgs([
        "im",
        "+messages-reply",
        "--as",
        "bot",
        "--message-id",
        message.messageId,
        "--text",
        truncateReply(text, config.reply.maxChars),
        "--idempotency-key",
        stableIdempotencyKey(message.messageId, purpose),
        "--format",
        "json",
      ]);
      if (config.reply.inThread) args.push("--reply-in-thread");
      for (let attempt = 1; attempt <= config.reply.maxAttempts; attempt += 1) {
        if (shuttingDown) return false;
        const result = await runCommand(config.lark.command, args, {
          purpose: `reply-${purpose}-attempt-${attempt}`,
        });
        const parsed = parseReplyResult(result.code, result.stdout);
        if (parsed.ok) {
          log("reply_succeeded", {
            sourceMessageId: message.messageId,
            replyMessageId: parsed.messageId,
            purpose,
            attempt,
          });
          return true;
        }
        log("reply_failed", {
          reason: parsed.reason,
          sourceMessageId: message.messageId,
          purpose,
          stderr: result.stderr.slice(-1000),
          attempt,
        });
        if (attempt < config.reply.maxAttempts) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 500));
        }
      }
      return false;
    } finally {
      releaseReplySlot();
    }
  }

  async function runAssistant(item, execution = null) {
    const { message, task } = item;
    if (shuttingDown || runningTask?.cancelRequested) {
      return { finalText: "任务在启动后台前已取消。", jobId: item.jobId };
    }
    const backendName = item.backend;
    const workspaceAlias = item.workspace;
    const workspacePath = config.workspaces[workspaceAlias];
    const jobId = item.jobId;
    const jobDir = execution ? join(paths.runsDir, backendName, jobId, execution.stage) : join(paths.runsDir, backendName, jobId);
    mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(jobDir, 0o700);
    const outputPath = join(jobDir, "last-message.md");
    const stdoutPath = join(jobDir, "stdout.log");
    const stderrPath = join(jobDir, "stderr.log");
    const invocation = execution
      ? buildSessionInvocation(config, backendName, execution.cwd, outputPath, execution.sessionId, { router: execution.stage === "router" })
      : buildBackendInvocation(config, backendName, workspacePath, outputPath);
    const prompt = execution?.prompt ?? buildAgentPrompt({
      message,
      userText: task.text,
      workspaceAlias,
      workspacePath,
      backendName,
      confirmed: task.confirmed,
    });

    log("assistant_start", { jobId, backend: backendName, workspace: workspaceAlias, messageId: message.messageId });
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: buildBackendEnvironment(config.backends[backendName]),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutFile = createWriteStream(stdoutPath, { mode: 0o600 });
    const stderrFile = createWriteStream(stderrPath, { mode: 0o600 });
    let stdout = "";
    let firstOutput = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      if (firstOutput.length < 65536) firstOutput += chunk.toString().slice(0, 65536 - firstOutput.length);
      stdout = appendCaptured(stdout, chunk, config.runtime.maxCapturedOutputChars);
    });
    child.stdout.pipe(stdoutFile);
    child.stderr.pipe(stderrFile);
    child.stdin.on("error", (error) => log("assistant_stdin_error", { jobId, error: error.message }));
    child.stdin.write(prompt);
    child.stdin.end();

    runningTask.child = child;
    runningTask.processGroupId = child.pid;
    runningTask.phase = "running";
    writeStatus();

    const timeout = setTimeout(() => {
      timedOut = true;
      log("assistant_timeout", { jobId, timeoutSeconds: config.runtime.taskTimeoutSeconds });
      terminateChildTree(child, "SIGTERM", runningTask.processGroupId);
      runningTask.escalationTimer = setTimeout(
        () => terminateChildTree(child, "SIGKILL", runningTask.processGroupId),
        5000,
      );
      runningTask.escalationTimer.unref();
    }, config.runtime.taskTimeoutSeconds * 1000);
    timeout.unref();

    const result = await new Promise((resolveResult) => {
      child.on("error", (error) => resolveResult({ code: -1, signal: null, error }));
      child.on("close", (code, signal) => resolveResult({ code, signal }));
    });
    clearTimeout(timeout);
    const treeStopped = await ensureAgentTreeExited(runningTask, timedOut ? "timeout" : "backend_exit");
    stdoutFile.end();
    stderrFile.end();
    log("assistant_done", { jobId, code: result.code, signal: result.signal, timedOut });

    let finalText = readFinalText({ outputMode: invocation.outputMode, outputPath, stdout });
    if (!finalText) {
      if (timedOut) finalText = `任务超过 ${config.runtime.taskTimeoutSeconds} 秒，已终止。`;
      else if (result.code === 0) finalText = "任务已完成，但后台没有生成最终文本。";
      else finalText = `任务执行失败：code=${result.code}, signal=${result.signal || "none"}`;
    }
    if (result.code !== 0 || timedOut) finalText += `\n\n本机任务日志：${jobDir}`;
    if (!treeStopped) finalText += `\n\n警告：后台进程组 ${child.pid} 未确认完全退出，请立即在本机检查。`;
    return { finalText, jobId, sessionId: sessionIdFromOutput(invocation, invocation.outputMode === "json-result" ? stdout : firstOutput),
      success: result.code === 0 && !timedOut && treeStopped && !shuttingDown && !runningTask.cancelRequested };
  }

  async function runRoutedAssistant(item) {
    const ledger = loadSessions(config);
    const scope = routingScope(config, item);
    const sessions = ledger.sessions.filter((session) => session.scope === scope);
    const decisionResult = await runAssistant(item, {
      stage: "router", cwd: config.routing.directory,
      prompt: buildRoutingPrompt(config, item, sessions),
    });
    if (!decisionResult.success) throw new Error(`路由阶段失败，未执行工作任务。${decisionResult.finalText}`);
    const decision = parseRoutingDecision(decisionResult.finalText, sessions);
    if (decision.action === "reply") return { finalText: decision.text };
    if (decision.action === "new" && (sessions.length >= 100 || ledger.sessions.length >= 1000)) {
      throw new Error("会话数量已达上限（每个上下文 100、总计 1000），请在本机归档会话账本");
    }
    let session = decision.action === "resume" ? sessions.find((entry) => entry.id === decision.sessionId) : null;
    if (session) {
      // A crash after dispatch must not silently resume a possibly interrupted write.
      session.status = "uncertain";
      saveSessions(config, ledger);
    }
    log("route_selected", { jobId: item.jobId, action: decision.action, sessionId: session?.id || null, scope });
    const result = await runAssistant(item, {
      stage: "worker", cwd: config.workspaces[item.workspace], sessionId: session?.id,
    });
    if (session && result.sessionId !== session.id) throw new Error("后台未确认目标会话 ID；原会话保留为结果不确定，请在本机检查");
    if (!session && result.sessionId) {
      if (ledger.sessions.some((entry) => entry.id === result.sessionId)) throw new Error("后台返回已被登记的会话 ID，请在本机检查");
      session = { id: result.sessionId, scope, title: decision.title };
      ledger.sessions.push(session);
    }
    if (session) {
      Object.assign(session, { status: result.success ? "ready" : "uncertain", updatedAt: new Date().toISOString(),
        lastRequest: item.task.text.slice(0, 1000), summary: result.finalText.slice(0, 1000) });
      saveSessions(config, ledger);
    } else if (result.success) {
      result.finalText += "\n\n本轮已执行，但后台未返回可登记的会话 ID，后续无法自动续接；请检查本机任务日志。";
    }
    return result;
  }

  async function handleControl(message, command) {
    let selection = loadSelection(config, message.senderId);
    if (command.kind === "help") {
      const help = accessRole(config, message.senderId) === "owner" ? controlHelp(selection, config) : guestHelp;
      for (let offset = 0; offset < help.length; offset += config.reply.maxChars) {
        if (!await reply(message, help.slice(offset, offset + config.reply.maxChars), offset ? `help-${offset}` : "help")) return false;
      }
      return true;
    }
    if (command.kind === "guest") {
      try {
        const [operation, openId, expiresAt, extra] = command.args;
        if (extra || (operation === "remove" && expiresAt)) throw new Error("格式: /guest add <open_id> <ISO到期时间> 或 /guest remove <open_id>");
        changeGuest(config, message.senderId, operation, openId, expiresAt);
        return reply(message, operation === "add" ? `已授权访客 ${openId}，到期 ${expiresAt}。` : `已撤销访客 ${openId}。`, "guest-updated");
      } catch (error) { return reply(message, error.message, "guest-invalid"); }
    }
    if (command.kind === "ping") return reply(message, "pong", "ping");
    if (command.kind === "status") {
      const queuedCount = queue.filter((item) => item.phase === "queued").length;
      const taskStatus = runningTask
        ? `正在处理任务，另有 ${queuedCount} 个任务排队。`
        : `当前空闲，排队 ${queuedCount} 个。`;
      return reply(
        message,
        taskStatus,
        "status",
      );
    }
    if (command.kind === "cancel") {
      if (!runningTask) return reply(message, "当前没有正在运行的任务。", "cancel-empty");
      if (runningTask.message.senderId !== message.senderId) {
        return reply(message, "当前任务属于另一位允许用户，不能跨用户取消。", "cancel-not-owner");
      }
      const task = runningTask;
      task.cancelRequested = true;
      terminateChildTree(task.child, "SIGTERM", task.processGroupId);
      if (task.child) {
        if (task.escalationTimer) clearTimeout(task.escalationTimer);
        task.escalationTimer = setTimeout(
          () => terminateChildTree(task.child, "SIGKILL", task.processGroupId),
          5000,
        );
        task.escalationTimer.unref();
      }
      return reply(message, `已请求取消任务 ${task.jobId}。`, `cancel-${task.jobId}`);
    }
    if (command.kind === "backend-status") {
      return reply(message, `当前后台：${selection.backend}`, "backend-status");
    }
    if (command.kind === "backend-list") {
      return reply(message, `可用后台：${Object.keys(config.backends).join(", ")}\n当前：${selection.backend}`, "backend-list");
    }
    if (command.kind === "backend-switch") {
      if (!Object.hasOwn(config.backends, command.target)) {
        return reply(message, `未知后台 ${command.target}。可用：${Object.keys(config.backends).join(", ")}`, "backend-invalid");
      }
      selection = { ...selection, backend: command.target };
      saveSelection(config, message.senderId, selection);
      writeStatus();
      return reply(message, `已切换后台到 ${command.target}，只影响后续任务。`, `backend-${command.target}`);
    }
    if (command.kind === "workspace-status") {
      return reply(message, `当前工作区：${selection.workspace}\n路径：${config.workspaces[selection.workspace]}`, "workspace-status");
    }
    if (command.kind === "workspace-list") {
      const lines = Object.entries(config.workspaces).map(([alias, workspacePath]) => `${alias}: ${workspacePath}`);
      return reply(message, `可用工作区：\n${lines.join("\n")}\n当前：${selection.workspace}`, "workspace-list");
    }
    if (command.kind === "workspace-switch") {
      if (!Object.hasOwn(config.workspaces, command.target)) {
        return reply(message, `未知工作区 ${command.target}。可用：${Object.keys(config.workspaces).join(", ")}`, "workspace-invalid");
      }
      selection = { ...selection, workspace: command.target };
      saveSelection(config, message.senderId, selection);
      writeStatus();
      return reply(message, `已切换工作区到 ${command.target}，只影响后续任务。`, `workspace-${command.target}`);
    }
    if (command.kind === "confirm-empty") {
      return reply(message, `${config.safety.confirmPrefix} 后需要附上完整请求。`, "confirm-empty");
    }
    return false;
  }

  async function drainQueue() {
    if (draining || shuttingDown) return;
    draining = true;
    try {
      while (!shuttingDown) {
        const now = Date.now();
        const itemIndex = queue.findIndex((item) => (
          item.phase === "queued"
          || (item.phase === "reply_pending" && Number(item.nextAttemptAt || 0) <= now)
        ));
        if (itemIndex < 0) break;
        const item = queue[itemIndex];
        if (accessRole(config, item.message.senderId) !== "owner") {
          queue.splice(itemIndex, 1);
          persistQueue();
          log("queue_access_revoked", { jobId: item.jobId });
          continue;
        }

        if (item.phase === "reply_pending") {
          const delivered = await reply(item.message, item.finalText, `final-${item.jobId}`);
          if (delivered) {
            queue.splice(itemIndex, 1);
          } else {
            item.nextAttemptAt = Date.now() + 30_000;
          }
          persistQueue();
          writeStatus();
          continue;
        }

        item.phase = "running";
        runningTask = {
          child: null,
          jobId: item.jobId,
          backend: item.backend,
          workspace: item.workspace,
          message: item.message,
          startedAt: new Date().toISOString(),
          phase: "acknowledging",
          cancelRequested: false,
        };
        persistQueue();
        writeStatus();

        await reply(
          item.message,
          "收到，开始处理。",
          `start-${item.message.messageId}`,
        );
        try {
          const result = config.routing?.mode === "agent" ? await runRoutedAssistant(item) : await runAssistant(item);
          item.finalText = truncateReply(result.finalText, config.reply.maxChars);
        } catch (error) {
          log("task_failed", { error: error.stack || error.message, messageId: item.message.messageId });
          item.finalText = `处理失败：${error.message}`;
        }
        item.phase = "reply_pending";
        item.nextAttemptAt = 0;
        persistQueue();
        runningTask = null;
        writeStatus();
      }
    } finally {
      draining = false;
      const nextReplyAt = queue
        .filter((item) => item.phase === "reply_pending")
        .map((item) => Number(item.nextAttemptAt || 0))
        .filter((value) => value > Date.now())
        .sort((left, right) => left - right)[0];
      if (!shuttingDown && queue.some((item) => item.phase === "queued")) setImmediate(drainQueue);
      else if (!shuttingDown && nextReplyAt) {
        setTimeout(drainQueue, Math.max(100, nextReplyAt - Date.now())).unref();
      }
    }
  }

  async function receiveEvent(rawEvent) {
    const message = normalizeIncomingEvent(rawEvent);
    const accepted = shouldAcceptMessage(message, config, dedupe);
    if (!accepted.ok) {
      log("event_ignored", { reason: accepted.reason, senderId: message.senderId, chatType: message.chatType });
      return;
    }
    if (!dedupe.canAdd(accepted.dedupeId)) {
      dedupeBackpressure = true;
      log("event_ignored", {
        reason: "dedupe_capacity_full",
        senderId: message.senderId,
        chatType: message.chatType,
      });
      writeStatus({ dedupeBackpressure: true });
      return;
    }
    dedupeBackpressure = false;
    log("event_accepted", {
      eventId: message.eventId,
      messageId: message.messageId,
      senderId: message.senderId,
      chatType: message.chatType,
      messageType: message.messageType,
    });
    const mentionTokens = [...config.group.mentionTokens];
    for (const mention of message.mentions || []) {
      if (!config.group.mentionIds.includes(mention.id)) continue;
      if (mention.key) mentionTokens.push(mention.key);
      if (mention.name) mentionTokens.push(`@${mention.name}`);
    }
    const text = stripMentionTokens(message.text, mentionTokens);
    const command = parseControlCommand(text, config);
    if (!commandAllowed(config, message.senderId, command)) {
      dedupe.add(accepted.dedupeId);
      await reply(message, "访客只能使用以下命令：\n" + guestHelp, "access-denied");
      return;
    }
    if (command.kind !== "task") {
      dedupe.add(accepted.dedupeId);
      await handleControl(message, command);
      return;
    }
    if (!command.text) {
      dedupe.add(accepted.dedupeId);
      await reply(message, "消息内容为空。", "empty-task");
      return;
    }
    if (queue.length >= config.runtime.outboxLimit) {
      await reply(message, `Router 未完成任务/待回复账本已满（上限 ${config.runtime.outboxLimit}），已暂停接收新任务。`, "outbox-full");
      writeStatus({ outboxBackpressure: true });
      return;
    }
    if (queue.filter((item) => item.phase !== "reply_pending").length >= config.runtime.queueLimit) {
      await reply(message, `队列已满（上限 ${config.runtime.queueLimit}），请稍后重试。`, "queue-full");
      return;
    }
    const selection = loadSelection(config, message.senderId);
    const busy = Boolean(draining || runningTask || queue.some((item) => item.phase === "queued" || item.phase === "running"));
    queue.push({
      jobId: randomUUID(),
      phase: "queued",
      message,
      task: command,
      backend: selection.backend,
      workspace: selection.workspace,
      acceptedAt: new Date().toISOString(),
    });
    persistQueue();
    try {
      dedupe.add(accepted.dedupeId);
    } catch (error) {
      queue.pop();
      persistQueue();
      throw error;
    }
    writeStatus();
    if (busy) {
      const tasksAhead = queue.filter((item) => item.phase === "queued" || item.phase === "running").length - 1;
      await reply(message, `消息已排队，前面还有 ${Math.max(0, tasksAhead)} 个任务。`, "queued");
    }
    setImmediate(drainQueue);
  }

  function startConsumer() {
    if (shuttingDown) return;
    consumerState = "starting";
    writeStatus();
    const jq = 'select(.message_type=="text" or .message_type=="post") | {event_id, chat_id, chat_type, sender_id, sender_type, message_id, message_type, content, mentions, create_time}';
    const args = larkArgs(["event", "consume", "im.message.receive_v1", "--as", "bot", "--jq", jq]);
    consumer = spawn(config.lark.command, args, {
      cwd: config.runtime.stateDir,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    log("consumer_start", { pid: consumer.pid });
    const pendingEventLines = [];
    const handleEventLine = (line) => {
      let rawEvent;
      try {
        rawEvent = JSON.parse(line);
      } catch (error) {
        log("event_parse_failed", { error: error.message, sample: line.slice(0, 200) });
        return;
      }
      receiveEvent(rawEvent).catch((error) => log("event_handle_failed", { error: error.stack || error.message }));
    };
    const lines = createInterface({ input: consumer.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      if (consumerState !== "ready") {
        if (pendingEventLines.length < 100) pendingEventLines.push(line);
        else log("event_dropped_before_ready", { reason: "pending_buffer_full" });
      }
      else handleEventLine(line);
    });
    const diagnostics = createInterface({ input: consumer.stderr });
    diagnostics.on("line", (line) => {
      if (line.startsWith("[event] ready event_key=")) {
        consumerState = "ready";
        consumerReadyAt = Date.now();
        lastConsumerError = null;
        writeStatus();
        log("consumer_ready");
        for (const line of pendingEventLines.splice(0)) handleEventLine(line);
        setImmediate(drainQueue);
      } else {
        try {
          const parsed = JSON.parse(line);
          if (parsed.ok === false && parsed.error) {
            lastConsumerError = {
              type: parsed.error.type,
              subtype: parsed.error.subtype,
              message: parsed.error.message,
              hint: parsed.error.hint,
              missingScopes: parsed.error.missing_scopes,
            };
            writeStatus();
            log("consumer_failure", { error: lastConsumerError });
            return;
          }
        } catch {
          // Non-JSON diagnostics such as the normal exit summary are logged below.
        }
        log("consumer_stderr", { text: line.slice(-1000) });
      }
    });
    consumer.on("error", (error) => log("consumer_error", { error: error.message }));
    consumer.on("close", (code, signal) => {
      consumer = null;
      if (shuttingDown) {
        if (shutdownReadyForFinalize) finalizeShutdown();
        return;
      }
      consumerState = "restarting";
      if (
        consumerReadyAt
        && Date.now() - consumerReadyAt >= config.runtime.consumerStableResetSeconds * 1000
      ) {
        consumerRestartAttempts = 0;
      }
      consumerReadyAt = null;
      consumerRestartAttempts += 1;
      const restartDelayMs = Math.min(
        config.runtime.consumerRestartDelayMs * (2 ** Math.min(consumerRestartAttempts - 1, 8)),
        config.runtime.consumerRestartMaxDelayMs,
      );
      writeStatus({ lastConsumerExit: { code, signal, at: new Date().toISOString() } });
      log("consumer_exit", { code, signal, restartDelayMs, restartAttempt: consumerRestartAttempts });
      setTimeout(startConsumer, restartDelayMs).unref();
    });
  }

  async function stopConsumerAndFinalize() {
    if (shutdownReadyForFinalize) return;
    shutdownReadyForFinalize = true;
    if (consumerState === "stop_blocked") {
      consumerState = "stopping";
      writeStatus({ resumedAfterReplyDrain: true });
      log("shutdown_resumed_after_reply_drain");
    }
    if (consumer) {
      const consumerToStop = consumer;
      const stdinExit = waitForChildExit(consumerToStop, 4000);
      consumerToStop.stdin.end();
      if (!await stdinExit) {
        log("consumer_sigterm_on_shutdown", { pid: consumerToStop.pid });
        const signalExit = waitForChildExit(consumerToStop, 4000);
        consumerToStop.kill("SIGTERM");
        if (!await signalExit) {
          log("consumer_shutdown_timeout", { pid: consumerToStop.pid });
          consumerState = "stop_blocked";
          writeStatus({ stopBlocked: true, stopBlockedPid: consumerToStop.pid });
          return;
        }
      }
    }
    await finalizeShutdown();
  }

  async function shutdown(signal) {
    if (shuttingDown) {
      if (consumerState === "stop_blocked" && activeCommands.size > 0) {
        for (const commandTask of activeCommands) {
          terminateChildTree(commandTask.child, "SIGTERM", commandTask.processGroupId);
        }
      } else if (!shutdownReadyForFinalize) {
        await stopConsumerAndFinalize();
      } else if (consumerState === "stop_blocked" && consumer) {
        consumer.kill("SIGTERM");
      }
      return;
    }
    shuttingDown = true;
    if (runningTask) runningTask.cancelRequested = true;
    cancelReplyWaiters();
    consumerState = "stopping";
    writeStatus({ stoppingSignal: signal });
    log("shutdown", { signal });
    if (runningTask) {
      const task = runningTask;
      const taskChild = task.child;
      if (taskChild) {
        const gracefulExit = waitForChildExit(taskChild, 3000);
        terminateChildTree(taskChild, "SIGTERM", task.processGroupId);
        if (!await gracefulExit) {
          log("assistant_force_kill_on_shutdown", { jobId: task.jobId });
          const forcedExit = waitForChildExit(taskChild, 1000);
          terminateChildTree(taskChild, "SIGKILL", task.processGroupId);
          await forcedExit;
        }
        await ensureAgentTreeExited(task, "router_shutdown");
      }
    }
    if (activeCommands.size > 0) {
      const commandsToStop = [...activeCommands];
      for (const commandTask of commandsToStop) {
        terminateChildTree(commandTask.child, "SIGTERM", commandTask.processGroupId);
      }
      await Promise.all(commandsToStop.map(async (commandTask) => {
        const directExit = waitForChildExit(commandTask.child, 2000);
        if (!await directExit) {
          terminateChildTree(commandTask.child, "SIGKILL", commandTask.processGroupId);
          await waitForChildExit(commandTask.child, 1000);
        }
        await ensureAgentTreeExited(commandTask, "router_shutdown");
      }));
      for (let attempt = 0; attempt < 20 && activeCommands.size > 0; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      if (activeCommands.size > 0) {
        log("lark_commands_shutdown_timeout", { count: activeCommands.size });
        consumerState = "stop_blocked";
        writeStatus({ stopBlocked: true, activeReplyCommands: activeCommands.size });
        return;
      }
    }
    await stopConsumerAndFinalize();
  }

  const bridgeStartedAt = new Date().toISOString();
  writeStatus();
  log("bridge_start", {
    pid: process.pid,
    instanceId,
    configPath: config.configPath,
    stateDir: config.runtime.stateDir,
    defaultBackend: config.activeBackend,
    defaultWorkspace: config.defaultWorkspace,
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    log("uncaught_exception", { error: error.stack || error.message });
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (error) => {
    log("unhandled_rejection", { error: error?.stack || String(error) });
  });
  startConsumer();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : process.env.FEISHU_AGENT_ROUTER_CONFIG;
  if (!configPath) {
    process.stderr.write("缺少 --config <path>\n");
    process.exit(2);
  }
  startBridge(configPath).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
