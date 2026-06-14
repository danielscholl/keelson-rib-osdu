# Contributing to @keelson/rib-osdu

Thanks for your interest in the OSDU rib. This document captures the conventions
and required checks for every pull request. This rib is a
[Keelson](https://github.com/danielscholl/keelson) rib — a standalone package the
harness discovers at runtime — so its contribution flow is lighter than the
keelson monorepo's. Where this file is silent, the
[keelson CONTRIBUTING guide](https://github.com/danielscholl/keelson/blob/main/CONTRIBUTING.md)
is the parent.

## Development environment

You need [Bun](https://bun.sh/) on PATH. The rib has one runtime peer,
`@keelson/shared`, which the harness provides at runtime; for local development
you resolve it from a keelson checkout.

```bash
git clone https://github.com/danielscholl/keelson-rib-osdu.git
cd keelson-rib-osdu
bun install
bun link @keelson/shared   # resolves the contract from your local keelson checkout
                           # (or recreate node_modules/@keelson/shared by hand)
```

`@keelson/shared` is declared an **optional** peer dependency: the rib installs
and its tests run without it (the pure builders are exercised directly), but
typechecking against the `Rib` contract needs it linked. CI resolves it the same
way — a symlink to a `danielscholl/keelson` checkout's `packages/shared`, sourced
from `main`, so a harness contract change that breaks this rib turns CI red here.

To exercise the rib inside a running harness, link it into a local keelson and
launch the dev server:

```bash
bun run link:keelson   # defaults to ../keelson; override with KEELSON_DIR
cd ../keelson && KEELSON_RIBS=osdu bun dev
```

Then open `http://127.0.0.1:5173` and select the **CIMPL** tab (or **Ribs**).
Live data needs the OSDU toolchain on `PATH` (`cimpl`, `kubectl`,
`osdu-activity`, `osdu-quality`, `glab`) plus a reachable cluster; without it the
rib still loads and its lanes render empty. Smoke-test a collector in isolation
with `bun run collect:cluster | jq .` (and the `:topology` / `:quality` /
`:features` / `:security` / `:waiting` siblings).

## Required checks before opening a PR

Every PR must keep these green. CI runs the same commands.

```bash
bun run check       # Biome lint + format check
bun run typecheck   # tsc --noEmit (needs @keelson/shared linked)
bun test            # runs with stubs; CI sets KEELSON_USE_STUBS=1
```

Run `bun run check:fix` to auto-fix the safe lint and format issues.

If you touched the documentation site under `docs/`, build it too — `docs.yml`
runs the same build on every `docs/**` change:

```bash
cd docs && bun install && bun run build
```

Documentation contributions follow [docs/STYLE.md](docs/STYLE.md), which extends
the keelson documentation style guide.

## Commit messages

Conventional commit format (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
`test:`). One sentence in the subject (under 70 characters). The squashed PR
title becomes the commit subject and is validated by `pr-title.yml`, so it must
be a conventional commit. Body — when needed — explains *why*, not *what*; the
diff already shows the what.

## Pull request hygiene

- Keep PRs scoped to one thing. Split refactors out of feature work.
- The PR description should answer: what changed, why now, how it was tested.
- Don't add new abstractions ahead of a concrete second caller.
- Don't add comments that narrate the change — that belongs in the PR
  description, not the source. Add a comment only when it captures a non-obvious
  *why* a future reader would need.

## Architecture rules

- All OSDU and cluster knowledge lives in this rib. The harness stays
  domain-free; don't push OSDU/CIMPL specifics into keelson.
- The rib ships **zero React** into the trusted SPA; views render through the
  canvas `board` / `graph` contract, not hand-coded UI.
- The rib attaches to the harness only through the `Rib` contract
  (`@keelson/shared`). Don't reach around it into harness internals.
- **No domain logic in the rib glue, and no reimplemented analyzers.** A collector
  shells the domain CLI and shapes its output with a pure builder — keep
  parsing/aggregation in the builders and side effects in the collectors.
- **Secrets never enter a snapshot.** Revealed credentials are loopback-only
  (returned to the caller); they must never be written into a published view,
  logged, or persisted.
- **Cluster actions stay identity-guarded.** Match the live kubectl context (and
  fingerprint when captured) before any cluster action, and re-verify a live CIMPL
  context before the irreversible Delete. Shell the CLIs through the async exec
  surface with bounded timeouts so a slow cluster can't block the event loop.

## License and attribution

The rib is Apache-2.0 (see [LICENSE](LICENSE)). It bundles no OSDU code — its
collectors shell community CLIs installed on `PATH`. The CIMPL Stack and AI
DevOps Agent tooling it builds on is credited in [NOTICE](NOTICE); a change that
shells a new upstream CLI must carry its attribution forward there and in the
README Acknowledgments.

## Security

For security-sensitive reports, see keelson's
[SECURITY.md](https://github.com/danielscholl/keelson/blob/main/SECURITY.md).
Please do not file public GitHub issues for vulnerabilities.
