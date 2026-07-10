---
title: The collector pipeline
description: "How every panel gets its data: a workflow runs a thin collector that shells a domain CLI, a pure builder shapes the JSON, and the rib publishes it fail-closed."
sidebar:
  order: 2
---

Every panel on the CIMPL surface is produced the same way. One sentence
covers it: a contributed **workflow** runs a thin **collector** that shells
an OSDU or CIMPL **CLI**, a pure **builder** maps that JSON into a generic
canvas view payload, and the rib's snapshot binding publishes it, fail
closed, to a `rib:osdu:*` key the bound view renders live.

```text
osdu-quality release --output json        (CLI, handles its own auth)
   │  shelled by
bin/collect-quality.ts  ──►  src/quality.ts  (pure builder, JSON → view)
   │  printed to stdout; the node declares output_schema
workflow node (bash: bun …)  ──►  structured-output promotion (executor)
   │  bindSnapshotKey + validate (expectView, fail-closed)
snapshot key rib:osdu:quality
   │  view descriptor { key, canvasKind: "view" }
canvas renderer (live board in the SPA)
```

## The stages, and why each one is thin

**The workflow** is a single bash node. Its `description` follows the
`Use when / Triggers / Does / NOT for` shape so the catalog renders it
scannably, and its `output_schema` tells the executor to promote the node's
stdout to structured output. There is no YAML to edit; every workflow is
defined in code in the rib's `contributeWorkflows` hook.

**The collector** (`bin/collect-*.ts`) is a thin Bun script: spawn a CLI,
parse its JSON, hand it to a builder, print the result. Stdout carries
exactly one JSON object and nothing else; diagnostics go to stderr. When a
CLI is missing or the cluster is unreachable, the collector degrades to a
valid empty view rather than crashing, so a cold laptop still renders a
board instead of an error.

**The builder** (`src/*.ts`) is pure: no I/O, tested against captured
fixtures. All parsing and aggregation lives here, which is what keeps
domain logic out of the rib glue. The builders are near-ports of upstream
composers, ported rather than imported, so the rib bundles none of the
upstream code it credits.

**The binding** publishes the promoted output to the workflow's
`bindSnapshotKey` only after `validate` (Keelson's `expectView`) accepts it
as the declared view kind. A malformed payload fails the run instead of
publishing a broken board. See [Guardrails](../guardrails/) for why the
pipeline fails closed.

## What never appears in this pipeline

- **A resident process.** Every refresh is a one-shot CLI invocation on a
  cadence the surface declares; nothing stays running between refreshes.
- **Credentials.** The CLIs own their auth (`glab` login, kubeconfig,
  `cimpl` context); the rib passes no tokens and stores none.
- **React.** The payloads are Keelson's generic `board` and `graph` views;
  the harness renders them with its own trusted primitives.

## Related

- [Guardrails](../guardrails/): the guarantees layered on this pipeline.
- [Workflows](../../reference/workflows/): every workflow, its collector,
  and the CLI it shells.
- [Snapshot keys](../../reference/snapshot-keys/): the `rib:osdu:*` keys
  the pipeline publishes to.
- [Run the collectors](../../guides/run-the-collectors/): smoke-test any
  collector directly against your toolchain.
