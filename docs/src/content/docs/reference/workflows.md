---
title: Workflows
description: The eleven workflows the rib contributes, including nine collectors and two action-only cluster lifecycle workflows.
sidebar:
  order: 4
---

The rib contributes eleven workflows to the catalog, all defined in code in
its `contributeWorkflows` hook, so there are no YAML files to edit. Nine
refresh views with a single bash node (`collect`) that runs a
`bin/collect-*.ts` script. Each has an `output_schema` that promotes the
script's stdout to structured output, a `bindSnapshotKey`, and a
fail-closed `validate` (`expectView`). None costs an agent turn; a refresh
is free.

The other two workflows perform cluster lifecycle actions. They stream
their command output in the Workflows surface and do not publish
snapshots.

Each workflow ships a description in the `Use when / Triggers / Does / NOT
for` shape, so the catalog and the surface render it scannably.

## The eleven

| Workflow | Shape | Shells | Builder or result |
|---|---|---|---|
| `osdu-cluster` | `collect-cluster.ts` | `cimpl info --json` + kubectl readiness | `src/cluster.ts` |
| `osdu-doctor` | `collect-doctor.ts` | `cimpl check --json` | `src/setup.ts` |
| `osdu-topology` | `collect-topology.ts` | `kubectl get kustomizations` | `src/topology.ts` |
| `osdu-quality` | `collect-quality.ts` | `osdu-quality release --output json` | `src/quality.ts` |
| `osdu-features` | `collect-features.ts` | `osdu-activity` epic + mr | `src/features.ts` |
| `osdu-security` | `collect-security.ts` | `osdu-quality release` + `glab` vulns + OSV | `src/security.ts` |
| `osdu-events` | `collect-events.ts` | `osdu-activity` mr + epic, `kubectl get jobs` | `src/events.ts` |
| `osdu-release` | `collect-release.ts` | `osdu-activity` mr + epic | `src/release.ts` |
| `osdu-waiting` | `collect-waiting.ts` | `glab` (your MRs) + kubectl Flux/jobs | `src/waiting.ts` |
| `osdu-cluster-create` | `provision` action node | `cimpl up` with the selected cluster inputs | Streams the create operation; no snapshot |
| `osdu-cluster-delete` | `verify` then `down` action nodes | live CIMPL context verifier, then `cimpl down --provider current-context` | Streams the delete operation; no snapshot |

Each collector workflow runs its script by absolute path, resolved at
module load, so a run publishes the right script regardless of the run's
working directory.

Create has one `provision` node with a 50 minute timeout. The ceiling is
deliberate: a cloud create provisions the managed cluster and then waits on
Flux to converge, which can run most of an hour, so a shorter timeout kills
legitimate runs rather than catching stuck ones.

Delete first runs the `verify` node with a 1 minute timeout. Its dependent
`down` node starts only after verification succeeds and has a 10 minute
timeout for Flux pruning and namespace termination.

## What each one is for

| Workflow | Use when | NOT for |
|---|---|---|
| `osdu-cluster` | Checking the deployment's health and access: is the cluster up, where is Airflow or the portal, or choosing a kube-context. | Bypassing typed confirmations or identity guards. |
| `osdu-doctor` | Checking whether the local cluster-CLI toolchain is ready to deploy: what is installed, what is missing. | Installing tools or changing cluster state. |
| `osdu-topology` | Checking cluster reconciliation health as a dependency graph. | Changing cluster state. |
| `osdu-quality` | Reviewing platform release quality: pass rates, Sonar grades, coverage. | Changing pipelines or merging. |
| `osdu-features` | Tracking delivery: what is moving, what is stalled, open MRs. | Merging or editing MRs. |
| `osdu-security` | Reviewing security posture: critical CVEs, aged criticals, quick wins. | Patching or merging dependency MRs. |
| `osdu-events` | Catching up on recent platform and cluster motion. | Changing cluster state or merging MRs. |
| `osdu-release` | Tracking the active release: what is queued, what shipped this week. | Merging MRs or changing the release. |
| `osdu-waiting` | Checking what needs your personal attention, priority-sorted. | Merging, approving, or reconciling. |
| `osdu-cluster-create` | Provisioning a new CIMPL development cluster from the Cluster board. | Reconciling, deleting, or switching an existing cluster. |
| `osdu-cluster-delete` | Tearing down the current CIMPL development cluster after the Cluster board identity guard and typed confirmation pass. | Bypassing the Cluster board guard or deleting an unverified context. |

## Validation

Every collector node declares an `output_schema` requiring `view` and
`sections` (`view`, `nodes`, and `edges` for `osdu-topology`), and every
snapshot binding validates with `expectView`: `osdu-topology` must publish
a `graph`, the rest a `board`. A payload that fails either gate fails the
run instead of publishing; the bound key keeps its last good snapshot.
The action-only workflows have no snapshot binding or view payload.

## Related

- [The collector pipeline](../../concepts/the-collector-pipeline/): the
  shared shape of the nine collector workflows, stage by stage.
- [Snapshot keys](../snapshot-keys/): the key each workflow publishes.
- [Surface](../surface/): the cadence each workflow runs on while the
  CIMPL tab is open.
- [Run the collectors](../../guides/run-the-collectors/): run any
  collector by hand, outside the workflow.
