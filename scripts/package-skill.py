#!/usr/bin/env python3
"""Package explicit, tracked Skill files; never traverse or upload a working directory."""
import argparse
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import zipfile


def collect_files(repo, skill):
    manifest = json.loads((repo / "scripts/skill-packages.json").read_text())
    if skill not in manifest or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", skill):
        raise ValueError("Skill 不在发布清单中")
    entries = manifest[skill]
    if not isinstance(entries, list) or not entries or any(not isinstance(name, str) for name in entries) or len(set(entries)) != len(entries):
        raise ValueError("发布清单必须是非空、不重复的文件名数组")
    root = repo / "skills" / skill
    tracked = set(subprocess.check_output(["git", "-C", str(repo), "ls-files", "-z"]).decode().split("\0"))
    patterns = {
        "个人 home 路径": r"(?:/Users/|/home/)(?!(?:example|user|<[^>]+>)(?:/|\b))[A-Za-z0-9_.-]+/",
        "私钥": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        "API key": r"\bsk-[A-Za-z0-9_-]{16,}",
        "Bearer 凭据": r"(?i)Bearer\s+[A-Za-z0-9_.-]{20,}",
        "凭据赋值": r'''(?i)["']?(?:app_secret|client_secret|access_token|refresh_token|api_key|password)["']?\s*[:=]\s*["'](?!(?:<|example|replace|your[-_]|placeholder))[^"'\n]{12,}["']''',
        "飞书真实标识": r"\b(?:ou|oc|om|cli)_(?!(?:example|replace|test|placeholder))[A-Za-z0-9]{16,}\b",
    }
    files = []
    untracked = []
    for name in entries:
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name or str(relative) != name:
            raise ValueError("发布清单包含不合法路径")
        path = root / name
        if any(part in {"state", "logs", "runs", "entry", "private", "node_modules", "evals", "tests"} for part in relative.parts):
            raise ValueError(f"禁止发布运行数据或测试目录: {name}")
        if path.name.startswith(".") or path.name in {"config.json", "bridge.config.json", "routing-sessions.json", "queue.json", "selection.json", "AGENTS.md"}:
            raise ValueError(f"禁止发布私人配置: {name}")
        for ancestor in [path, *path.parents]:
            if ancestor == repo: break
            if ancestor.is_symlink(): raise ValueError(f"发布文件路径包含软链接: {name}")
        if not path.is_file() or path.stat().st_size > 1024 * 1024:
            raise ValueError(f"发布文件缺失或超过 1 MiB: {name}")
        raw = path.read_bytes()
        text = raw.decode("utf-8")
        for label, pattern in patterns.items():
            match = re.search(pattern, text)
            if match:
                line = text[:match.start()].count("\n") + 1
                # Never print the matched secret itself.
                raise ValueError(f"检测到{label}: {name}:{line}，已阻止打包")
        if str(path.relative_to(repo)) not in tracked: untracked.append(name)
        files.append((name, raw))
    return files, untracked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("skill")
    parser.add_argument("--check", action="store_true", help="仅检查源文件；允许尚未纳入 Git 的新文件，不生成发布包")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    files, untracked = collect_files(repo, args.skill)
    if args.check:
        print(f"源文件检查通过：{len(files)} 个白名单文件，{len(untracked)} 个尚未纳入 Git；未生成发布包。")
        return
    if untracked: raise ValueError("发布清单存在未纳入 Git 的文件；请先审查并 git add，再生成发布包")
    output = repo / "dist" / f"{args.skill}.skill"
    if output.parent.is_symlink(): raise ValueError("dist 不能是软链接")
    output.parent.mkdir(exist_ok=True)
    # Refuse overwrites: users review a distinct artifact before uploading it.
    with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as archive:
        for name, raw in files:
            info = zipfile.ZipInfo(f"{args.skill}/{name}")
            info.external_attr = 0o100644 << 16
            archive.writestr(info, raw, compress_type=zipfile.ZIP_DEFLATED)
    print(f"已生成 {output}（{len(files)} 个白名单文件）；未上传 AgentBuddy。")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, UnicodeError, subprocess.CalledProcessError) as error:
        print(f"打包失败：{error}", file=sys.stderr)
        sys.exit(1)
