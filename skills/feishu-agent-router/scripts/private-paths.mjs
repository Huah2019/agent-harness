import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve existing ancestors as well as not-yet-created leaves to catch symlink escapes.
export function canonicalPath(path) {
  let parent = resolve(path);
  const missing = [];
  while (!existsSync(parent)) {
    if (dirname(parent) === parent) throw new Error("无法解析路径根目录");
    missing.unshift(basename(parent));
    parent = dirname(parent);
  }
  return resolve(realpathSync(parent), ...missing);
}

export function validatePrivatePaths(config, skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const root = canonicalPath(skillRoot);
  let protectedRoot = root;
  for (let parent = root; ; parent = dirname(parent)) {
    if (existsSync(resolve(parent, ".git"))) { protectedRoot = parent; break; }
    if (dirname(parent) === parent) break;
  }
  const issues = [];
  for (const [field, path] of [
    ["configPath", config.configPath], ["runtime.stateDir", config.runtime?.stateDir],
    ["routing.directory", config.routing?.mode === "agent" ? config.routing.directory : undefined],
  ]) {
    if (typeof path !== "string" || !isAbsolute(path)) continue;
    try {
      const offset = relative(protectedRoot, canonicalPath(path));
      if (offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`))) {
        issues.push({ level: "error", code: "private_path_in_distribution", message: `${field} 必须放在 Skill 所在仓库之外（独立安装时为 Skill 目录之外），避免私人配置或会话被发布` });
      }
    } catch {
      issues.push({ level: "error", code: "private_path_unresolvable", message: `${field} 无法解析实际路径，请检查目录或软链接` });
    }
  }
  return issues;
}
