# Architecture — `@keelson/rib-osdu`

> How the rib produces the surfaces in [PRD.md](./PRD.md), and — most importantly — the
> **Keelson base gaps** it depends on. Status: **draft / under active design.**

## 1. The pipeline (one sentence)

A contributed **workflow** runs a thin **collector** that shells an OSDU/CIMPL **CLI**
(`--output json`), a pure **shaper** maps that JSON into a generic **canvas view** payload,
the node's `output_schema` promotes its stdout to structured output, the rib's
**snapshot binding** publishes it (fail-closed via a Zod `validate`) to a `rib:osdu:*` key,
and the bound **view** renders it live in the SPA.

```
osdu-quality release --output json        (CLI — handles its own auth)
   │  shelled by
bin/collect-quality.ts  ──►  src/quality.ts  (pure shaper, JSON → view payload)
   │  printed to stdout, node declares output_schema
workflow node (bash: bun …)  ──►  text→structured promotion (executor)
   │  rib bindSnapshotKey + validate (canvasViewSchema, fail-closed)
SnapshotManager key  rib:osdu:quality
   │  view descriptor { key, canvasKind:"view" }
Ribs page button  ──►  canvas renderer (live)
```

No domain logic lives in rib *glue*; collectors shell a CLI, shapers are pure and tested.
This is the proven part — it works end-to-end today (see §7).

## 2. Rib contract usage (`@keelson/shared` `Rib`)

- `views: RibViewDescriptor[]` — one per surface; binds a `rib:osdu:*` snapshot key to a `canvasKind`.
- `contributeWorkflows()` — one workflow per surface: a `bash` node that runs the collector, an
  `output_schema`, a `bindSnapshotKey`, and a fail-closed `validate` (parse through `canvasViewSchema`).
- `authStatus()` — probe (kubectl context for cluster; CLI presence for lanes).
- `onAction()` / `actions` — for the Cluster ICC's Reconcile/Suspend/Delete (Phase 3; see Gap G3).
- `registerTools` — not used (label-only stub in the base).

## 3. Data flow & snapshot-key map

| Surface | Snapshot key | Workflow | Collector → CLI |
|---|---|---|---|
| Cluster ICC | `rib:osdu:cluster` | `osdu-cluster` | `cimpl info --json` + kubectl (lifecycle) |
| Quality | `rib:osdu:quality` | `osdu-quality` | `osdu-quality release --output json` |
| Security | `rib:osdu:security` | `osdu-security` | `osdu-quality release --output json` (+ gitlab/OSV) |
| Features | `rib:osdu:features` | `osdu-features` | `osdu-activity epic/mr --output json` |
| Release Train | `rib:osdu:release` | `osdu-release` | `osdu-activity mr --output json` + release metadata |
| Waiting on You | `rib:osdu:queue` | `osdu-queue` | `osdu-activity mr/issue --output json` (needs-review filter) |
| Current Events | `rib:osdu:feed` | `osdu-feed` | kubectl jobs + `osdu-activity mr --output json` |
| (Topology graph — seam proof) | `rib:osdu:topology` | `osdu-topology` | `kubectl get kustomizations` |

Keys must stay under `rib:osdu:*` (the scoped SnapshotManager enforces the namespace). The
top-level **surface** (the `CIMPL` tab, gap G4) is not itself a key — it's a layout descriptor
that binds these keys to page regions (header / banner / columns / footer).

## 4. Collectors (the data layer — proven, reusable)

Each collector is a thin Bun script (`bin/collect-*.ts`) that spawns a CLI, parses its JSON, and
calls a pure shaper (`src/*.ts`) tested against a captured fixture. Pattern established by
`collect-topology.ts` (kubectl) and `collect-quality.ts` (`osdu-quality release`). The shaping logic
is a near-port of cimpl-agent's pure composers (`packages/ext-cimpl-bridge/src/composer/*`) — **ported,
never imported**. CLIs own auth; collectors degrade to a valid empty payload on failure.

## 5. Canvas view mapping

| Surface region | Needs | Keelson today |
|---|---|---|
| Quality Sonar table, worst-acceptance table | data table + colored cells | `table` ✓ (+ cell-tone, in flight) |
| Topology (seam proof) | node-link graph | `graph` ✓ |
| KPI tiles, pulse bars, progress bars, cards, status rows, action buttons | composite dashboard | **missing** |

The single flat `table` we shipped for Quality is only one region of the real Quality surface. Every
real surface is a composite. That is the gap.

## 6. Keelson gap analysis (the gating work)

Keelson's canvas catalog is a closed union of `table` and `graph` (`packages/shared/src/canvas.ts`,
`canvasViewSchema`). The bridge surfaces need primitives none of those express. Proposed **base** work,
domain-free and reusable by any rib:

### G1 — Composite "board" view kind  *(the big one; gates Phases 2–4)*
A new additive member of `canvasViewSchema`: `view: "board"` — an ordered list of typed **sections**,
each a generic block. Sketch (domain-free; tone/labels only, no OSDU terms):

```
view: "board"
title?: string                          // surface header
header?: { chip?, segments?: [{ label, n, tone }] }    // e.g. "VENUS" + "25 active · 4 quiet"
sections: [                             // ordered; each section is one generic block
  { kind: "stats",    items: [{ label, value, sub?, tone? }] }              // KPI tiles (every lane)
  { kind: "segments", items: [{ label, n, tone }] }                        // "pulse" summary
  { kind: "bars",     items: [{ label, value, total, tone?, trailing? }] } // Quality test-perf bars;
                                                                           //   Security offenders (trailing="27 crit · 74 high")
  { kind: "table",    columns, rows }                                      // Quality Sonar / worst-acceptance (+cell tone)
  { kind: "cards",    items: [{ title, pill?: { label, tone }, href?,      // movers/stalled, CVE, access, low-rating
                                bar?: { value, total },                    //   Features movers progress
                                fields?: [{ label?, value, tone?, href?, copyable? }],  // access creds / meta chips / CVE pkg
                                footnote? }] }                             //   "why flagged: stale-61d, unowned"
  { kind: "rows",     items: [{ glyph?: tone, chip?: { label, tone },      // Cluster lifecycle rows,
                                text, href?, trailing? }] }                //   Current Events feed (chip + text + age)
]
```
This single composite (table + a handful of primitive blocks) covers all the surfaces while keeping the
catalog small (`table`, `graph`, `board`). It was validated against all five reference screenshots in
[`docs/design/`](../docs/design): `stats`→KPI tiles, `segments`→pulse, `bars`→test-perf & offenders,
`table`→Sonar, `cards`→Features movers/stalled + Security CVEs + Cluster access, `rows`→lifecycle &
the Current Events feed. Work: schema + renderer + dispatch + tests in `packages/shared` and `apps/web`.
The badge primitives (rating A–E, count/severity, status pills) are just toned cells/segments/pills — no
extra kinds needed.

### G2 — Cell affordances: link + copy
Cards and tables need cells that are **clickable links** (`href`) and **copy buttons** (`copyable`) —
portal URLs and credentials. Today a cell is scalar text only. Extend the cell/field shape (building on
the in-flight `{value, tone}` cell) with optional `href` and `copyable`. Without this, the ICC Access
grid and any URL column are functionally lossy.

### G3 — Rib action round-trip in the UI
The Cluster ICC has **actions** (Reconcile / Suspend / Delete). The `Rib` contract already has
`actions` + `onAction`, but the SPA needs to render action buttons on a rib view, call `onAction`, show
a confirm for destructive ones, and reflect the result (refresh / toast). Verify what exists; build the
gap. (Read-only surfaces don't need this; it gates only Phase 4, the ICC.)

### G4 — Top-level rib surface + region layout  *(needed; gates the full page, Phase 3)*
The full reference layout (`docs/design/full-layout.png`) is **one top-level surface** — a `CIMPL`
nav tab — not a drawer and not N separate views. So a rib needs to contribute a primary surface
declared as a layout of named **regions**, each region bound to a snapshot key carrying a `board`,
each refreshed independently, some collapsible. Domain-free sketch:

```
surface: { id: "osdu", title: "CIMPL" }            // → a primary nav tab
layout: {
  header?: { key, collapsible?, collapsed? }       // cluster strip — collapsed by default
  banner?: { key }                                  // waiting-on-you
  rows:   [ { columns: [ { key }, … ] } ]           // the three lane boards, side by side
  footer?: { key, collapsible?, collapsed? }        // current-events feed — collapsed by default
}
```

The SPA renders the tab, arranges the regions, and renders one board per region through the G1
renderer; a collapsed region shows its board's header strip (chip + segments). Board (G1) stays
"one panel, no internal page layout"; the surface (G4) owns columns / header / footer. This is
SPA-navigation plus a small surface descriptor on the `Rib` contract — larger than G1, best designed
once 2–3 real boards exist to lay out.

### G0 — Table cell tone *(in flight)*
Branch `feat/canvas-table-cell-tone` on keelson: optional `{value, tone}` cell form + `data-tone`
rendering. Covers the colored %/badges in tables. Already built; folds into G1's table block.

**Dependency order:** G0 (done) → **G1** (+ G2) unlocks the lane boards (Phase 2) → **G4** composes
them into the top-level page (Phase 3) → **G2 + G3** unlock the Cluster ICC's links / credentials and
Reconcile/Suspend/Delete actions (Phase 4). G1 is first and provable today by rebuilding Quality as a
board in the drawer.

## 7. Current state (what exists now)

- **Topology graph** (`rib:osdu:topology`, kubectl) and **Quality table** (`rib:osdu:quality`,
  `osdu-quality release --output json`) are built and verified live end-to-end. They proved the
  pipeline and the "wrap-the-CLI" data layer with near-zero base change.
- They are **seam proofs, not the final surfaces.** The topology graph will be retired (the real
  cluster surface is the ICC board); the Quality table becomes one `table` *section* of the Quality
  board once G1 lands.
- The only base change so far is **G0** (table cell tone). G1–G3 are the new, larger asks this
  document scopes.

## 8. Next step

Open a Keelson base issue for **G1** (the `board` view kind; fold in G2 cell link/copy and the
already-built G0 cell-tone). Acceptance: the Quality lane re-rendered as a board in the canvas drawer.
Track **G4** (top-level surface + region layout) as a dependent follow-on, designed once 2–3 boards
exist. Then Security / Features as boards, the page layout, and finally the Cluster ICC.
