import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessRole, changeGuest, commandAllowed, loadGuests, guestHelp, verifyOwner } from "../access.mjs";

test("only CLI user can be owner; bot or mismatching identity cannot substitute", () => {
  const lark = { command: new URL("fake-lark-cli.mjs", import.meta.url).pathname };
  assert.equal(verifyOwner(lark), "ou_test_user");
  assert.equal(verifyOwner(lark, undefined, { details: true }).ownerLabel, "owner（Test User）");
  assert.throws(() => verifyOwner(lark, "ou_other"), /不一致/);
});
test("owner alone grants bounded guest access, expiry and revocation survive reload", t => {
  const root = mkdtempSync(join(tmpdir(), "router-access-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { access: { ownerId: "ou_owner", guests: [] }, runtime: { stateDir: root } };
  const now = Date.parse("2030-01-01T00:00:00Z");
  for (const expiry of [undefined, "2030-02-30T00:00:00Z", "2030-01-02", "2030-01-02T01:00:00", "2029-01-01T00:00:00Z"]) {
    assert.throws(() => changeGuest(config, "ou_owner", "add", "ou_guest", expiry, now), /到期时间/);
  }
  assert.throws(() => changeGuest(config, "ou_guest", "add", "ou_other", "2030-01-02T00:00:00Z", now), /只有 owner/);
  assert.throws(() => changeGuest(config, "ou_owner", "add", "ou_owner", "2030-01-02T00:00:00Z", now), /不能修改 owner/);
  changeGuest(config, "ou_owner", "add", "ou_guest", "2030-01-02T08:00:00+08:00", now);
  const loaded = { ...config, access: { ownerId: "ou_owner", guests: loadGuests(config) } };
  assert.equal(accessRole(loaded, "ou_guest", now), "guest");
  for (const kind of ["help", "ping", "status", "cancel"]) assert.equal(commandAllowed(loaded, "ou_guest", {kind}, now), true);
  for (const kind of ["task", "guest", "backend-list", "backend-switch", "workspace-list", "workspace-switch", "confirm-empty"]) assert.equal(commandAllowed(loaded, "ou_guest", {kind}, now), false);
  assert.equal(accessRole(loaded, "ou_guest", Date.parse("2030-01-02T00:00:00Z")), null);
  assert.equal(commandAllowed(loaded, "ou_stranger", {kind:"help"}, now), false);
  assert.equal(commandAllowed(loaded, "ou_owner", {kind:"task"}, now), true);
  assert.deepEqual(guestHelp.split("\n").map(l => l.split(" ")[0]), ["/help", "/ping", "/status", "/cancel"]);
  changeGuest(config, "ou_owner", "remove", "ou_guest", undefined, now);
  assert.deepEqual(loadGuests(config), []);
  assert.equal(JSON.parse(readFileSync(join(root, "access-guests.json"))).ownerId, "ou_owner");
  assert.throws(() => loadGuests({...config, access:{ownerId:"ou_other"}}), /owner 不匹配/);
});
