---
applyTo: "bin/**"
---

Deterministic collectors — thin Bun scripts that feed the canvas views. Each
shells one domain CLI (`cimpl`, `kubectl`, `osdu-activity`, `osdu-quality`,
`glab`) and shapes its JSON with a **pure builder** from `src/`, then prints one
canvas-view object on stdout.

Flag in this directory:

- Domain logic, parsing, or aggregation done inline instead of delegated to a
  pure builder in `src/` — collectors orchestrate I/O; builders compute.
- A reimplemented analyzer — shell the upstream CLI, don't reproduce its logic.
- A secret (password, token, `--show-secrets` field) printed to stdout, since the
  collector's stdout becomes a published snapshot.
- An unbounded or missing timeout on a CLI invocation, or output that isn't a
  valid view object on the happy path (it must publish fail-closed downstream).
- A collector that throws instead of emitting an empty/degraded-but-valid view
  when the toolchain or cluster is unavailable.
