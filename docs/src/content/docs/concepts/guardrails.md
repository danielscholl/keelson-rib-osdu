---
title: Guardrails
description: "The four guarantees the rib holds when a board can act on a real cluster: secrets stay out of snapshots, actions are identity-guarded, exec is bounded, views fail closed."
sidebar:
  order: 3
---

Most of the rib is read-only, but the Cluster board can mutate a live
cluster (Reconcile, Suspend, Resume, Delete), create and switch between
clusters, and reveal credentials. Four guarantees hold on that surface, and
each one is enforced in code rather than by convention.

## Secrets never enter a snapshot

`cimpl info --show-secrets` returns each credential's password. The
collector discards it: `sanitizeCimplInfo` keeps only the service name and
username, so a plaintext secret never crosses into a published board, a
chat tool result, a log line, or anything persisted.

The board still offers a copy button per credential. Pressing it dispatches
the `reveal-credential` action, which re-fetches that one password on
demand and returns it straight to the caller (loopback) for the clipboard
copy. The secret exists only in that response.

A reveal also refuses advisory values. `cimpl` sometimes prints an
advisory string instead of a usable secret (`n/a` placeholders during
partial deployments, or a `(MISMATCH)` warning when a credential drifted);
`hasRealSecret` rejects those, so a broken value never reaches your
clipboard and never gets a copy affordance in the first place.

## Cluster actions are identity-guarded

`cimpl` always acts on the live kubectl current-context, so a stale board
must never mutate whatever cluster happens to be current. Every action a
board emits carries a **cluster stamp**: the context name and, when
readable, a stable fingerprint (the `kube-system` namespace UID) captured
at collection time. Before a stamped action runs, `actionGuardError`
checks:

- a stamp with no captured context is refused outright;
- a context-name change since the board loaded is refused (drift);
- a fingerprint change is refused when one was captured, which catches the
  context-name-reuse case: `cimpl down && cimpl up` yields the same name
  but a new UID.

Delete gets a second gate. A context can match and still not be a live
CIMPL deployment, so `verifyCimplContext` runs a fresh `cimpl info` probe
before the teardown; a non-CIMPL context fails the probe and the Delete is
refused. Without this, `cimpl down` would remove fixed namespaces from
whatever cluster is current. The chat lifecycle tools, which have no board
stamp to guard against, use the same fresh probe as their identity check.

Two verbs run before the stamp check, because the question it asks does not
apply to them. `create` runs when there is no current cluster to stamp, and
`switch-context` exists precisely to change which cluster is current;
guarding either against "the context must not have changed" would refuse
the verb's own purpose. Neither is ungated. `create` fires only when a
bounded probe confirms **no** CIMPL deployment on the context, so it cannot
clobber a live one, and an in-flight dispatch marker refuses a double
create. `switch-context` refuses a non-cimpl target, a vanished target, a
current context that moved since the board loaded, and a fingerprint that
drifted. The guarantee is that every verb is gated on the question that can
actually catch its failure, not that every verb runs the same check.

## Exec is async and timeout-bounded

Every CLI call routes through the harness's async exec surface
(`ctx.getExec()`), so a slow or unreachable cluster cannot block the
server event loop. Timeouts scale with the verb rather than sharing one
number: a kubeconfig edit gets seconds, reads and reversible verbs get
about two minutes, Delete gets ten because teardown waits on Flux pruning
and namespace termination, and Create gets fifty because a cloud create
provisions a managed cluster and then waits for Flux to converge. The
ceiling is picked to outlast a legitimate slow run, since a timeout that
fires early kills real work instead of catching stuck work.

## Views fail closed

Two validators sit between a collector and a published board. The workflow
node's `output_schema` gates the stdout-to-structured promotion, and the
binding's `validate` (`expectView`) parses the payload as the declared
view kind before publishing. A malformed view fails the workflow run; the
last good snapshot stays up instead of a broken board replacing it.

## Related

- [The collector pipeline](../the-collector-pipeline/): the pipeline these
  guarantees are layered on.
- [Tools and actions](../../reference/tools-and-actions/): every action
  verb and chat tool, with the guards each one passes.
- [Surface](../../reference/surface/): where the Cluster board sits in the
  CIMPL layout.
