#!/usr/bin/env python3
"""
Trent VPS deployment script.
Commits agent-plug-client.tsx, pushes, then SSHes in to pull/rebuild/restart.
"""

import paramiko
import subprocess
import sys
import os

HOST = "177.7.58.39"
USER = "root"
PASS = "Cloroxgangshit6-"
APP_DIR = "/root/trent-app"
LOCAL_REPO = "/Users/bobby/Desktop/running-v/trent"

def run_local(cmd, cwd=None):
    print(f"\n[local] $ {cmd}")
    result = subprocess.run(cmd, shell=True, cwd=cwd or LOCAL_REPO,
                            capture_output=True, text=True)
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(f"[stderr] {result.stderr}")
    print(f"[exit: {result.returncode}]")
    return result.returncode

def run_remote(client, cmd, label=""):
    print(f"\n{'='*55}")
    if label:
        print(f"  {label}")
    print(f"  $ {cmd}")
    print(f"{'='*55}")
    stdin, stdout, stderr = client.exec_command(cmd, timeout=180)
    out = stdout.read().decode()
    err = stderr.read().decode()
    code = stdout.channel.recv_exit_status()
    if out:
        print(out)
    if err:
        print(f"[stderr] {err}")
    print(f"[exit: {code}]")
    return code, out, err

def main():
    # ── 1. Git commit + push locally ──────────────────────────────────────
    print("\n📦 Committing and pushing agent-plug-client.tsx...")
    run_local("git add components/agent-plug-client.tsx")
    run_local('git commit -m "Polish Agent Plug UI: hierarchy, routing intent, 13 categories, slot detail cards"')
    code = run_local("git push")
    if code != 0:
        print("❌ git push failed. Check your git remote / SSH key setup.", file=sys.stderr)
        sys.exit(1)
    print("✅ Pushed.")

    # ── 2. SSH into VPS and deploy ─────────────────────────────────────────
    print(f"\n🔌 Connecting to VPS {HOST}...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASS, timeout=20)
    print("Connected.")

    steps = [
        (f"cd {APP_DIR} && git pull origin main 2>&1", "Pull latest commits from origin/main"),
        (f"cd {APP_DIR} && npm install --legacy-peer-deps 2>&1 | tail -10", "npm install (deps check)"),
        (f"cd {APP_DIR} && npm run build 2>&1", "npm run build"),
        ("systemctl restart trent.service 2>&1", "Restart trent.service"),
        ("sleep 2 && systemctl status trent.service --no-pager -l | head -25", "Service status check"),
    ]

    for cmd, label in steps:
        code, out, err = run_remote(client, cmd, label)
        if code != 0 and label not in ("npm install (deps check)",):
            print(f"\n❌ Step failed [{label}] exit={code}", file=sys.stderr)
            if "status" not in label.lower():
                client.close()
                sys.exit(1)

    client.close()
    print("\n✅ Deployment complete. App running at http://177.7.58.39:3000")

if __name__ == "__main__":
    main()
