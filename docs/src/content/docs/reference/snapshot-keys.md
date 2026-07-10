---
title: Snapshot keys
description: Every rib:osdu:* snapshot key, the workflow that publishes it, and what it renders.
sidebar:
  order: 3
---

The rib publishes eight snapshot keys, one per view. Each key is bound to
exactly one workflow, and that workflow is the only writer for the key.
This page is the key contract on its own; for how seven of the keys are
arranged into the CIMPL tab, see [Surface](../surface/).

All keys live under the `rib:osdu:*` namespace, which the harness's scoped
snapshot manager enforces: the rib cannot write outside it.

## The keys

| Key | Workflow | View kind | Canvas title | Renders |
|---|---|---|---|---|
| `rib:osdu:cluster` | `osdu-cluster` | `board` | Cluster ICC | Health pill, lifecycle rows, lifecycle actions, and the curated access grid with copy-on-reveal credentials. |
| `rib:osdu:topology` | `osdu-topology` | `graph` | Cluster Topology | The Flux Kustomization dependency graph, one node per Kustomization with its health as the badge. |
| `rib:osdu:quality` | `osdu-quality` | `board` | Quality | Pass/flaky/fail KPI tiles, the per-service Sonar table, and the test-performance block. |
| `rib:osdu:features` | `osdu-features` | `board` | Features | MR KPI tiles, mover cards with progress bars, and stalled rows with a why-flagged note. |
| `rib:osdu:security` | `osdu-security` | `board` | Security | Severity pulse and KPI tiles, low-rating cards, top offenders, aged criticals, and quick-win bumps. |
| `rib:osdu:events` | `osdu-events` | `board` | Current Events | Newest-first feed rows tagged PLATFORM (MR motion) or CLUSTER (jobs), with relative timestamps. |
| `rib:osdu:release` | `osdu-release` | `board` | Release Train | The active milestone chip, the new-MR queue, and the week's platform wins. |
| `rib:osdu:waiting` | `osdu-waiting` | `board` | Waiting on You | Your priority-sorted personal queue: MRs needing you and not-ready cluster resources. |

## Producer shape

All eight producers are the same shape: a deterministic bash collector (see
[The collector pipeline](../../concepts/the-collector-pipeline/)). No key
costs an agent turn to refresh, which is what lets the surface poll them on
fixed cadences.

Each binding validates fail-closed with `expectView(<key>, <kind>)`:
`rib:osdu:topology` must parse as a `graph` view and every other key as a
`board`, or the run fails and the key keeps its last good value.

## What a key never contains

`rib:osdu:cluster` is built from `cimpl info --show-secrets`, but the
collector discards every credential's password before building the board;
the snapshot carries only service names and usernames. The password is
fetched on demand by the `reveal-credential` action and returned to the
caller, never published. See [Guardrails](../../concepts/guardrails/).

## Related

- [Surface](../surface/): the regions and cadences these keys fill.
- [Workflows](../workflows/): the node-by-node shape of each publishing
  workflow.
- [Tools and actions](../tools-and-actions/): the chat tools that read the
  same sources these keys visualize.
