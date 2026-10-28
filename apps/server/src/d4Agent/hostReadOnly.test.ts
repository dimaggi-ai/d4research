import { assert, describe, it } from "@effect/vitest";
import { classifyHostReadOnly } from "./hostReadOnly.ts";

const allowed = [
  "cat ~/tools/d4-agent-lane/DEPLOY-RESULT-r37.txt",
  "tail -n 40 /home/dmitriis/tools/d4-agent-lane/DEPLOY-RESULT-r39.txt",
  "cat ~/workspace/github/d4research/research-runs/abc/ledger.jsonl | tail -n 5",
  "head -c 2000 /home/dmitriis/x/research-runs/mcp:a427e84b/steps/01.md",
  "cat /var/lib/system-doctor/status.json | jq .failures",
  "systemctl --user status tg-nia-proxy.service",
  "systemctl --user --failed",
  "systemctl --user list-units --type=service --state=failed",
  "systemctl --user is-active d4research.service",
  "journalctl --user -u failed-speculative-paper.service -n 50 --no-pager",
  "uptime; df -h /; free -h",
  "nvidia-smi --query-gpu=memory.used --format=csv",
  "checkupdates 2>/dev/null | wc -l",
  "pacman -Qu",
  "git -C ~/workspace/github/d4research status --short",
  "git -C ~/workspace/github/d4research log --oneline -n 5",
  "ss -H -ltnp | grep 9191",
  "ps aux | grep -i d4research | head -n 5",
  "date -u",
  "ls -la ~/tools/d4-agent-lane/",
  "docker ps",
];

const refused: ReadonlyArray<[string, RegExp]> = [
  ["cat ~/.ssh/id_ed25519", /outside the readable paths/],
  ["cat ~/notes.txt", /outside the readable paths/],
  ["cat ~/tools/d4-agent-lane/../../.config/secret", /outside the readable paths/],
  ["tail -f ~/tools/d4-agent-lane/DEPLOY-RESULT-r39.txt", /never ends/],
  ["echo hi > ~/x.txt", /redirection/],
  ["uptime >> log", /redirection/],
  ["cat $(ls)", /substitution/],
  ["echo `id`", /substitution/],
  ["systemctl --user restart tg-nia-proxy.service", /changes units/],
  ["systemctl status foo", /needs --user/],
  ["journalctl --user --vacuum-time=1d", /not a read/],
  ["journalctl --user -f -u x", /not a read/],
  ["rm -rf ~/Downloads", /not in the read-only allowlist/],
  ["sudo pacman -Syu", /not in the read-only allowlist/],
  ["pacman -S htop", /only -Q/],
  ["git -C ~/x push origin main", /not a read/],
  ["git commit -am x", /not a read/],
  ["git branch -D main", /changes the repository/],
  ["sed -i s/a/b/ f", /reads files|edits files/],
  ["uptime | tee ~/x", /not in the read-only allowlist/],
  ["grep secret ~/.config/x", /reads files/],
  ["uptime | grep -r x /etc", /would read a file/],
  ["FOO=1 uptime", /environment assignments/],
  ["/usr/bin/cat ~/tools/d4-agent-lane/DEPLOY-RESULT-r1.txt", /by name/],
  ["uptime & df", /background jobs/],
  ["python3 -c 'print(1)'", /not in the read-only allowlist/],
  ["curl https://x.invalid", /not in the read-only allowlist/],
  ["ls ~/.ssh", /holds secrets/],
  ["docker logs -f web", /not a read/],
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
