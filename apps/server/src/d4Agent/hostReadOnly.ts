import * as NodeOS from "node:os";

export type HostReadOnlyVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const COMMAND_LIMIT = 2000;
const CONTENT_READERS = new Set(["cat", "head", "tail"]);
const SYSTEMCTL_VERBS = new Set([
  "status",
  "list-units",
  "list-timers",
  "is-active",
  "is-failed",
  "is-enabled",
  "show",
]);
const SAFE_UNITS = /^[A-Za-z0-9@_.:-]+$/;
const SAFE_PROPERTY = /^[A-Za-z][A-Za-z0-9]+$/;
const SAFE_COUNT = /^[1-9][0-9]{0,3}$/;
const SAFE_DISK_PATHS = new Set(["/", "/tmp", "/data"]);

const refuse = (reason: string): HostReadOnlyVerdict => ({ ok: false, reason });

const tokenize = (command: string): ReadonlyArray<string> | null => {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      has = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      has = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (has) tokens.push(current);
      current = "";
      has = false;
      continue;
    }
    current += char;
    has = true;
  }
  if (quote !== null) return null;
  if (has) tokens.push(current);
  return tokens;
};

const contentPathAllowed = (path: string) => {
  if (path.includes("..")) return false;
  const home = NodeOS.homedir();
  const homePath = path.startsWith("~/")
    ? path.slice(2)
    : path.startsWith("$HOME/")
      ? path.slice(6)
      : path.startsWith(`${home}/`)
        ? path.slice(home.length + 1)
        : null;
  const deploy = /\/tools\/d4-agent-lane\/DEPLOY-RESULT-[A-Za-z0-9._-]+\.txt$/;
  return (
    ((path.startsWith("~/") || path.startsWith("$HOME/") || path.startsWith(`${home}/`)) &&
      deploy.test(path)) ||
    path === "/var/lib/system-doctor/status.json" ||
    path === "/var/lib/system-doctor/selftest.json" ||
    (homePath !== null &&
      (/^\.local\/state\/schedule-watch\/[A-Za-z0-9_-]+\.json$/.test(homePath) ||
        homePath === ".local/state/nia-inbox/schedule-watch.json" ||
        homePath === ".local/state/home-backup/status")) ||
    path === "/etc/os-release" ||
    /^\/proc\/(loadavg|meminfo|uptime|version)$/.test(path)
  );
};

const contentReaderAllowed = (tokens: ReadonlyArray<string>) => {
  const [name, ...args] = tokens;
  if (!CONTENT_READERS.has(name ?? "")) return false;
  let path: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-n" || arg === "-c") {
      const count = args[index + 1];
      if (count === undefined || !SAFE_COUNT.test(count)) return false;
      index += 1;
      continue;
    }
    if (arg.startsWith("-") || path !== undefined) return false;
    path = arg;
  }
  return path !== undefined && contentPathAllowed(path);
};

const systemctlAllowed = (tokens: ReadonlyArray<string>) => {
  if (tokens[0] !== "systemctl") return false;
  const userManager = tokens[1] === "--user";
  const rest = tokens.slice(userManager ? 2 : 1);
  if (!userManager && !["show", "list-timers", "is-active"].includes(rest[0] ?? "")) return false;
  if (rest.length === 0) return false;
  if (rest[0] === "--failed")
    return rest.slice(1).every((arg) => arg === "--no-pager" || arg === "--plain");
  const verb = rest[0]!;
  if (!SYSTEMCTL_VERBS.has(verb)) return false;
  const args = rest.slice(1);
  if (verb === "list-units" || verb === "list-timers")
    return args.every(
      (arg) =>
        arg === "--no-pager" ||
        arg === "--all" ||
        arg === "--plain" ||
        /^--(type|state)=[A-Za-z0-9,_.:-]+$/.test(arg),
    );
  const unit = args[0];
  if (unit === undefined || !SAFE_UNITS.test(unit)) return false;
  if (verb !== "show") return args.slice(1).every((arg) => arg === "--no-pager");
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--no-pager") continue;
    if (arg !== "-p" && arg !== "--property") return false;
    const property = args[index + 1];
    if (property === undefined || !SAFE_PROPERTY.test(property)) return false;
    index += 1;
  }
  return true;
};

const journalAllowed = (tokens: ReadonlyArray<string>) => {
  if (tokens[0] !== "journalctl" || tokens[1] !== "--user") return false;
  let unit: string | undefined;
  let count: string | undefined;
  for (let index = 2; index < tokens.length; index += 1) {
    const arg = tokens[index]!;
    if (arg === "--no-pager" || arg === "-b") continue;
    if (arg === "-u") {
      unit = tokens[++index];
      continue;
    }
    if (arg === "-n") {
      count = tokens[++index];
      continue;
    }
    return false;
  }
  return (
    unit !== undefined && SAFE_UNITS.test(unit) && count !== undefined && SAFE_COUNT.test(count)
  );
};

const simpleCommandAllowed = (tokens: ReadonlyArray<string>) => {
  const command = tokens.join(" ");
  if (
    new Set([
      "uptime",
      "free",
      "free -h",
      "date",
      "date -u",
      "uname",
      "uname -a",
      "nproc",
      "lscpu",
      "lsblk",
      "ss -H -ltnp",
      "checkupdates",
      "pacman -Q",
      "pacman -Qu",
      "ps aux",
      "ps aux --sort=-%cpu",
    ]).has(command)
  )
    return true;
  if (tokens[0] === "df" && tokens[1] === "-h")
    return tokens.length > 2 && tokens.slice(2).every((path) => SAFE_DISK_PATHS.has(path));
  if (tokens[0] === "du" && tokens[1] === "-sh")
    return tokens.length > 2 && tokens.slice(2).every((path) => SAFE_DISK_PATHS.has(path));
  if (tokens[0] === "nvidia-smi")
    return tokens
      .slice(1)
      .every((arg) =>
        /^(--query-gpu=[A-Za-z0-9,._-]+|--format=(csv|csv,noheader|csv,nounits))$/.test(arg),
      );
  return false;
};

export function classifyHostReadOnly(command: string): HostReadOnlyVerdict {
  const trimmed = command.trim();
  if (trimmed === "") return refuse("empty command");
  if (trimmed.length > COMMAND_LIMIT) return refuse("command too long");
  if (/[\p{Cc}]/u.test(trimmed)) return refuse("control characters are not allowed");
  if (/`|\$\(|[|;&<>]/.test(trimmed))
    return refuse("pipelines, substitutions, separators and redirections are not allowed");
  // The command runs through bash, so expansion characters would let a path that
  // ends in an allowed file smuggle extra arguments (for example ${IFS}).
  // A leading $HOME/ is the one expansion allowed; it is equivalent to ~/.
  if (/[$*?{}[\]\\]/.test(trimmed.replace(/(^|\s)(["']?)\$HOME(?=\/)/g, "$1$2~")))
    return refuse("shell expansion characters ($ * ? { } [ ] \\) are not allowed");
  const tokens = tokenize(trimmed);
  if (tokens === null) return refuse("unbalanced quotes");
  const name = tokens[0];
  if (name === undefined) return refuse("empty command");
  if (name.includes("/")) return refuse("call commands by name, not by path");
  if (
    contentReaderAllowed(tokens) ||
    systemctlAllowed(tokens) ||
    journalAllowed(tokens) ||
    simpleCommandAllowed(tokens)
  )
    return { ok: true };
  if (CONTENT_READERS.has(name)) {
    if (tokens.some((token) => token === "-f" || token === "-F"))
      return refuse("-f never ends; drop it");
    return refuse("the file is outside the readable paths");
  }
  return refuse(`${name} is not in the read-only allowlist`);
}
