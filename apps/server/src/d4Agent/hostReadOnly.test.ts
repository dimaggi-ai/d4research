import { assert, describe, it } from "@effect/vitest";
import { classifyHostReadOnly } from "./hostReadOnly.ts";

const allowed = [
  "cat ~/tools/d4-agent-lane/DEPLOY-RESULT-r37.txt",
  "tail -n 40 /home/dmitriis/tools/d4-agent-lane/DEPLOY-RESULT-r39.txt",
  "head -c 2000 /var/lib/system-doctor/status.json",
  "systemctl --user status tg-nia-proxy.service",
  "systemctl --user --failed",
  "systemctl --user list-units --type=service --state=failed",
  "systemctl --user is-active d4research.service",
  "journalctl --user -u failed-speculative-paper.service -n 50 --no-pager",
  "uptime",
  "df -h / /tmp /data",
  "free -h",
  "nvidia-smi --query-gpu=memory.used --format=csv",
  "checkupdates",
  "pacman -Qu",
  "ss -H -ltnp",
  "ps aux --sort=-%cpu",
  "date -u",
];

const refused: ReadonlyArray<[string, RegExp]> = [
  ["env touch /tmp/nia-read-host", /not in the read-only allowlist/],
  ["printenv", /not in the read-only allowlist/],
  ["uptime | awk 'BEGIN {system(\"id\")}'", /pipeline|not in the read-only allowlist/],
  ["uptime | sed 'e id'", /pipeline|not in the read-only allowlist/],
  ["git log --output=/tmp/nia-read-host", /not in the read-only allowlist|output/],
  ["uptime | sort --output=/tmp/nia-read-host", /pipeline|output/],
  ["cat /home/other/research-runs/run/ledger.jsonl", /outside the readable paths/],
  ["git diff --no-index /etc/passwd /dev/null", /not in the read-only allowlist/],
  ["cat ~/.ssh/id_ed25519", /outside the readable paths/],
  ["cat ~/notes.txt", /outside the readable paths/],
  ["cat ~/tools/d4-agent-lane/../../.config/secret", /outside the readable paths/],
  ["tail -f ~/tools/d4-agent-lane/DEPLOY-RESULT-r39.txt", /never ends/],
  ["echo hi > ~/x.txt", /redirections/],
  ["uptime >> log", /redirections/],
  ["cat $(ls)", /substitutions/],
  ["echo `id`", /substitutions/],
  ["systemctl --user restart tg-nia-proxy.service", /not in the read-only allowlist/],
  ["systemctl status foo", /not in the read-only allowlist/],
  ["journalctl --user --vacuum-time=1d", /not in the read-only allowlist/],
  ["journalctl --user -f -u x", /not in the read-only allowlist/],
  ["rm -rf ~/Downloads", /not in the read-only allowlist/],
  ["sudo pacman -Syu", /not in the read-only allowlist/],
  ["pacman -S htop", /not in the read-only allowlist/],
  ["git -C ~/x push origin main", /not in the read-only allowlist/],
  ["git commit -am x", /not in the read-only allowlist/],
  ["git branch -D main", /not in the read-only allowlist/],
  ["sed -i s/a/b/ f", /not in the read-only allowlist/],
  ["uptime | tee ~/x", /pipelines, substitutions/],
  ["grep secret ~/.config/x", /not in the read-only allowlist/],
  ["uptime | grep -r x /etc", /pipelines/],
  ["FOO=1 uptime", /not in the read-only allowlist/],
  ["/usr/bin/cat ~/tools/d4-agent-lane/DEPLOY-RESULT-r1.txt", /by name/],
  ["uptime & df", /separators/],
  ["python3 -c 'print(1)'", /not in the read-only allowlist/],
  ["curl https://x.invalid", /not in the read-only allowlist/],
  ["ls ~/.ssh", /not in the read-only allowlist/],
  ["docker logs -f web", /not in the read-only allowlist/],
  ["", /empty/],
];

describe("classifyHostReadOnly", () => {
  it.each(allowed)("allows %s", (command) => {
    assert.deepEqual(classifyHostReadOnly(command), { ok: true });
  });
  it.each(refused)("refuses %s", (command, reason) => {
    const verdict = classifyHostReadOnly(command);
    assert.isFalse(verdict.ok);
    if (!verdict.ok) assert.match(verdict.reason, reason);
  });
});
