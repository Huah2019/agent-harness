import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { validatePrivatePaths } from "../private-paths.mjs";

test("private config, state and routing cannot live in distribution repo, including symlinks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "router-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const skill = join(repo, "skills/router");
  mkdirSync(skill, { recursive: true }); mkdirSync(join(repo, ".git"));
  symlinkSync(repo, join(root, "alias"));
  const safe = { configPath: join(root, "private/config.json"), runtime: { stateDir: join(root, "private/state") },
    routing: { mode: "agent", directory: join(root, "private/entry") } };
  assert.deepEqual(validatePrivatePaths(safe, skill), []);
  assert.equal(validatePrivatePaths({ ...safe, configPath: join(repo, "local/config.json") }, skill).length, 1);
  assert.equal(validatePrivatePaths({ ...safe, runtime: { stateDir: join(root, "alias/new/state") } }, skill).length, 1);
  assert.equal(validatePrivatePaths({ ...safe, routing: { mode: "agent", directory: skill } }, skill).length, 1);
  assert.deepEqual(validatePrivatePaths({ ...safe, workspaces: { main: repo } }, skill), []);
  assert.deepEqual(validatePrivatePaths({ ...safe, configPath: join(root, "repo-sibling/config.json") }, skill), []);
});

test("init rejects a config inside the installed skill before creating files", () => {
  const scripts = dirname(dirname(fileURLToPath(import.meta.url)));
  const forbidden = join(scripts, `must-not-create-${process.pid}.json`);
  const result = spawnSync(process.execPath, [join(scripts, "router.mjs"), "init", "--no-autostart", "--lark-command", join(scripts, "tests/fake-lark-cli.mjs"), "--config", forbidden,
    "--sender-id", "ou_test_user", "--workspace", `main=${tmpdir()}`, "--backend-command", process.execPath], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private_path_in_distribution/);
  assert.equal(existsSync(forbidden), false);
});
