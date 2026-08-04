# Docker deployment QA

The Docker QA stack validates the local deployment without reading or writing the developer's
live T3 home. It builds T3 through `scripts/deploy-local.sh --build-only`, starts an isolated server,
runs a deterministic local-control mock beside it, and puts Caddy in front of both T3 and `/voice`.

Run the complete smoke test:

```bash
bash scripts/test-docker-deployment.sh
```

The test has bounded build and startup deadlines. By default it always removes its containers,
network, and disposable state volume after the assertions pass or when the script fails or is
interrupted. Successful teardown is itself asserted before the suite exits.
To retain the environment for browser inspection:

```bash
T3CODE_QA_KEEP=1 bash scripts/test-docker-deployment.sh
```

The retained app is available at `http://127.0.0.1:18080`. It still uses T3's normal pairing
authentication. Stop and remove the retained stack with:

```bash
docker compose --project-name t3code-qa --file compose.qa.yaml down --volumes
```

The mock returns deterministic system-monitor values, local STT text, silent WAV TTS output, and a
fake `agy` model list. It never connects to external model providers and contains no production
credentials.
