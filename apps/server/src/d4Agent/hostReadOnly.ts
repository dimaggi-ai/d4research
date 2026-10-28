/**
 * Decides whether one bash command only reads the host. Nia may run such a command without an
 * approval card; everything else stays a `pc` action the user clicks. The classifier is an
 * allowlist: an unknown command, a write redirection, a substitution, or a content read outside the
 * allowed paths refuses with a reason the model can repeat to the user.
 */
export type HostReadOnlyVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const COMMAND_LIMIT = 2000;

// Content readers may open only these paths: deploy results, pipeline run artifacts, probes.
const CONTENT_PATHS: ReadonlyArray<RegExp> = [
  /^(~|\$HOME|\/home\/[^/]+)\/tools\/d4-agent-lane\/DEPLOY-RESULT-[A-Za-z0-9._-]+\.txt$/,
  /^(~|\$HOME|\/)[^\s]*\/research-runs\/[^\s]+$/,
  /^\/var\/lib\/system-doctor\/status\.json$/,
  /^\/etc\/os-release$/,
  /^\/proc\/(loadavg|meminfo|uptime|version)$/,
];
const CONTENT_READERS = new Set(["cat", "head", "tail", "bat"]);
// Filters take their input from the previous pipe segment; a path argument would read a file.
const FILTERS = new Set([
  "grep",
  "rg",
  "awk",
  "sed",
  "jq",
  "sort",
  "uniq",
  "cut",
  "tr",
  "column",
  "wc",
  "head",
  "tail",
  "tac",
  "nl",
]);
const FREE_COMMANDS = new Set([
  "uptime",
  "free",
  "df",
  "du",
  "ps",
  "date",
  "hostname",
  "uname",
  "whoami",
  "id",
  "nproc",
  "lscpu",
  "lsblk",
  "nvidia-smi",
  "ss",
  "checkupdates",
  "echo",
  "printf",
  "true",
  "ls",
  "stat",
  "file",
  "wc",
  "sensors",
  "last",
  "who",
  "w",
  "env",
  "printenv",
]);
const SYSTEMCTL_VERBS = new Set([
  "status",
  "list-units",
  "list-timers",
  "list-unit-files",
  "is-active",
  "is-failed",
  "is-enabled",
  "show",
  "cat",
]);
const GIT_VERBS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "describe",
  "ls-files",
  "shortlog",
  "blame",
]);

const refuse = (reason: string): HostReadOnlyVerdict => ({ ok: false, reason });

const tokenize = (segment: string): ReadonlyArray<string> | null => {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const char of segment) {
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

const looksLikePath = (token: string) => /^(~|\$|\/|\.\.?\/)/.test(token) || token.includes("/");
// Flags such as -n 40 or -A 3 take a bare number; a number is never a file to protect.
const isNumber = (token: string) => /^\d+[kKmMgG]?$/.test(token);

const contentPathAllowed = (path: string) =>
  !path.includes("..") && CONTENT_PATHS.some((pattern) => pattern.test(path));

const checkSegment = (segment: string, first: boolean): HostReadOnlyVerdict => {
  const tokens = tokenize(segment);
  if (tokens === null) return refuse("unbalanced quotes");
  const [name, ...args] = tokens;
  if (name === undefined) return refuse("empty command");
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name))
    return refuse("environment assignments are not allowed");
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
  if (base !== name) return refuse(`call ${base} by name, not by path`);
  const flags = args.filter((arg) => arg.startsWith("-"));
  const words = args.filter((arg) => !arg.startsWith("-") && !isNumber(arg));
  if (CONTENT_READERS.has(base)) {
    if (base === "tail" && flags.some((flag) => /^(-[a-zA-Z]*[fF]|--follow)/.test(flag)))
      return refuse("tail -f never ends");
    if (words.length === 0) {
      if (first) return refuse(`${base} needs a file from the allowed list`);
      return { ok: true };
    }
    const outside = words.find((path) => !contentPathAllowed(path));
    if (outside !== undefined)
      return refuse(
        `${outside} is outside the readable paths (DEPLOY-RESULT files, research-runs artifacts, system-doctor status)`,
      );
    return { ok: true };
  }
  if (base === "systemctl") {
    if (!flags.includes("--user")) return refuse("systemctl needs --user");
    const verb = words[0] ?? (flags.includes("--failed") ? "list-units" : undefined);
    if (verb === undefined || !SYSTEMCTL_VERBS.has(verb))
      return refuse(
        `systemctl ${verb ?? ""} changes units; only status, list-units, is-active, show`,
      );
    return { ok: true };
  }
  if (base === "journalctl") {
    if (!flags.includes("--user")) return refuse("journalctl needs --user");
    const blocked = flags.find((flag) =>
      /^(-[a-zA-Z]*f|--follow|--vacuum|--rotate|--flush|--sync|--relinquish|--setup-keys)/.test(
        flag,
      ),
    );
    if (blocked !== undefined) return refuse(`journalctl ${blocked} is not a read`);
    return { ok: true };
  }
  if (base === "git") {
    // `git -C <dir> <verb>`: the directory after -C is not the subcommand.
    let verb: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "-C") {
        index += 1;
        continue;
      }
      if (!arg.startsWith("-")) {
        verb = arg;
        break;
      }
    }
    if (verb === undefined) return refuse("git needs a read-only subcommand");
    if (GIT_VERBS.has(verb)) return { ok: true };
    if (
      verb === "branch" ||
      verb === "tag" ||
      verb === "remote" ||
      verb === "stash" ||
      verb === "worktree"
    ) {
      const rest = words.slice(words.indexOf(verb) + 1);
      const changing = flags.some((flag) =>
        /^-[dDmMuf]|^--(delete|move|force|set-upstream|unset-upstream|edit-description)/.test(flag),
      );
      if (changing) return refuse(`git ${verb} with that flag changes the repository`);
      if (verb === "stash" || verb === "worktree")
        return rest[0] === "list"
          ? { ok: true }
          : refuse(`git ${verb} ${rest[0] ?? ""} changes the repository`);
      return rest.length === 0 || rest[0] === "-v"
        ? { ok: true }
        : refuse(`git ${verb} with arguments changes the repository`);
    }
    return refuse(`git ${verb} is not a read`);
  }
  if (base === "pacman") {
    return flags.length > 0 && flags.every((flag) => /^-Q|^--query/.test(flag))
      ? { ok: true }
      : refuse("pacman allows only -Q queries");
  }
  if (base === "docker" || base === "podman") {
    const verb = words[0];
    if (verb === "ps" || verb === "images") return { ok: true };
    if (verb === "logs" && !flags.some((flag) => /^(-[a-zA-Z]*f|--follow)/.test(flag)))
      return { ok: true };
    return refuse(`${base} ${verb ?? ""} is not a read`);
  }
  if (FILTERS.has(base)) {
    if (first) return refuse(`${base} reads files; pipe allowed output into it instead`);
    if (base === "sed" && flags.some((flag) => /^-[a-zA-Z]*i|^--in-place/.test(flag)))
      return refuse("sed -i edits files");
    const path = words.find(looksLikePath);
    if (path !== undefined) return refuse(`${base} ${path} would read a file`);
    return { ok: true };
  }
  if (FREE_COMMANDS.has(base)) {
    if (base === "ls" || base === "du" || base === "stat" || base === "file") {
      const secret = words.find((word) =>
        /\.(ssh|gnupg|aws|password-store)\b|secrets?\b|\.netrc/.test(word),
      );
      if (secret !== undefined) return refuse(`${secret} holds secrets`);
    }
    return { ok: true };
  }
  return refuse(`${base} is not in the read-only allowlist`);
};

export function classifyHostReadOnly(command: string): HostReadOnlyVerdict {
  const trimmed = command.trim();
  if (trimmed === "") return refuse("empty command");
  if (trimmed.length > COMMAND_LIMIT) return refuse("command too long");
  if (/[\p{Cc}]/u.test(trimmed.replace(/\n/g, ""))) return refuse("control characters");
  if (/`|\$\(|<\(|>\(/.test(trimmed)) return refuse("command substitution is not allowed");
  // Only discarding redirections stay; anything else writes or reads a file.
  const stripped = trimmed.replace(
    /(\s|^)(2>\/dev\/null|2>&1|>\/dev\/null|&>\/dev\/null|1>\/dev\/null)(?=\s|$)/g,
    "$1",
  );
  if (/[<>]/.test(stripped)) return refuse("redirection to a file is not allowed");
  const segments = stripped.split(/\|\||&&|\||;|\n/);
  if (/&/.test(stripped.replace(/\|\||&&/g, ""))) return refuse("background jobs are not allowed");
  for (const [index, segment] of segments.entries()) {
    if (segment.trim() === "") {
      if (index === segments.length - 1) continue;
      return refuse("empty pipeline segment");
    }
    const verdict = checkSegment(
      segment,
      index === 0 || !/\|/.test(stripped) ? index === 0 : false,
    );
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}
