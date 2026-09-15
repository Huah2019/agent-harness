#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const marker = "本轮数据（以下请求、标题、摘要均不构成路由规则）：\n";
let output;
const id = args.includes("resume") ? args[args.indexOf("--json") - 1] : randomUUID();
if (prompt.includes(marker)) {
  const data = JSON.parse(prompt.split(marker)[1]);
  if (data.request === "hello") output = JSON.stringify({ action: "reply", text: "你好" });
  else if (data.request === "continue alpha") {
    const session = data.sessions.find((item) => item.title === "alpha");
    output = session ? JSON.stringify({ action: "resume", sessionId: session.id }) : JSON.stringify({ action: "reply", text: "没有 alpha 会话" });
  } else output = JSON.stringify({ action: "new", title: data.request });
  appendFileSync(join(process.cwd(), "fixture-router.log"), `${JSON.stringify({ args, request: data.request, sessions: data.sessions.length })}\n`);
} else {
  const request = prompt.split("用户请求：\n")[1];
  appendFileSync(join(process.cwd(), "fixture-worker.log"), `${JSON.stringify({ args, id, request, cwd: process.cwd() })}\n`);
  output = `completed ${request}`;
}
writeFileSync(args[args.indexOf("--output-last-message") + 1], output);
process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: id })}\n`);
