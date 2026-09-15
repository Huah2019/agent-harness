import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function verifyOwner(lark, expected, { details = false } = {}) {
  const args = [...(lark.profile ? ["--profile", lark.profile] : []), "auth", "status", "--json", "--verify"];
  const result = spawnSync(lark.command, args, { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  let user;
  try { user = JSON.parse(result.stdout).identities.user; } catch {}
  if (result.status !== 0 || user?.verified !== true || user?.available !== true || !/^ou_[a-zA-Z0-9_]+$/.test(user.openId || "")) {
    throw new Error("无法验证飞书 CLI 用户身份；请在本机完成当前 profile 的用户登录后重试（不会使用 bot 身份作为 owner）");
  }
  if (expected && user.openId !== expected) throw new Error("配置 owner 与飞书 CLI 当前用户不一致；服务拒绝启动，请在本机核对 profile 和 owner");
  if (!details) return user.openId;
  let label = user.userName || user.openId;
  const profile = spawnSync(lark.command, [...(lark.profile ? ["--profile", lark.profile] : []), "contact", "+search-user", "--user-ids", user.openId, "--as", "user", "--json"], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  try {
    const match = JSON.parse(profile.stdout).data.users.find(entry => entry.open_id === user.openId);
    if (profile.status === 0 && match) {
      const name = match.localized_name || user.userName;
      const email = match.enterprise_email || match.email;
      const account = typeof email === "string" && email.includes("@") ? email.split("@")[0] : "";
      label = account ? `${account}${name ? `（${name}）` : ""}` : name || label;
    }
  } catch { /* Profile display is optional; verified open_id remains the authority. */ }
  return { ownerId: user.openId, ownerLabel: String(label).replace(/[\r\n\t]/g, " ").slice(0, 200) };
}

export function loadGuests(config) {
  const path = join(config.runtime.stateDir, "access-guests.json");
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (data.ownerId !== config.access.ownerId || !Array.isArray(data.guests) || data.guests.length > 100
      || data.guests.some(g => !/^ou_[a-zA-Z0-9_]+$/.test(g?.openId || "") || g.openId === data.ownerId || !validExpiry(g.expiresAt))
      || new Set(data.guests.map(g => g.openId)).size !== data.guests.length) throw new Error("访客权限文件无效或 owner 不匹配；拒绝加载");
  return data.guests;
}
export function validExpiry(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = match.slice(1).map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
export function accessRole(config, senderId, now = Date.now()) {
  if (senderId && senderId === config.access?.ownerId) return "owner";
  return (config.access?.guests || []).some(g => g.openId === senderId && validExpiry(g.expiresAt) && Date.parse(g.expiresAt) > now) ? "guest" : null;
}
export const guestHelp = "/help - 查看可用命令\n/ping - 检查连接\n/status - 查看排队状态\n/cancel - 取消本人任务";
export function commandAllowed(config, senderId, command, now = Date.now()) {
  const role = accessRole(config, senderId, now);
  return role === "owner" || (role === "guest" && ["help", "ping", "status", "cancel"].includes(command.kind));
}
export function changeGuest(config, actor, operation, openId, expiresAt, now = Date.now()) {
  if (accessRole(config, actor, now) !== "owner") throw new Error("只有 owner 可以管理访客");
  if (!["add", "remove"].includes(operation) || !/^ou_[a-zA-Z0-9_]+$/.test(openId || "") || openId === config.access.ownerId) throw new Error("访客操作或 open_id 无效，不能修改 owner");
  if (operation === "add" && (!validExpiry(expiresAt) || Date.parse(expiresAt) <= now)) throw new Error("必须指定未来的到期时间，格式如 2030-01-01T18:00:00+08:00");
  const guests = loadGuests(config).filter(g => g.openId !== openId && Date.parse(g.expiresAt) > now);
  if (operation === "add") guests.push({ openId, expiresAt: new Date(expiresAt).toISOString() });
  if (guests.length > 100) throw new Error("访客数量已达 100 人上限");
  mkdirSync(config.runtime.stateDir, { recursive: true, mode: 0o700 });
  const path = join(config.runtime.stateDir, "access-guests.json");
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ownerId: config.access.ownerId, guests }, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
  config.access.guests = guests;
}
