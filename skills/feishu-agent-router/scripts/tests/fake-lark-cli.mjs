#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function main() {
  const args = process.argv.slice(2);
  const eventIndex = args.indexOf("event");
  const imIndex = args.indexOf("im");

  if (args.includes("+search-user")) {
    process.stdout.write(JSON.stringify({ data: { users: [{ open_id: process.env.FAKE_LARK_OWNER || "ou_test_user", localized_name: "Test User", enterprise_email: "owner@example.test" }] } }));
    return;
  }
  if (args.includes("auth") && args.includes("status")) {
    process.stdout.write(JSON.stringify({ identities: { user: { available: true, verified: true, openId: process.env.FAKE_LARK_OWNER || "ou_test_user" } } }));
    return;
  }
  if (args.includes("--version")) {
    process.stdout.write("lark-cli 1.0.84\n");
    return;
  }

  if (eventIndex >= 0 && args[eventIndex + 1] === "schema") {
    process.stdout.write(`${JSON.stringify({
      key: "im.message.receive_v1",
      scopes: ["im:message.p2p_msg:readonly"],
      auth_types: ["bot"],
    })}\n`);
    return;
  }

  if (eventIndex >= 0 && args[eventIndex + 1] === "consume") {
    process.stderr.write("[event] ready event_key=im.message.receive_v1\n");
    const events = process.env.FAKE_LARK_EVENTS
      ? JSON.parse(process.env.FAKE_LARK_EVENTS)
      : process.env.FAKE_LARK_EVENT
        ? [JSON.parse(process.env.FAKE_LARK_EVENT)]
        : [];
    if (events.length > 0) {
      setTimeout(() => {
        for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
        if (process.env.FAKE_LARK_REPEAT_EVENT === "1") {
          process.stdout.write(`${JSON.stringify(events[0])}\n`);
        }
      }, 20);
    }
    process.stdin.resume();
    if (process.env.FAKE_LARK_STUBBORN_CONSUMER_PID_FILE) {
      writeFileSync(process.env.FAKE_LARK_STUBBORN_CONSUMER_PID_FILE, `${process.pid}\n`);
      process.stdin.on("end", () => {});
      process.on("SIGTERM", () => {});
      process.on("SIGUSR1", () => process.exit(0));
      setInterval(() => {}, 1000);
    } else {
      process.stdin.on("end", () => process.exit(0));
      process.on("SIGTERM", () => {
        process.stderr.write("[event] exited — received 0 event(s) in 0s (reason: signal)\n");
        process.exit(0);
      });
    }
    return;
  }

  if (imIndex >= 0 && args[imIndex + 1] === "+messages-reply") {
    if (process.env.FAKE_LARK_REPLIES) appendFileSync(process.env.FAKE_LARK_REPLIES, JSON.stringify({ id: args[args.indexOf("--message-id") + 1], text: args[args.indexOf("--text") + 1] }) + "\n");
    if (process.env.FAKE_LARK_HANG_REPLY_DIR) {
      mkdirSync(process.env.FAKE_LARK_HANG_REPLY_DIR, { recursive: true });
      writeFileSync(join(process.env.FAKE_LARK_HANG_REPLY_DIR, `${process.pid}.pid`), `${process.pid}\n`);
      process.on("SIGTERM", () => {
        // Deliberately ignore graceful shutdown to test bounded reply cleanup.
      });
      setInterval(() => {}, 1000);
      return;
    }
    if (process.env.FAKE_LARK_HANG_REPLY_PID_FILE) {
      writeFileSync(process.env.FAKE_LARK_HANG_REPLY_PID_FILE, `${process.pid}\n`);
      process.on("SIGTERM", () => {
        // Deliberately ignore graceful shutdown to test reply lifecycle cleanup.
      });
      setInterval(() => {}, 1000);
      return;
    }
    const counterFile = process.env.FAKE_LARK_REPLY_COUNTER_FILE;
    let replyCount = 1;
    if (counterFile) {
      replyCount = Number.parseInt(existsSync(counterFile) ? readFileSync(counterFile, "utf8") : "0", 10) + 1;
      writeFileSync(counterFile, String(replyCount));
    }
    const failFrom = Number.parseInt(process.env.FAKE_LARK_FAIL_REPLY_FROM || "0", 10);
    if (failFrom > 0 && replyCount >= failFrom) {
      process.stdout.write('{"ok":false,"error":{"message":"fake reply outage"}}\n');
      return;
    }
    process.stdout.write('{"ok":true,"identity":"bot","data":{"message_id":"om_fake_reply"}}\n');
    return;
  }

  process.stderr.write(`unsupported fake lark-cli args: ${JSON.stringify(args)}\n`);
  process.exitCode = 2;
}

main();
