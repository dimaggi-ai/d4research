export const NIA_SERVERS = [
  {
    id: "threads",
    title: "Threads and system",
    description: "Manage threads, projects, schedules, and local usage.",
    accessField: null,
  },
  {
    id: "host",
    title: "Host",
    description: "Check the host system and disk space.",
    accessField: "systemProbeEnabled",
  },
  {
    id: "memory",
    title: "Memory",
    description: "Search and index the local brain vault.",
    accessField: "memoryEnabled",
  },
  {
    id: "cto",
    title: "CTO",
    description: "Connect to the CTO service.",
    accessField: "ctoEnabled",
  },
  {
    id: "toolGuard",
    title: "Tool Guard",
    description: "Check Nia actions against your policy.",
    accessField: null,
  },
] as const;

export type NiaServerId = (typeof NIA_SERVERS)[number]["id"];
