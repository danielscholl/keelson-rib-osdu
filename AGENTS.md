# AGENTS.md

This is the canonical project guidance for coding agents — Codex, GitHub
Copilot's coding agent, and (via an import in `CLAUDE.md`) Claude Code — working
in this repository. `CONTRIBUTING.md` is the authoritative human guide; this is
its agent-facing distillation.

## What this is

`@keelson/rib-osdu` is a **rib** (extension) for
[Keelson](https://github.com/danielscholl/keelson), the local-only agent harness.
A rib is a standalone package the harness discovers at runtime and attaches
through one typed contract — the `Rib` interface from `@keelson/shared`. This rib
is the **OSDU / CIMPL bridge**: it turns a live OSDU CIMPL cluster into canvas
views inside Keelson — cluster health, Flux topology, and platform-health lanes
for quality, features, and security. The harness stays domain-free; all OSDU and
cluster knowledge lives here, and the rib ships **zero React** into the trusted
SPA.

## Commands

Bun. Everything is workspace-local; there is no monorepo.

```bash
bun install                  # one-time
bun link @keelson/shared     # resolve the Rib contract from a local keelson checkout

bun test                     # pure builder coverage (topology / quality / features / security / …)
bun run typecheck            # tsc --noEmit (needs @keelson/shared linked)
bun run check                # Biome lint + format (required pre-PR)
bun run check:fix            # auto-fix safe lint/format

bun run link:keelson         # symlink this rib into ../keelson (override with KEELSON_DIR)
cd ../keelson && KEELSON_RIBS=osdu bun dev   # exercise it in a running harness

# Smoke-test a collector against the live toolchain (cimpl / kubectl / glab on PATH):
bun run collect:cluster | jq .   # also: collect:topology / :quality / :features / :security / :waiting
```

`CONTRIBUTING.md` gates every PR on `bun run check`, `bun run typecheck`, and
`bun test` all green. CI resolves `@keelson/shared` as a symlink to a
`danielscholl/keelson` checkout's `packages/shared` from `main`, so a harness
contract change that breaks this rib turns CI red here.

## Architecture

The whole rib is one `Rib` object exported from `src/index.ts`. It contributes a
**CIMPL** nav surface composed of eight views, each bound to a `rib:osdu:*`
snapshot key and fed by a deterministic workflow:

- **Views + the surface** — `cluster` (ICC), `topology` (graph), `quality`,
  `features`, `security`, `events`, `release`, `waiting`. The Cluster ICC is the
  collapsible header; the rest fill the banner / rows / footer regions. No
  hand-coded UI: every view is a board (or graph) a workflow publishes.
- **Workflows** (`contributeWorkflows`) — one per view (`osdu-cluster`,
  `osdu-topology`, …). Each is a single node that runs a **collector** in `bin/`
  (`collect-*.ts`); the node declares `output_schema`, so the executor promotes
  the collector's stdout to structured output, which the rib publishes fail-closed
  through `validate` (`expectView`) to the bound key.
- **Collectors + builders** — a collector is a thin Bun script that shells a
  domain CLI (`cimpl`, `kubectl`, `osdu-activity`, `osdu-quality`, `glab`) and
  shapes its JSON with a **pure builder** (`src/topology.ts`, `quality.ts`,
  `features.ts`, `security.ts`, …). No domain logic in the rib glue; no analyzer
  reimplemented.
- **Actions** (`onAction`) — the Cluster ICC's lifecycle verbs
  (Reconcile / Suspend / Resume / Delete) dispatch to `cimpl` via the async exec
  surface; `reveal-credential` re-fetches one password and returns it to the
  caller (loopback) for a clipboard copy.
- **Tools** (`registerTools`) — the OSDU domains exposed as chat tools (the same
  data layer the panels visualize) plus the reversible cluster verbs.

### Invariants worth protecting

- **Zero React into the trusted SPA.** Views render through the canvas `board` /
  `graph` contract, never hand-coded UI shipped from the rib.
- **Attach only through the `Rib` contract** (`@keelson/shared`). Don't reach
  around it into harness internals.
- **No domain logic in the rib glue; no reimplemented analyzers.** Collectors
  shell the domain CLIs and shape output with pure builders — parsing/aggregation
  stays in the builders, side effects in the collectors.
- **Secrets never enter a snapshot.** `cimpl info --show-secrets` output and
  revealed credentials are loopback-only (returned to the caller); they are never
  written into a published view, logged, or persisted.
- **Cluster actions are identity-guarded.** Every action matches the live kubectl
  context (and fingerprint when captured) via `actionGuardError`, so a stale board
  can't mutate the wrong cluster; the irreversible Delete re-verifies a live CIMPL
  context (`verifyCimplContext`) first.
- **Exec is async + timeout-bounded.** Cluster/CLI calls go through `ctx.getExec()`
  so a slow or unreachable cluster can't block the server event loop; destructive
  verbs get longer timeouts (Delete waits minutes for Flux pruning).
- **Fail closed.** A workflow node's `output_schema` and the bound key's `validate`
  (`expectView`) reject a malformed view rather than publishing a broken board.

## Comments

`CONTRIBUTING.md` is authoritative. Default to **none**. Add a comment only when
it captures a non-obvious **why** a future reader needs — a hidden constraint, a
workaround, a non-obvious order dependency, an invariant from another module.

- No multi-paragraph blocks or bulleted `/* */` explanations. A one-sentence
  soft-wrap over two lines is fine.
- No PR-point-in-time narration ("Codex flagged…", "Per review…", "Addresses
  #N"). That belongs in the commit message or PR body.
- No what-just-changed notes, and no restating well-named code.

## Conventions

- **Commits**: conventional (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `test:`), one-sentence subject under ~70 chars. The squashed PR title becomes
  the commit subject, so the **PR title must be a conventional commit**
  (`pr-title.yml` enforces it) — keeping history release-ready.
- **PR body**: *What* / *Why now* / *Test plan* (the template), plus an optional
  *Risk & rollback*. No "Generated with" footers.
- **Workflow descriptions**: bundled workflows use the `Use when / Triggers /
  Does / NOT for` shape so the SPA workflow cards render scannably. Match it.
- **No abstractions ahead of a concrete second caller.**

## Documentation

The docs site lives under `docs/` — a self-contained **Astro Starlight** project
(its own `bun install` + lockfile). Read **`docs/STYLE.md`** (it extends keelson's
style guide) before adding or editing a docs page. Build locally with
`cd docs && bun install && bun run build`; `docs.yml` builds and deploys it on
every `docs/**` change.
