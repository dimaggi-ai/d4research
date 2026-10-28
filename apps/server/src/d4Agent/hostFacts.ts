/**
 * Host facts Nia needs before naming a shell command. Parsed from /etc/os-release so the model
 * never guesses the package manager; a wrong guess (apt on Arch) is a repeatable chat mistake.
 */
import * as Context from "effect/Context";

// Tests point this at a fixture file; production reads the real file.
export const OsReleasePath = Context.Reference<string>("d4research/d4Agent/OsReleasePath", {
  defaultValue: () => "/etc/os-release",
});

export interface HostFacts {
  readonly os: string;
  readonly osId: string;
  readonly osLike: ReadonlyArray<string>;
  readonly packageManager: string | null;
  readonly kernel: string;
  readonly hostname: string;
}

const PACKAGE_MANAGERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(arch|cachyos|manjaro|endeavouros|artix|garuda)$/, "pacman"],
  [/^(debian|ubuntu|linuxmint|pop|raspbian|kali|elementary)$/, "apt"],
  [/^(fedora|rhel|centos|rocky|almalinux|nobara)$/, "dnf"],
  [/^(opensuse.*|sles)$/, "zypper"],
  [/^alpine$/, "apk"],
  [/^(nixos)$/, "nix"],
  [/^gentoo$/, "emerge"],
  [/^void$/, "xbps"],
];

const packageManagerFor = (ids: ReadonlyArray<string>): string | null => {
  for (const id of ids) {
    const match = PACKAGE_MANAGERS.find(([pattern]) => pattern.test(id));
    if (match !== undefined) return match[1];
  }
  return null;
};

const unquote = (value: string) =>
  value
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1");

export function parseOsRelease(
  text: string,
  system: { readonly kernel: string; readonly hostname: string },
): HostFacts {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0 || line.trimStart().startsWith("#")) continue;
    fields.set(line.slice(0, index).trim(), unquote(line.slice(index + 1)));
  }
  const osId = fields.get("ID") ?? "unknown";
  const osLike = (fields.get("ID_LIKE") ?? "").split(/\s+/).filter((entry) => entry !== "");
  return {
    os: fields.get("PRETTY_NAME") ?? fields.get("NAME") ?? osId,
    osId,
    osLike,
    packageManager: packageManagerFor([osId, ...osLike]),
    kernel: system.kernel,
    hostname: system.hostname,
  };
}
