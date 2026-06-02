# @keelson/rib-osdu

The OSDU CIMPL "bridge" as a [Keelson](https://github.com/danielscholl/keelson) **rib** —
a discovery-based extension that contributes deterministic workflows whose structured
output drives live canvas views. The harness stays domain-free; all OSDU/cluster
knowledge lives here, and the rib ships **zero React** into the trusted SPA.

> Status: **early / under active design.** Two views work end-to-end today — a kubectl
> Flux **topology graph** and a per-service **Quality** table (`osdu-quality release
> --output json`) — but these are **seam proofs**, not the final surfaces. The real bridge
> surfaces (Cluster ICC, Quality / Security / Features lanes) are rich composite
> dashboards; see **[docs/PRD.md](docs/PRD.md)** for what the rib delivers and
> **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how it works + the Keelson base gaps
> it depends on. No resident sidecar; all data is one-shot CLI invocations.

![Cluster topology rendering in Keelson's canvas](docs/topology.png)

## How it works

Each view is fed by a contributed workflow whose single node prints a canvas-view JSON
object; because the node declares `output_schema`, the executor promotes its stdout to
structured output, which the rib binding publishes (fail-closed: `canvasViewSchema`) to a
`rib:osdu:*` snapshot key the view is bound to.

```
osdu-topology   →  bash: bun bin/collect-topology.ts   →  graph view  →  rib:osdu:topology  →  "Cluster Topology"
osdu-quality    →  bash: bun bin/collect-quality.ts    →  board view  →  rib:osdu:quality   →  "Quality"
```

Each collector is a thin Bun script that shells a domain CLI and shapes its output with a
pure builder (no domain logic in rib glue, no analyzer reimplemented):

- **`src/topology.ts`** — pure `buildTopologyGraph(kustomizations)`: one node per Flux
  Kustomization (health in the node `kind`: `ready` / `blocked` / `suspended` / `failed`
  / `unknown`), edges from `spec.dependsOn`, dependency-free nodes rooted under the cluster.
  `bin/collect-topology.ts` reads `kubectl get kustomizations -n flux-system -o json`;
  degrades to a valid one-node graph when no cluster is reachable.
- **`src/quality.ts`** — pure `buildQualityBoard(report)`: a composite **board** — a
  good/poor/fail pulse, KPI tiles (services, avg accept/unit, critical-CVE count), and the
  per-service **table** (`buildQualityTable`, reused as a section) mirroring the CLI's columns
  (acceptance %, unit %, coverage %, Sonar reliability/security/maintainability, CVE C/H),
  worst-first. Cells carry a generic `tone` (`ok` / `warn` / `error`) so health reads as colour.
  `bin/collect-quality.ts` shells `osdu-quality release --output json` — the one-shot OSDU CLI,
  **no sidecar**; the CLI handles its own auth (`GITLAB_TOKEN` env or your `glab` login).
  Degrades to a valid empty board when the CLI is missing or errors.
- **`src/index.ts`** — the `Rib`: two `views` descriptors, two contributed workflows that
  publish to them (each `validate`d fail-closed through `canvasViewSchema`), and an
  `authStatus` probe for the kubectl context.

No data is produced in rib code — the UI's data comes from running a workflow. The
`osdu-quality` CLI must be on `PATH` (e.g. `~/.local/bin`) and authenticated (it falls back
to `glab auth`, so no token wrangling in the common case).

## Develop against a local Keelson

```bash
bun install
bun link @keelson/shared        # resolves the contract from your local keelson checkout
                                # (or rely on the symlink dev/link.ts manages)

bun test            # pure builder coverage (topology + quality)
bun run typecheck
bun run check       # biome lint + format

# Wire the rib into a local Keelson checkout (defaults to ../keelson; override with KEELSON_DIR):
bun run link:keelson
cd ../keelson && KEELSON_RIBS=osdu bun dev
```

Then open `http://127.0.0.1:5173` → **Ribs** → run a workflow (from the Workflows surface
or `keelson workflow run osdu-topology` / `osdu-quality`) → open **Cluster Topology** or
**Quality**.

Smoke-test the collectors directly:

```bash
bun run collect:topology | jq .
bun run collect:quality | jq .   # shells `osdu-quality release --output json`
```

## Distribution

For a real install (`bun add @keelson/rib-osdu`), both this package and `@keelson/shared`
must be published to a registry. `@keelson/shared` is already configured to publish; the
dev loop above needs no registry.

## Roadmap

The current two views are **seam proofs**. The real surfaces are composite dashboards that need a
generic `board` view kind in the Keelson base (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
gap G1). Once it lands: rebuild **Quality** as a board, then **Security** and **Features** lanes,
then compose them into a top-level **CIMPL** surface (gap G4), and finally the **Cluster ICC**. Each
lane wraps an existing OSDU/CIMPL CLI (`osdu-quality`, `osdu-activity`, `cimpl info`) — no
reimplemented analyzers, no resident sidecar.

## License

Apache-2.0.
