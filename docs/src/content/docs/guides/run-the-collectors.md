---
title: Run the collectors
description: Smoke-test any collector directly from the shell, and read its degraded output when a CLI or the cluster is missing.
sidebar:
  order: 3
---

Every panel's data comes from a collector you can run by hand. When a lane
renders empty or stale, run its collector from the rib checkout and look at
the JSON: the answer is usually in the collector's own output, not in the
harness.

## Smoke-test a collector

Each collector prints exactly one canvas-view JSON object to stdout, so it
pipes cleanly into `jq`:

```bash
bun run collect:cluster | jq .    # cimpl info + kubectl readiness
bun run collect:topology | jq .   # Flux Kustomizations → graph
bun run collect:quality | jq .    # osdu-quality release
bun run collect:features | jq .   # osdu-activity epic + mr
bun run collect:security | jq .   # osdu-quality + glab vulns + OSV fixes
bun run collect:waiting | jq .    # your GitLab queue + cluster readiness
```

The events and release collectors have no package script yet; run them
directly:

```bash
bun bin/collect-events.ts | jq .
bun bin/collect-release.ts | jq .
```

A healthy collect ends with `"view": "board"` (or `"graph"` for topology)
at the top of the object, plus the sections the lane renders. This is the
exact payload the workflow publishes; if it looks right here, the panel
will look right in the SPA.

## Read a degraded collect

Collectors never crash on a missing CLI or an unreachable cluster. They
degrade to a valid empty view and explain themselves on stderr:

```text
[rib-osdu] topology degraded: kubectl: command not found
```

Stdout stays pure JSON either way, because the workflow executor promotes
stdout to structured output and a stray log line would corrupt the payload.
So when a panel is empty, run the collector and read **stderr** for the
why; the board itself will only tell you that there is nothing to show.

## The same thing, through the workflow

The collectors are exactly what the contributed workflows run. To exercise
the full pipeline, publish included:

```bash
keelson workflow run osdu-quality
```

The difference from the direct run: the executor checks the node's
`output_schema`, and the rib validates the payload (`expectView`) before
publishing it to the lane's snapshot key. A payload that passes `jq` but
fails validation fails the run rather than publishing; see
[Guardrails](../../concepts/guardrails/).

## Related

- [The collector pipeline](../../concepts/the-collector-pipeline/): the
  stages between the CLI and the board.
- [Workflows](../../reference/workflows/): which workflow runs which
  collector, and the CLI each one shells.
- [Install the rib](../install-the-rib/): the toolchain each collector
  expects on PATH.
