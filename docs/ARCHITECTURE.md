# Architecture — `@keelson/rib-osdu`

> This file is a short pointer. The authoritative architecture lives in the
> published documentation, which tracks the shipped rib:
> **[danielscholl.github.io/keelson-rib-osdu](https://danielscholl.github.io/keelson-rib-osdu/)**.

This rib is the OSDU / CIMPL bridge: it turns a live OSDU CIMPL cluster into
canvas views inside Keelson — cluster health and access, the Flux dependency
graph, and platform-health lanes for quality, features, security, the release
train, your review queue, and recent events. Keelson owns the deterministic
half (the workflow engine, the snapshot store, the canvas renderer); this rib
adds the OSDU knowledge and ships no React into the trusted SPA.

## The pipeline (one sentence)

A contributed **workflow** runs a thin **collector** that shells an OSDU/CIMPL
**CLI**, a pure **builder** maps that JSON into a generic **canvas view**
payload, the node's `output_schema` promotes its stdout to structured output,
and the rib's **snapshot binding** publishes it — fail-closed via `expectView`
— to a `rib:osdu:*` key the bound view renders live.

```
osdu-quality release --output json        (CLI — handles its own auth)
   │  shelled by
bin/collect-quality.ts  ──►  src/quality.ts  (pure builder, JSON → view payload)
   │  printed to stdout, node declares output_schema
workflow node (bash: bun …)  ──►  text→structured promotion (executor)
   │  rib bindSnapshotKey + validate (expectView, fail-closed)
snapshot key  rib:osdu:quality
   │  view descriptor { key, canvasKind: "view" }
canvas renderer (live board in the SPA)
```

No domain logic lives in rib *glue*: collectors shell a CLI and own the side
effects, builders are pure and tested against captured fixtures. Nine
collectors follow this shape; two further workflows act (`cimpl up`,
`cimpl down`) and publish nothing.

## Where the architecture is documented

| Tier | What it covers |
|---|---|
| [Concepts](https://danielscholl.github.io/keelson-rib-osdu/concepts/) | The model: the collector pipeline, and the guardrails that hold when a board can act on a real cluster. |
| [Guides](https://danielscholl.github.io/keelson-rib-osdu/guides/) | Task recipes: install and configure the rib, smoke-test the collectors, develop against a local Keelson. |
| [Reference](https://danielscholl.github.io/keelson-rib-osdu/reference/) | The exact contract: the CIMPL surface and its cadences, the nine `rib:osdu:*` snapshot keys, the eleven workflows, and the chat tools and board actions with their guards. |
| [Design](https://danielscholl.github.io/keelson-rib-osdu/design/) | Decision records, and the Keelson base gaps the rib was built against. |

Build the docs locally with `cd docs && bun install && bun run build`.

## The invariants

These are the load-bearing ones; the [Guardrails](https://danielscholl.github.io/keelson-rib-osdu/concepts/guardrails/)
page is authoritative.

- **Zero React into the trusted SPA.** Views render through the canvas `board`
  and `graph` contract.
- **Attach only through the `Rib` contract** (`@keelson/shared`).
- **Secrets never enter a snapshot.** The cluster collector sanitizes
  `cimpl info --show-secrets` before building the board; a revealed credential
  is loopback-only.
- **Cluster actions are identity-guarded.** Every mutating verb matches the live
  kubectl context and fingerprint; Delete re-verifies a live CIMPL context and
  Create refuses over one.
- **Exec is async and timeout-bounded**, so a slow cluster cannot block the
  server event loop.
- **Fail closed.** A malformed view fails the run rather than publishing.

## Lineage

The rib re-expresses the OSDU CIMPL "bridge" — an operator dashboard that
existed in the `cimpl-agent` fork as hand-coded React in the trusted SPA, with
OSDU section names baked into the shared contract. The same surfaces are now
data produced by workflows and rendered by generic, domain-free Keelson views,
so the harness carries zero OSDU knowledge.

It bundles none of the tooling it credits: its collectors shell the `cimpl`,
`osdu-activity`, and `osdu-quality` CLIs from the CIMPL Stack and the AI DevOps
Agent, and its builders are near-ports of that project's pure composers —
ported, never imported. Full attribution lives in [NOTICE](../NOTICE).

The base-gap analysis that sequenced the initial build (`G0`–`G4`, all since
shipped) is preserved as a historical record in
[design/base-gaps-history.md](./design/base-gaps-history.md).
