---
title: Develop locally
description: Link a checkout into a local Keelson, run the required checks, and iterate on a lane end to end.
sidebar:
  order: 4
---

Working on the rib itself takes two checkouts side by side: this rib and a
[keelson](https://github.com/danielscholl/keelson) checkout that provides
the `Rib` contract and a harness to run against.

## Set up the checkout

```bash
git clone https://github.com/danielscholl/keelson-rib-osdu
cd keelson-rib-osdu
bun install
bun link @keelson/shared   # resolve the contract from your keelson checkout
```

`@keelson/shared` is a peer dependency the harness normally provides; for a
standalone checkout you link it from a local keelson clone (run `bun link`
inside `keelson/packages/shared` first if you have not registered it).
Typechecking needs the link; the pure-builder tests do not.

## The required checks

Every PR gates on all three green, and CI runs the same set:

```bash
bun run check       # Biome lint + format
bun run typecheck   # tsc --noEmit (needs the link above)
bun test            # pure builder coverage against captured fixtures
```

`bun run check:fix` auto-fixes the safe lint and format issues. CI resolves
`@keelson/shared` from a `danielscholl/keelson` checkout's `main`, so a
harness contract change that breaks this rib turns CI red here even when
your local link is older.

## Run it inside a local harness

```bash
bun run link:keelson                     # symlink this rib into ../keelson
cd ../keelson && KEELSON_RIBS=osdu bun dev
```

`link:keelson` assumes the keelson checkout sits at `../keelson`; override
with `KEELSON_DIR`. Then open `http://127.0.0.1:5173` and find the
**CIMPL** tab. The dev harness hot-reloads the SPA, but the rib itself
loads at boot, so restart `bun dev` after changing rib code.

## The iteration loop for a lane

The fast loop never needs the harness. A lane is a pure builder plus a thin
collector, so:

1. Change the builder (`src/<lane>.ts`) against its test
   (`test/<lane>.test.ts`) and fixture; `bun test` is the inner loop.
2. Smoke the collector against the live toolchain:
   `bun run collect:<lane> | jq .` (see
   [Run the collectors](../run-the-collectors/)).
3. Only then run it in the harness, where the workflow validates and
   publishes the same payload.

Keep the split honest: parsing and aggregation belong in the builder,
side effects in the collector, and no domain logic in the rib glue. A new
abstraction waits for a concrete second caller.

## Docs changes

The docs site under `docs/` is its own Astro project with its own lockfile:

```bash
cd docs && bun install && bun run build
```

`docs.yml` runs the same build on every `docs/**` change and deploys from
`main`. Read `docs/STYLE.md` before adding a page.

## Related

- [Run the collectors](../run-the-collectors/): the smoke-test step of the
  loop, in detail.
- [The collector pipeline](../../concepts/the-collector-pipeline/): why
  the builder/collector split is the shape of every lane.
- [CONTRIBUTING.md](https://github.com/danielscholl/keelson-rib-osdu/blob/main/CONTRIBUTING.md):
  the full contribution rules these checks come from.
