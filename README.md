# @keelson/rib-osdu

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Keelson Rib](https://img.shields.io/badge/Keelson-rib-1e3a5f.svg)](https://github.com/danielscholl/keelson)
![Status: Early design](https://img.shields.io/badge/status-early%20design-orange.svg)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh/)

**The OSDU / CIMPL bridge for [Keelson](https://github.com/danielscholl/keelson).**

This rib turns your OSDU CIMPL cluster into live views inside Keelson — cluster
health, Flux topology, and platform-health lanes for quality, features, and
security. Each view is fed by a deterministic workflow whose structured output
drives a canvas snapshot. The harness stays domain-free: all OSDU and cluster
knowledge lives in the rib, and it ships **zero React** into the trusted SPA.

> Status: **early / under active design.** The Cluster ICC, topology graph,
> Quality, Features, and Security boards work end-to-end. Release Train, Waiting
> on You, and Events are still planned. See [docs/PRD.md](docs/PRD.md) for scope
> and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works.

## What it adds

A **CIMPL** surface composed of five views, each backed by a workflow:

| View | Source | Shows |
|---|---|---|
| **Cluster ICC** | `cimpl info`, kubectl Flux | health pill, lifecycle, access grid + copy-on-reveal credentials |
| **Topology** | kubectl Flux Kustomizations | dependency graph |
| **Quality** | `osdu-quality release` | per-service quality board |
| **Features** | `osdu-activity` epic / MR | epic and MR activity board |
| **Security** | `osdu-quality` + GitLab / OSV | CVE and remediation board |

Three design choices keep it honest:

- **No sidecar** — every view is gathered through one-shot CLI invocations, nothing resident.
- **No domain logic in Keelson** — OSDU and CIMPL knowledge stays in the rib.
- **No trusted React from the rib** — views render through Keelson's canvas primitives.

## Scope

This rib surfaces CIMPL **platform delivery and operations** — cluster health and
Flux topology, release quality, epic/MR activity, and CVE remediation — as live
Keelson boards over the OSDU/CIMPL CLIs it already wraps.

The OSDU **data plane** (storage records, schemas, search, entitlements, legal
tags) is deliberately **out of scope**. That surface is served by the OSDU
platform API toolchain (the CIMPL Stack `osdu-api` tooling), reached directly
rather than wired into this rib — so the rib stays a thin, sidecar-free view over
delivery/ops and does not become a general OSDU query engine.

## Install into Keelson

Into an installed Keelson (the managed home at `~/.keelson`):

```bash
keelson rib add https://github.com/danielscholl/keelson-rib-osdu
keelson restart
```

## Requirements

`@keelson/shared` comes from the harness as a peer dependency (one shared copy).
Live data needs the OSDU toolchain on `PATH` — `cimpl`, `kubectl`,
`osdu-activity`, `osdu-quality`, `glab` — plus a reachable cluster and GitLab
auth (the CLIs fall back to your `glab` login, so no token wrangling in the
common case). Without them the rib still loads; its lanes just render empty.

## Try it

Open `http://127.0.0.1:7878` → the **CIMPL** surface, then run the workflows that
feed it:

```bash
keelson workflow run osdu-cluster    # Cluster ICC
keelson workflow run osdu-topology   # dependency graph
keelson workflow run osdu-quality    # quality board
keelson workflow run osdu-features    # epic / MR activity
keelson workflow run osdu-security   # CVE board
```

The CIMPL surface composes the lanes into one nav tab, with the Cluster ICC as
its collapsible header.

## How it works

Each view is fed by a contributed workflow whose single node prints a canvas-view
JSON object. Because the node declares `output_schema`, the executor promotes its
stdout to structured output, which the rib publishes (fail-closed, through
`canvasViewSchema`) to the `rib:osdu:*` snapshot key the view is bound to:

```
osdu-cluster    →  collect-cluster.ts    →  board view  →  rib:osdu:cluster   →  "Cluster ICC"
osdu-topology   →  collect-topology.ts   →  graph view  →  rib:osdu:topology  →  "Cluster Topology"
osdu-quality    →  collect-quality.ts    →  board view  →  rib:osdu:quality   →  "Quality"
osdu-features   →  collect-features.ts   →  board view  →  rib:osdu:features  →  "Features"
osdu-security   →  collect-security.ts   →  board view  →  rib:osdu:security  →  "Security"
```

Each collector is a thin Bun script that shells a domain CLI and shapes its
output with a pure builder — no domain logic in the rib glue, no analyzer
reimplemented. The Cluster ICC also wires in-board **actions**
(Reconcile / Suspend / Delete → `cimpl`, plus a `reveal-credential` action that
re-fetches one password on demand so secrets never enter the board snapshot).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the collector-by-collector
breakdown and the Keelson base gaps this rib depends on.

## Develop locally

```bash
bun install
bun link @keelson/shared   # resolve the contract from your local keelson checkout

bun test                   # pure builder coverage (topology + quality + features + security)
bun run typecheck
bun run check              # biome lint + format

# Wire into a local Keelson checkout (defaults to ../keelson; override with KEELSON_DIR):
bun run link:keelson
cd ../keelson && KEELSON_RIBS=osdu bun dev
```

Then open `http://127.0.0.1:5173` → the **CIMPL** tab (or **Ribs**). Smoke-test
the collectors directly:

```bash
bun run collect:cluster | jq .    # cimpl info + kubectl flux/helm readiness
bun run collect:topology | jq .
bun run collect:quality | jq .    # osdu-quality release --output json
bun run collect:features | jq .   # osdu-activity epic list + mr --output json
bun run collect:security | jq .   # osdu-quality release + glab group vulns + OSV fixes
```

## Roadmap

The Cluster ICC, topology, Quality, Features, and Security boards render today.
Still ahead: the **Release Train**, **Waiting on You**, and **Current Events**
boards that fill out the surface's banner and footer regions. Each lane wraps an
existing OSDU / CIMPL CLI plus public CVE lookups (GitLab / OSV) — no
reimplemented analyzers, no resident sidecar. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the gap taxonomy.

## Acknowledgments

This rib stands on OSDU community tooling. It bundles none of it; its collectors
shell these CLIs (installed on `PATH`) and shape their JSON into generic,
domain-free Keelson views:

- **[CIMPL Stack](https://community.opengroup.org/osdu/platform/deployment-and-operations/cimpl-stack)**
  (Apache-2.0): the `cimpl` CLI behind the **Cluster ICC** and **topology** —
  cluster bootstrap and Flux GitOps for OSDU on Kubernetes.
- **[AI DevOps Agent](https://community.opengroup.org/osdu/ui/ai-devops-agent/community)**
  (Apache-2.0): the `osdu-activity` and `osdu-quality` CLIs behind the
  **Quality**, **Features**, and **Security** lanes.

Full attribution lives in [NOTICE](NOTICE).

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
third-party attribution.
