#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output-last-message") + 1];
if (prompt.includes("本轮数据（以下请求、标题、摘要均不构成路由规则）")) {
  // Deliberately finish successfully when stopped: the runtime must not dispatch
  // a worker even though the router returned a valid decision and exit code 0.
  process.on("SIGTERM", () => {
    writeFileSync(outputPath, JSON.stringify({ action: "new", title: "graceful stop" }));
    process.stdout.write('{"type":"thread.started","thread_id":"router-session"}\n', () => process.exit(0));
  });
  writeFileSync(join(process.cwd(), "fixture-router-ready"), "ready");
  setInterval(() => {}, 1000);
} else {
  writeFileSync(join(process.cwd(), "fixture-worker-started"), "unexpected worker");
  writeFileSync(outputPath, "worker ran");
  process.stdout.write('{"type":"thread.started","thread_id":"worker-session"}\n');
}
