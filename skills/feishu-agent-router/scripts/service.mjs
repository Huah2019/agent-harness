import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const label = "com.bytedance.feishu-agent-router";
export function serviceInfo(config, script) {
  const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const target = `gui/${process.getuid()}/${label}`;
  let installed = process.platform === "darwin" && existsSync(path);
  let collision = false;
  if (installed) {
    const read = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf8" });
    let data;
    try { data = JSON.parse(read.stdout); } catch {}
    if (JSON.stringify(data?.ProgramArguments?.slice(1)) !== JSON.stringify([script, "run", "--config", config.configPath])) { installed = false; collision = true; }
  }
  const loaded = installed && spawnSync("/bin/launchctl", ["print", target], { stdio: "ignore" }).status === 0;
  return { path, target, installed, loaded, collision };
}
export function manageService(config, script, action) {
  if (process.platform !== "darwin") throw new Error("自动启动目前支持 macOS 登录后启动；其他系统请使用 --no-autostart 并自行配置服务管理器");
  const info = serviceInfo(config, script);
  if (info.collision) throw new Error("已有自动启动服务指向其他代码或配置；保留原服务，请先在本机核对");
  const run = args => {
    const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 15000 });
    if (result.status !== 0) throw new Error(`launchctl ${args[0]} 失败: ${result.stderr?.trim()}`);
  };
  if (action === "stop") {
    run(["disable", info.target]);
    if (info.loaded) run(["bootout", info.target]);
    return;
  }
  if (action === "install" && !info.installed) {
    const xml = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    const logs = join(config.runtime.stateDir, "logs");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const args = [process.execPath, script, "run", "--config", config.configPath];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(config.runtime.stateDir)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logs, "launchd.out.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "launchd.err.log"))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || "/usr/bin:/bin")}</string></dict>
</dict></plist>
`;
    writeFileSync(info.path, plist, { flag: "wx", mode: 0o600 });
    chmodSync(info.path, 0o600);
  } else if (!info.installed) throw new Error("未安装自动启动服务，请运行 service-install");
  run(["enable", info.target]);
  if (!info.loaded) run(["bootstrap", `gui/${process.getuid()}`, info.path]);
}
