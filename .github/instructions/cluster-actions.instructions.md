---
applyTo: "src/cluster*.ts"
---

The cluster lifecycle + credential code (`cluster.ts`, `cluster-actions.ts`) —
the most security-sensitive surface in the rib. It dispatches `cimpl` lifecycle
verbs and handles `cimpl info` output including credentials.

Flag here:

- A credential/secret that escapes the loopback path — written into a snapshot or
  view, logged, persisted, or returned anywhere other than the direct caller of a
  reveal action. `hasRealSecret` gates real values; don't widen what is returned.
- A cluster action that runs without the identity guard (`actionGuardError`
  matching the live kubectl context + fingerprint), or the irreversible Delete
  running without re-verifying a live CIMPL context (`verifyCimplContext`).
- Shelling `cimpl`/`kubectl` synchronously or without a timeout — calls go through
  the async exec surface; destructive verbs need a timeout long enough to finish
  (Delete waits minutes for Flux pruning), reversible ones a shorter one.
- Loosening `parseCimplInfoJson`'s tolerance in a way that would accept a wrong or
  ambiguous cluster identity.
