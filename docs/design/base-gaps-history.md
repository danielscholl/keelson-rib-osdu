# Keelson base-gap analysis (historical)

> **Historical record.** This is the gating analysis that sequenced this rib's
> build against the Keelson base — the `G0`–`G4` gaps. It is preserved for
> context; it does **not** describe the current state. All five have shipped,
> and the rib now renders nine views through the contract they opened up. For
> current architecture see [../ARCHITECTURE.md](../ARCHITECTURE.md) and the
> published [reference tier](https://danielscholl.github.io/keelson-rib-osdu/reference/).

| Gap | What it gated | Resolution |
|---|---|---|
| `G0` | Colored cells in a table (rating badges, pass-rate %) | ✅ optional `{value, tone}` cell form + `data-tone` rendering; `tone` is now reused by every board primitive |
| `G1` | A composite view kind — the lanes are dashboards, not one table | ✅ `view: "board"`: an ordered list of typed sections (`stats`, `segments`, `bars`, `table`, `cards`, `rows`, `grid`) |
| `G2` | Links and copy buttons in a card field (portal URLs, credentials) | ✅ optional `href` (gated to `http(s)`) + `copyable` on card fields |
| `G3` | A rib action round-trip in the UI | ✅ `actions` + `onAction` rendered as board buttons, with destructive confirm and result handling |
| `G4` | A top-level rib surface with a region layout | ✅ `surfaces[]` with `header` / `banner` / `rows` / `footer`, each region bound to a snapshot key and its own cadence |

---

The premise, worth keeping because it is the reusable part: each gap below is
**domain-free and reusable by any rib**. The rib asked the harness for
primitives, never for OSDU knowledge. That constraint is what kept the harness
domain-free while the bridge got built.

## Why these were gaps

Keelson's canvas catalog was originally a closed union of `table` and `graph`.
The bridge's surfaces are composites — small dashboards of repeating visual
primitives — which neither kind expressed. The alternative on the table was
hand-coded React in the trusted SPA with OSDU section names baked into the
shared contract, which is exactly what the `cimpl-agent` fork did and exactly
what this rib exists to avoid.

## Gap details

### G0 — Table cell tone *(✓ shipped, keelson PR #95)*
Optional `{value, tone}` cell form plus `data-tone` rendering: the colored
percentages and letter badges in tables. Folded into G1's table block. `tone`
turned out to be the single most reused primitive in the whole board contract.

### G1 — Composite "board" view kind *(✓ shipped, keelson PR #95)*
An additive member of `canvasViewSchema`: `view: "board"`, an ordered list of
typed sections, each a generic block. Validated against the five reference
screenshots in this directory: `stats` → KPI tiles, `segments` → pulse,
`bars` → test performance and top offenders, `table` → Sonar, `cards` →
Features movers/stalled, `rows` → lifecycle and the events feed, `grid` →
the low-rating cells and the PMC link strip.

The bet was that one composite plus a handful of primitive blocks would cover
every surface while keeping the catalog small (`table`, `graph`, `board`). It
held: the Features lane was later built with **zero further base change**.

### G2 — Cell affordances: link + copy *(✓ shipped, keelson PR #95)*
Card fields carry optional `href` and `copyable`, for portal URLs and
credentials. Links are gated to `http(s)` only; unsafe schemes collapse to
plain text. The copy affordance is what made copy-on-reveal credentials
possible without ever putting a secret in the snapshot.

### G3 — Rib action round-trip in the UI *(✓ shipped)*
The `Rib` contract already had `actions` + `onAction`, but the SPA could not
render action buttons on a rib view, call `onAction`, confirm a destructive
one, or reflect the result. This gated the Cluster board, the one surface that
mutates a real cluster. It now carries seven verbs, each behind the gate that
fits it: five stamped against the live context and fingerprint, and `create`
and `switch-context` behind their own checks, since neither acts on the
cluster the board was built against.

### G4 — Top-level rib surface + region layout *(✓ shipped)*
The reference layout (`full-layout.png` in this directory) is **one top-level
surface**, a `CIMPL` nav tab, not a drawer and not N separate views. A rib
needed to contribute a primary surface declared as a layout of named regions,
each bound to a snapshot key carrying a board, each refreshed independently,
some collapsible.

The division of labor that came out of it: a board stays "one panel, no
internal page layout," and the surface owns the columns, header, and footer.
It was deliberately designed last, once several real boards existed to lay
out, rather than up front against one.

## The reference screenshots

The `cimpl-agent` UI targets these gaps were validated against live in this
directory: [`cluster.png`](./cluster.png), [`quality-lane.png`](./quality-lane.png),
[`security-lane.png`](./security-lane.png), [`features-lane.png`](./features-lane.png),
[`current-events.png`](./current-events.png), and the composed
[`full-layout.png`](./full-layout.png). They are the originating design targets,
not screenshots of this rib; for what it renders today see the published docs.

## Phasing, as it actually ran

0. **Seam proof.** A kubectl Flux topology graph and a Quality table proved the
   pipeline end to end (discovery → workflow → snapshot → canvas render) with
   near-zero base change. Proofs, not the real surfaces.
1. **The generic `board` view** (G0 + G1 + G2), proven by rebuilding Quality as
   a board.
2. **The lanes as boards** — Quality, Features, then Security and Release Train.
3. **The top-level CIMPL surface** (G4), composing the lane boards into the full
   page.
4. **The Cluster board** (needing G3), access + lifecycle + actions.
5. **The remaining regions** — Release Train, Waiting on You, Current Events.

Two questions were open through the build and are worth recording as resolved.
Should a rib's primary dashboard be a full-width top-level surface or a
right-side drawer? A full-width surface (G4). One snapshot key per region, or
one key emitting the whole page? Per region, which is what lets each panel
refresh on its own cadence.
