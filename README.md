# @keelson/rib-osdu

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Keelson Rib](https://img.shields.io/badge/Keelson-rib-1e3a5f.svg)](https://github.com/danielscholl/keelson)
![Status: Early design](https://img.shields.io/badge/status-early%20design-orange.svg)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh/)

**The OSDU / CIMPL bridge for [Keelson](https://github.com/danielscholl/keelson).**

This rib turns your OSDU CIMPL cluster into live views inside Keelson — cluster
health and lifecycle, Flux topology, and platform-health lanes for quality,
features, security, the release train, your review queue, and recent events.
Each view is fed by a deterministic workflow whose structured output drives a
canvas snapshot. The harness stays domain-free: all OSDU and cluster knowledge
lives in the rib, and it ships **zero React** into the trusted SPA.

> Full documentation:
> **[danielscholl.github.io/keelson-rib-osdu](https://danielscholl.github.io/keelson-rib-osdu/)**.

## What it adds

Nine views, each backed by a workflow. Seven compose into the **CIMPL** nav
surface; Topology and Doctor render from the Ribs page.

| View | Source | Shows |
|---|---|---|
| **Cluster** | `cimpl info`, kubectl Flux | health pill, lifecycle, actions, access grid + copy-on-reveal credentials |
| **Waiting on You** | `glab` dashboard MRs, kubectl | your priority-sorted queue |
| **Release Train** | `osdu-activity` mr / epic | active milestone, new MR queue, platform wins |
| **Features** | `osdu-activity` epic / MR | epic and MR activity board |
| **Quality** | `osdu-quality release` | per-service quality board |
| **Security** | `osdu-quality` + GitLab / OSV | CVE and remediation board |
| **Current Events** | `osdu-activity` mr / epic, kubectl jobs | newest-first platform and cluster motion |
| **Topology** | kubectl Flux Kustomizations | dependency graph |
| **Cluster Doctor** | `cimpl check` | installed vs missing cluster CLI tools |

Three design choices keep it honest:

- **No sidecar** — every view is gathered through one-shot CLI invocations, nothing resident.
- **No domain logic in Keelson** — OSDU and CIMPL knowledge stays in the rib.
- **No trusted React from the rib** — views render through Keelson's canvas primitives.

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

Open `http://127.0.0.1:7878` → the **CIMPL** surface. It refreshes its regions on
their own cadences while the tab is open; to collect one on demand:

```bash
keelson workflow run osdu-cluster    # Cluster
keelson workflow run osdu-waiting    # Waiting on You
keelson workflow run osdu-release    # Release Train
keelson workflow run osdu-features   # epic / MR activity
keelson workflow run osdu-quality    # quality board
keelson workflow run osdu-security   # CVE board
keelson workflow run osdu-events     # Current Events
keelson workflow run osdu-topology   # dependency graph
keelson workflow run osdu-doctor     # local CLI toolchain
```

The CIMPL surface composes the lanes into one nav tab, with the Cluster board as
its collapsible header.

## How it works

Each view is fed by a contributed workflow whose single node prints a canvas-view
JSON object. Because the node declares `output_schema`, the executor promotes its
stdout to structured output, which the rib publishes (fail-closed, through
`canvasViewSchema`) to the `rib:osdu:*` snapshot key the view is bound to:

```
osdu-cluster    →  collect-cluster.ts    →  board view  →  rib:osdu:cluster   →  "Cluster"
osdu-waiting    →  collect-waiting.ts    →  board view  →  rib:osdu:waiting   →  "Waiting on You"
osdu-release    →  collect-release.ts    →  board view  →  rib:osdu:release   →  "Release Train"
osdu-features   →  collect-features.ts   →  board view  →  rib:osdu:features  →  "Features"
osdu-quality    →  collect-quality.ts    →  board view  →  rib:osdu:quality   →  "Quality"
osdu-security   →  collect-security.ts   →  board view  →  rib:osdu:security  →  "Security"
osdu-events     →  collect-events.ts     →  board view  →  rib:osdu:events    →  "Current Events"
osdu-topology   →  collect-topology.ts   →  graph view  →  rib:osdu:topology  →  "Cluster Topology"
osdu-doctor     →  collect-doctor.ts     →  board view  →  rib:osdu:doctor    →  "Cluster Doctor"
```

Each collector is a thin Bun script that shells a domain CLI and shapes its
output with a pure builder — no domain logic in the rib glue, no analyzer
reimplemented. Two further workflows act rather than publish: `osdu-cluster-create`
(`cimpl up`) and `osdu-cluster-delete` (`cimpl down`), both streaming in the
Workflows tab.

The Cluster board also wires in-board **actions** (Reconcile / Suspend / Resume /
Delete / Create / Switch context → `cimpl` and `kubectl`, plus a
`reveal-credential` action that re-fetches one password on demand so secrets
never enter the board snapshot). Every mutating verb is identity-guarded against
the live cluster; see
[Guardrails](https://danielscholl.github.io/keelson-rib-osdu/concepts/guardrails/).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the shape of the pipeline
and [the reference tier](https://danielscholl.github.io/keelson-rib-osdu/reference/)
for the full contract.

## Develop locally

```bash
bun install
bun link @keelson/shared   # resolve the contract from your local keelson checkout

bun test                   # pure builder coverage (topology / quality / features / security / …)
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
bun run collect:doctor | jq .     # cimpl check --json
bun run collect:topology | jq .
bun run collect:quality | jq .    # osdu-quality release --output json
bun run collect:features | jq .   # osdu-activity epic list + mr --output json
bun run collect:security | jq .   # osdu-quality release + glab group vulns + OSV fixes
bun run collect:waiting | jq .    # your GitLab queue + cluster readiness
```

## Scope

This rib surfaces CIMPL **platform delivery and operations** — cluster health and
Flux topology, release quality, epic/MR activity, and CVE remediation — as live
Keelson boards over the OSDU/CIMPL CLIs it already wraps.

The OSDU **data plane** (storage records, schemas, search, entitlements, legal
tags) is deliberately **out of scope**. That surface is reached through direct
OSDU platform API access (authenticated gateway calls), not through this rib — so
the rib stays a thin, sidecar-free view over delivery/ops and does not become a
general OSDU query engine.

## Acknowledgments

This rib stands on OSDU community tooling. It bundles none of it; its collectors
shell these CLIs (installed on `PATH`) and shape their JSON into generic,
domain-free Keelson views:

- **[CIMPL Stack](https://community.opengroup.org/osdu/platform/deployment-and-operations/cimpl-stack)**
  (Apache-2.0): the `cimpl` CLI behind the **Cluster** and **topology** —
  cluster bootstrap and Flux GitOps for OSDU on Kubernetes.
- **[AI DevOps Agent](https://community.opengroup.org/osdu/ui/ai-devops-agent/community)**
  (Apache-2.0): the `osdu-activity` and `osdu-quality` CLIs behind the
  **Quality**, **Features**, and **Security** lanes.

Full attribution lives in [NOTICE](NOTICE).

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for
third-party attribution.
