---
title: Tools and actions
description: "The chat tools the rib registers and the Cluster board action verbs, with the guard each one passes before touching the cluster."
sidebar:
  order: 5
---

The rib exposes its data layer twice: as boards on the CIMPL surface, and
as chat tools over the same sources. It also handles the action verbs the
Cluster board dispatches. This page is the contract for both, guard by
guard.

## Read tools

Ten read-only tools, each returning the live rows behind a board rather
than the board itself:

| Tool | Returns |
|---|---|
| `osdu_cluster` | kubectl context, Flux and HelmRelease readiness, sanitized `cimpl info` access data. Passwords are never returned. |
| `osdu_contexts` | The current kubectl context plus the cimpl-managed contexts on the machine, prefix-filtered. |
| `osdu_setup_check` | The `cimpl check --json` cluster-CLI inventory, optionally scoped by provider. |
| `osdu_topology` | The live Flux Kustomizations: name, namespace, ready conditions, dependencies. |
| `osdu_quality` | The `osdu-quality release` report: per-service pass rates, coverage, Sonar grades, vuln counts. |
| `osdu_features` | Core-scoped epics with assignees and progress, plus open merge requests. |
| `osdu_security` | Per-service Sonar security ratings, per-CVE dependency detail, OSV fix versions, open vulnerability MRs. |
| `osdu_events` | Newest-first open and merged MRs (PLATFORM) and recent kubectl jobs (CLUSTER). |
| `osdu_release` | The active milestone, open release MRs, and recently merged core MRs. |
| `osdu_waiting` | Your priority-sorted queue: MRs needing you, not-ready Flux resources, failed jobs. |

Two of them take arguments that scope the read, which is also how you narrow
a result that would otherwise overflow the cap below: `osdu_quality` and
`osdu_security` accept an optional `service` (named core service slugs, with
an unrecognized name refused rather than silently ignored), and
`osdu_security` also accepts an optional `severity`. `osdu_setup_check`
takes an optional `provider`. The rest take no arguments, and each tool's
overflow hint says which is true of it, so a caller is never told to narrow
a request it has nothing to narrow with.

`osdu_security` names two different things deliberately, because conflating
them reads as a contradiction: `sonar_security_rating` is SonarCloud's
static-analysis grade for a service's **own** code, while
`dependency_vulnerabilities` counts CVEs in what it **depends on**. The
grade says nothing about those CVEs, so a service can rate A and still
carry criticals.

Behavioral contract, shared by all ten:

- **Never throws.** A degraded source surfaces as an error tool result, and
  partial degradation rides along in a `notes` array next to the data. One
  exception: `osdu_contexts` has nothing partial to report, so an
  unavailable kubectl degrades to a successful, empty
  `{ current: null, contexts: [] }` with no `notes`. Read it as "no
  cimpl-managed contexts found," not as proof that kubectl answered.
- **Bounded output.** Results are compact JSON capped at 16,000 characters.
  A tool that can overflow bounds its own payload first: it orders rows
  worst-first, keeps the largest prefix that fits, and reports how many
  matched versus how many came back in its counts and `notes`. If a result
  still exceeds the cap, the tool returns a valid error envelope naming the
  size and how to narrow the request, never a truncated slice. The reader
  is a model, and JSON cut at a byte boundary does not parse, so slicing
  would cost it the whole result rather than just the tail.

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

The Cluster board dispatches seven verbs to the rib's `onAction` handler.
Five of them pass the cluster-stamp guard first: the action's captured
context (and fingerprint, when captured) must match the live kubectl
context, or the action is refused with a refresh-and-retry error. See
[Guardrails](../../concepts/guardrails/) for the stamp's mechanics.

| Action | Runs | Stamp guard | Extra gate | Timeout |
|---|---|---|---|---|
| `reconcile` | `cimpl reconcile` | yes | none | 2 min |
| `suspend` | `cimpl reconcile --suspend` | yes | none | 2 min |
| `resume` | `cimpl reconcile --resume` | yes | none | 2 min |
| `delete` | launches `osdu-cluster-delete`, which re-checks context and then runs `cimpl down --provider current-context` | yes | UI destructive confirm + a fresh `verifyCimplContext` probe | 10 min on the `down` node |
| `reveal-credential` | `cimpl info --json --show-secrets` | yes | rejects advisory values (`hasRealSecret`) | 1 min |
| `create` | launches `osdu-cluster-create`, which runs `cimpl up` with the chosen inputs | no, by design | a `refuseCreateOverCimpl` preflight + an in-flight dispatch marker | 50 min on the `provision` node |
| `switch-context` | `kubectl config use-context` | no, by design | its own target, staleness, and fingerprint chain | 5 s |

### The two verbs that skip the stamp

`create` and `switch-context` are handled **before** the stamp guard, and
not as an exemption. The guard asks "is the board still looking at the
cluster you are about to touch," and neither verb can answer it: `create`
runs when there is no current cluster to stamp, and `switch-context`
deliberately changes which cluster is current. Each carries its own gate
instead.

`create` cannot clobber a live deployment. A bounded `refuseCreateOverCimpl`
probe fires the workflow only when `cimpl` confirms **no** deployment on the
context; a live one refuses, and so does an indeterminate probe. A dispatch
marker in the rib's data dir refuses a second create while one is in flight.

`switch-context` runs its own chain before touching your kubeconfig: it
refuses a target that is not cimpl-managed, a target that has since
vanished, a stale `observedCurrent` (the current context moved since the
board loaded), and a fingerprint that drifted (the current cluster was
recreated under the same name).

Delete streams its teardown in the Workflows tab, like Create. The workflow
re-checks the CIMPL context in its first node before the 10 min `down` node
starts. The long timeout is deliberate: teardown waits on Flux pruning and
namespace termination, and aborting mid-flight would leave the cluster
half-removed.

`reveal-credential` is a read, not a mutation: it re-fetches one service's
password and returns it to the caller for a clipboard copy. The secret is
never written to a snapshot, logged, or persisted, and a `cimpl` advisory
value (an `n/a` placeholder or a `(MISMATCH)` warning) is refused rather
than copied.

## Related

- [Guardrails](../../concepts/guardrails/): the identity guard and secret
  handling these verbs enforce.
- [Surface](../surface/): where the Cluster board and its actions live in
  the layout.
- [Snapshot keys](../snapshot-keys/): the published views these tools
  mirror as raw data.
