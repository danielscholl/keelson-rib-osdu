# Copilot code review — instructions for @keelson/rib-osdu

This rib is the **OSDU / CIMPL bridge** for
[Keelson](https://github.com/danielscholl/keelson), the local-only agent harness
— a single-package Bun + TypeScript project. It turns a live cluster into canvas
views (cluster health, Flux topology, quality / features / security lanes), each
fed by a deterministic collector that shells a domain CLI and shapes its output
with a pure builder. It ships **zero React**. See `AGENTS.md` for the full
architecture.

## How to review

Be terse and cite `file:line`. Prefer a few high-signal findings over breadth.
This is single-user, local software — ignore speculative scale, multi-tenant, and
micro-optimization concerns. No poems, jokes, or emoji.

## Comment policy — do NOT push comments or docstrings

`CONTRIBUTING.md` sets a deliberate **no-narration** policy. Do **not**:

- Ask for docstrings or comment coverage. Comments are optional; a one-line
  soft-wrap is fine and should not be flagged.
- Suggest comments that narrate what a PR changed, restate well-named code, or
  recap review history.

A comment is warranted only when it captures a non-obvious **why** (a hidden
constraint, a workaround, an order dependency, an invariant from another module).
Flag a comment only when it *violates* the policy (narration / what-just-changed),
not when one is merely absent.

## Invariants to flag when a change breaks them

- **Secrets never enter a snapshot.** This is the sharpest invariant. Credentials
  (`cimpl info --show-secrets` output, revealed passwords) are loopback-only —
  returned to the caller for a clipboard copy. Flag *any* code path that writes a
  secret into a published view/snapshot, logs it, persists it, or returns it
  somewhere other than the direct action result.
- **Cluster actions are identity-guarded.** Every action must match the live
  kubectl context (and fingerprint when captured) via `actionGuardError` before it
  runs; the irreversible Delete must re-verify a live CIMPL context
  (`verifyCimplContext`) first. Flag a new cluster action that skips the guard, or
  a destructive op without the pre-flight re-verification.
- **Exec is async + timeout-bounded.** Cluster/CLI calls go through `ctx.getExec()`
  (async) so a slow or unreachable cluster can't block the server event loop. Flag
  synchronous/blocking shelling (e.g. `execSync`, `spawnSync`), a missing timeout,
  or a destructive verb given too short a timeout to finish.
- **No domain logic in the rib glue; no reimplemented analyzers.** Collectors
  (`bin/**`) shell a domain CLI and shape its JSON with a pure builder. Flag
  parsing/aggregation/analysis added to the glue or a collector instead of a
  builder, or an analyzer reimplemented in-rib.
- **Zero React into the trusted SPA.** Views render through the canvas `board` /
  `graph` contract. Flag any hand-coded UI / React shipped from the rib.
- **Attach only through the `Rib` contract** (`@keelson/shared`). Flag reaching
  around it into harness internals, or a new hard dependency on a harness package
  beyond the `@keelson/shared` peer.
- **Fail closed.** Views publish through `validate` (`expectView`) and the
  workflow node's `output_schema`. Flag a producer that could emit an unvalidated
  or malformed view, or a path that publishes a broken board instead of failing
  the run.

## What NOT to flag

- Missing docstrings or comments (see the comment policy above).
- Tests (`test/**`) using `bun:test`, the JSON fixtures under `test/fixtures/`, or
  mock-vs-real tradeoffs — these are intentional.
- A collector shelling a CLI it doesn't bundle, or empty/degraded output when the
  toolchain or cluster is absent — the rib is designed to render empty offline.
- The absence of an abstraction — this repo avoids abstractions ahead of a
  concrete second caller.
