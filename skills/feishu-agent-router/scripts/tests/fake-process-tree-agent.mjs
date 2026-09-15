#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--grandchild") {
  writeFileSync(process.env.FAKE_AGENT_PID_FILE, `${process.pid}\n`);
  process.on("SIGTERM", () => {
    // Deliberately ignore graceful termination to exercise group escalation.
  });
  setInterval(() => {}, 1000);
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url), "--grandchild"], {
    env: process.env,
    stdio: "ignore",
  });
  setTimeout(() => process.exit(0), 100);
}
