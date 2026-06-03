# @keelson/rib-osdu

The OSDU CIMPL "bridge" as a [Keelson](https://github.com/danielscholl/keelson) **rib** —
a discovery-based extension that contributes deterministic workflows whose structured
output drives live canvas views. The harness stays domain-free; all OSDU/cluster
knowledge lives here, and the rib ships **zero React** into the trusted SPA.

> Status: **early / under active design.** Four views work end-to-end today — a kubectl
> Flux **topology graph** plus three composite **boards**: **Quality** (`osdu-quality release
> --output json`), **Features** (`osdu-activity epic list` / `mr --output json`), and
> **Security** (`osdu-quality release` + GitLab/OSV CVE detail). The generic `board` view they
> render through landed in the Keelson base (gap G1), as did the top-level **surface** (gap G4) —
> so the rib now composes the three lane boards into one **CIMPL** nav tab. Still ahead: the
> **Cluster ICC** and the remaining surface regions (cluster header, waiting-on-you, events feed).
> See **[docs/PRD.md](docs/PRD.md)** for what the rib delivers and
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
osdu-features   →  bash: bun bin/collect-features.ts   →  board view  →  rib:osdu:features  →  "Features"
osdu-security   →  bash: bun bin/collect-security.ts   →  board view  →  rib:osdu:security  →  "Security"
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
- **`src/features.ts`** — pure `buildFeaturesBoard(epics, mrs, now)`: a Features **board** — a
  VENUS active/quiet pulse, MR KPI tiles (open / stale / blocked / ready), "Movers" cards
  (active epics with a progress bar) and "Stalled" rows (quiet/stale epics with a why-flagged
  note). `bin/collect-features.ts` shells `osdu-activity epic list` + `mr --output json`
  (sanitizing the epic CLI's unescaped control characters before parsing); degrades to a valid
  empty board when a CLI is missing or errors.
- **`src/security.ts`** — pure `buildSecurityBoard({ report, vulns, fixes, mrs, now })`: a
  Security **board** — a crit/high/med service pulse, KPI tiles (Critical / High / Medium /
  Vuln MRs), low-security-rating cards, top-offender severity **bars** (`crit · high`), aged-
  critical CVE cards (`>30d`), and dependency-bump quick wins. Counts/ratings come from the
  `osdu-quality release` report; CVE detail comes from `bin/collect-security.ts`, which also
  shells `glab api graphql` (group `vulnerabilities`) for per-CVE rows and queries OSV.dev for
  fix versions. Each source degrades independently — counts-based sections still render when
  GitLab/OSV are unreachable.
- **`src/index.ts`** — the `Rib`: four `views` descriptors, four contributed workflows that
  publish to them (each `validate`d fail-closed through `canvasViewSchema`), a **`CIMPL`
  surface** that lays the three lane boards out side by side, and an `authStatus` probe for the
  kubectl context.

No data is produced in rib code — the UI's data comes from running a workflow. The
`osdu-quality` and `osdu-activity` CLIs must be on `PATH` (e.g. `~/.local/bin`) and
authenticated (they fall back to `glab auth`, so no token wrangling in the common case).

## Develop against a local Keelson

```bash
bun install
bun link @keelson/shared        # resolves the contract from your local keelson checkout
                                # (or rely on the symlink dev/link.ts manages)

bun test            # pure builder coverage (topology + quality + features + security)
bun run typecheck
bun run check       # biome lint + format

# Wire the rib into a local Keelson checkout (defaults to ../keelson; override with KEELSON_DIR):
bun run link:keelson
cd ../keelson && KEELSON_RIBS=osdu bun dev
```

Then open `http://127.0.0.1:5173` → **Ribs** → run a workflow (from the Workflows surface or
`keelson workflow run osdu-topology` / `osdu-quality` / `osdu-features` / `osdu-security`) →
open **Cluster Topology**, **Quality**, **Features**, or **Security**.

Smoke-test the collectors directly:

```bash
bun run collect:topology | jq .
bun run collect:quality | jq .   # shells `osdu-quality release --output json`
bun run collect:features | jq .  # shells `osdu-activity epic list` + `mr --output json`
bun run collect:security | jq .  # `osdu-quality release` + `glab` group vulns + OSV fixes
```

## Distribution

For a real install (`bun add @keelson/rib-osdu`), both this package and `@keelson/shared`
must be published to a registry. `@keelson/shared` is already configured to publish; the
dev loop above needs no registry.

## Roadmap

The generic `board` view kind (gap **G1**, with cell tone **G0** and card link/copy **G2**) and the
top-level **surface** (gap **G4** — a primary nav tab of region-bound boards) have landed in the
Keelson base; **Quality**, **Features**, and **Security** render as boards and now compose into one
**CIMPL** surface. Still ahead: the **Release Train**, **Waiting on You**, and **Current Events**
boards (which fill out the surface's banner/footer regions), and the **Cluster ICC** (which also
needs the rib-action round-trip, gap **G3**). Each lane wraps an existing OSDU/CIMPL
CLI (`osdu-quality`, `osdu-activity`, `cimpl info`) plus public CVE lookups (GitLab/OSV) — no
reimplemented analyzers, no resident sidecar.
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the gap taxonomy.

## License

Apache-2.0.
