import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { guestHelp } from "../access.mjs";

test("bridge enforces owner and guest roles before dispatch; guest help contains no private data", async () => {
  const root = mkdtempSync(join(tmpdir(), "router-access-e2e-"));
  const cli = new URL("../router.mjs", import.meta.url).pathname;
  const fake = new URL("fake-lark-cli.mjs", import.meta.url).pathname;
  const config = join(root, "config.json");
  const replies = join(root, "replies.ndjson");
  const state = join(root, "state");
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args, "--config", config], { encoding:"utf8", timeout:30000, env:{...process.env,...env} });
  const event = (sender, text, id) => ({event_id:`evt_${id}`,message_id:id,sender_id:sender,sender_type:"user",chat_id:"oc_test",chat_type:"p2p",message_type:"text",content:text,create_time:String(Date.now()),mentions:[]});
  try {
    let result = run(["init","--no-autostart","--workspace",`main=${root}`,"--state-dir",state,"--lark-command",fake,"--backend-command",process.execPath]);
    assert.equal(result.status,0,result.stderr);
    const events = [
      event("ou_test_user",`/guest add ou_guest ${new Date(Date.now()+3600000).toISOString()}`,"grant"),
      event("ou_guest","/help","guest-help"),
      event("ou_guest","do a business task","task-denied"),
      event("ou_guest","/backend list","backend-denied"),
      event("ou_guest","/guest add ou_other 2030-01-01T00:00:00Z","grant-denied"),
      event("ou_unknown","/ping","unknown"),
      event("ou_test_user","/help","owner-help"),
      event("ou_guest","/ping","ping"),
      event("ou_guest","/status","status"),
      event("ou_guest","/cancel","cancel"),
    ];
    result=run(["start"],{FAKE_LARK_EVENTS:JSON.stringify(events),FAKE_LARK_REPLIES:replies});
    assert.equal(result.status,0,result.stderr);
    let rows=[];
    for(let i=0;i<100;i++) {
      rows=existsSync(replies)?readFileSync(replies,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse):[];
      if(rows.length===9)break;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.equal(rows.length,9,JSON.stringify(rows));
    const byId=Object.fromEntries(rows.map(row=>[row.id,row.text]));
    assert.equal(byId["guest-help"],guestHelp);
    assert.equal(byId.unknown,undefined);
    assert.equal(byId.ping,"pong");
    for(const id of ["task-denied","backend-denied","grant-denied"])assert.ok(byId[id].includes(guestHelp));
    assert.ok(byId["owner-help"].includes("ou_guest"));
    assert.ok(!byId["owner-help"].includes("ou_test_user"));
    assert.ok(byId["owner-help"].includes("owner（Test User）"));
    assert.ok(byId["owner-help"].includes(root));
    const log=readFileSync(join(state,"logs/bridge.ndjson"),"utf8");
    assert.equal(log.includes('"task_started"'),false);
    const queue=JSON.parse(readFileSync(join(state,"queue.json"),"utf8"));
    assert.equal(queue.items.length,0);
  } finally { run(["stop"]); rmSync(root,{recursive:true,force:true}); }
});
