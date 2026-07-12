---
title: Tools and actions
description: "The chat tools the rib registers and the Cluster ICC action verbs, with the guard each one passes before touching the cluster."
sidebar:
  order: 5
---

The rib exposes its data layer twice: as boards on the CIMPL surface, and
as chat tools over the same sources. It also handles the action verbs the
Cluster ICC board dispatches. This page is the contract for both, guard by
guard.

## Read tools

Nine read-only tools, one per panel, each returning the live rows behind
the board rather than the board itself:

| Tool | Returns |
|---|---|
| `osdu_cluster` | kubectl context, Flux and HelmRelease readiness, sanitized `cimpl info` access data. Passwords are never returned. |
| `osdu_setup_check` | The `cimpl check --json` cluster-CLI inventory, optionally scoped by provider. |
| `osdu_topology` | The live Flux Kustomizations: name, namespace, ready conditions, dependencies. |
| `osdu_quality` | The `osdu-quality release` report: per-service pass rates, coverage, Sonar grades, vuln counts. |
| `osdu_features` | Core-scoped epics with assignees and progress, plus open merge requests. |
| `osdu_security` | Per-service security ratings, per-CVE detail, OSV fix versions, open vulnerability MRs. |
| `osdu_events` | Newest-first open and merged MRs (PLATFORM) and recent kubectl jobs (CLUSTER). |
| `osdu_release` | The active milestone, open release MRs, and recently merged core MRs. |
| `osdu_waiting` | Your priority-sorted queue: MRs needing you, not-ready Flux resources, failed jobs. |

Behavioral contract, shared by all nine:

- **Never throws.** A degraded source surfaces as an error tool result, and
  partial degradation rides along in a `notes` array next to the data.
- **Bounded output.** Results are compact JSON capped at 16,000 characters;
  truncation is signalled with an explicit marker, never silent.

## Lifecycle tools

Three state-changing tools dispatch the reversible cluster verbs:
`osdu_cluster_reconcile`, `osdu_cluster_suspend`, `osdu_cluster_resume`.
Each is double-gated:

1. **A `confirm` flag inside the tool.** Called without `confirm: true`,
   the tool runs nothing and reports what it would run and on which
   context. It expects confirmation only after the user explicitly
   approves.
2. **A fresh identity probe.** With `confirm: true`, the tool first runs
   `verifyCimplContext` (a live `cimpl info` probe); a context that is not
   a confirmed CIMPL deployment is refused.

There is deliberately **no `osdu_cluster_delete` tool**. Delete is
irreversible, so it exists only as a board action behind the UI's
destructive-confirm flow.

## Board actions

The Cluster ICC board dispatches five verbs to the rib's `onAction`
handler. Every one first passes the cluster-stamp guard: the action's
captured context (and fingerprint, when captured) must match the live
kubectl context, or the action is refused with a refresh-and-retry error.
See [Guardrails](../../concepts/guardrails/) for the stamp's mechanics.

| Action | Runs | Extra gate | Timeout |
|---|---|---|---|
| `reconcile` | `cimpl reconcile` | none | 2 min |
| `suspend` | `cimpl reconcile --suspend` | none | 2 min |
| `resume` | `cimpl reconcile --resume` | none | 2 min |
| `delete` | launches `osdu-cluster-delete`, which re-checks context and then runs `cimpl down --provider current-context` | UI destructive confirm + a fresh `verifyCimplContext` probe | 10 min on the `down` node |
| `reveal-credential` | `cimpl info --json --show-secrets` | rejects advisory values (`hasRealSecret`) | 1 min |

Delete now streams its teardown in the Workflows tab, like Create. The
workflow re-checks the CIMPL context in its first node before the 10 min
`down` node starts. The long timeout is deliberate: teardown waits on Flux
pruning and namespace termination, and aborting mid-flight would leave the
cluster half-removed.

`reveal-credential` is a read, not a mutation: it re-fetches one service's
password and returns it to the caller for a clipboard copy. The secret is
never written to a snapshot, logged, or persisted, and a `cimpl` advisory
value (an `n/a` placeholder or a `(MISMATCH)` warning) is refused rather
than copied.

## Related

- [Guardrails](../../concepts/guardrails/): the identity guard and secret
  handling these verbs enforce.
- [Surface](../surface/): where the Cluster ICC and its actions live in
  the layout.
- [Snapshot keys](../snapshot-keys/): the published views these tools
  mirror as raw data.
