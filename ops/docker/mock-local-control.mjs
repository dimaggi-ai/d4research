import * as NodeHttp from "node:http";

const systemSnapshot = {
  cpu: { overall: 17, load: [0.4, 0.3, 0.2], temp: 51 },
  mem: { total: 67_108_864, used: 16_777_216, pct: 25, available: 50_331_648, swap_pct: 0 },
  gpu: {
    name: "Docker QA GPU",
    util: 23,
    vram_used: 2,
    vram_total: 16,
    vram_pct: 12.5,
    temp: 48,
    procs: [{ pid: 42, name: "llama-server", vram_mb: 2048 }],
  },
  disks: [{ mount: "/", total_gb: 100, used_gb: 20, pct: 20 }],
  services: [
    { name: "mission-control", active: true, state: "active" },
    { name: "caddy", active: true, state: "active" },
  ],
  procs: [{ pid: 42, comm: "node", cpu: 2.5, mem: 1.2, rss_mb: 128, user: "node" }],
  procsum: { total: 8, running: 1, threads: 16 },
  uptime: 3600,
};

const wavSilence = Buffer.from(
  "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
  "base64",
);

function json(response, status, body) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

NodeHttp.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:8093");
  if (
    request.method === "GET" &&
    (url.pathname === "/health" || url.pathname === "/voice/health")
  ) {
    json(response, 200, { ok: true, panes: 1, stt: "small.en", model: "docker-qa-local" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/sysmon") {
    json(response, 200, systemSnapshot);
    return;
  }
  if (request.method === "POST" && url.pathname === "/voice/transcribe") {
    request.resume();
    request.on("end", () => json(response, 200, { text: "docker voice test" }));
    return;
  }
  if (request.method === "POST" && url.pathname === "/voice/summarize") {
    request.resume();
    request.on("end", () =>
      json(response, 200, {
        text: "The Docker voice summary is ready to hear.",
        model: "docker-qa-local",
      }),
    );
    return;
  }
  if (request.method === "POST" && url.pathname === "/voice/tts") {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": wavSilence.length,
        "content-type": "audio/wav",
      });
      response.end(wavSilence);
    });
    return;
  }
  json(response, 404, { error: "not_found" });
}).listen(8093, "0.0.0.0", () => {
  console.log("docker-qa: mock local-control listening on 8093");
});
