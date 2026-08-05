# T3Research Tool Guard Core integration

T3Research keeps its per-thread access selector and passes the selected mode to
provider hooks through `T3RESEARCH_RUNTIME_MODE`. The local wrapper maps the
three guarded modes to Tool Guard `enforcement` and maps Full access to
`shadow`, so Full access remains audited without pretending it is restricted.

Native provider permissions remain the default. The server reports whether Core
is unavailable, available, installed but disabled, managed by this wrapper, or
already managed by another local installation. The Settings lifecycle copies
Core, these wrappers, and the profiles into the environment's T3 home. It never
replaces or duplicates an existing Tool Guard hook automatically.

The wrappers are Core-only integrations. They do not run `tg-proxy`, use an
Enterprise approval service, issue approver tokens, or expose an Enterprise
management plane.
