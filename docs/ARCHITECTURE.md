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
| Quality Sonar table, worst-acceptance table | data table + colored cells | `table` ✓ (+ cell-tone G0 ✓) |
| Topology (seam proof) | node-link graph | `graph` ✓ |
| KPI tiles, pulse, progress bars, cards, status rows (links/copy) | composite dashboard | `board` ✓ (G1 + G2) |

The composite `board` kind that expresses these regions has landed in the Keelson base (PR #95).
Quality and Features render as boards today; the remaining surfaces are the same primitives recomposed.

## 6. Keelson gap analysis (the gating work)

Keelson's canvas catalog was a closed union of `table` and `graph`; the bridge surfaces needed
primitives neither expressed. The **base** work below is domain-free and reusable by any rib.
**Status: G0 + G1 + G2 shipped to keelson `main` in PR #95**; G3 and G4 remain.

### G1 — Composite "board" view kind  *(✓ SHIPPED — keelson PR #95)*
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

### G2 — Cell affordances: link + copy  *(✓ SHIPPED — keelson PR #95)*
Card fields carry optional `href` (clickable links) and `copyable` (copy buttons) — for portal URLs and
credentials. Links are gated to `http(s)` only (unsafe schemes collapse to plain text). Folded into the
board contract alongside G1; the Features lane's epic cards/rows link out through it today.

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

### G0 — Table cell tone  *(✓ SHIPPED — keelson PR #95)*
Optional `{value, tone}` cell form + `data-tone` rendering — the colored %/badges in tables. Folded
into G1's table block; `tone` is reused by every board primitive (segments, stats, bars, cards, rows).

**Dependency order:** G0 + G1 + G2 (✓ shipped) unlocked the lane boards (Phase 2 — Quality and Features
are boards now) → **G4** composes them into the top-level page (Phase 3) → **G3** unlocks the Cluster
ICC's Reconcile/Suspend/Delete actions (Phase 4). **G4 is the next base gap**, best designed now that two
real boards exist to lay out.

## 7. Current state (what exists now)

- **Three views verified live end-to-end:** the **Topology graph** (`rib:osdu:topology`, kubectl), the
  **Quality board** (`rib:osdu:quality`, `osdu-quality release --output json`), and the **Features board**
  (`rib:osdu:features`, `osdu-activity epic list` + `mr --output json`). Quality and Features are full
  `board` composites — pulse + KPI tiles + table/cards/rows; the Quality flat table is now one section.
- **Base gaps G0 + G1 + G2 shipped** to keelson `main` (PR #95): cell tone, the composite `board` view,
  and card-field link/copy. The Features lane was built with **zero further base change** — it fits the
  existing board contract.
- The topology graph remains a seam proof (the real cluster surface is the ICC board, Phase 4).
- Remaining base asks: **G4** (top-level surface + region layout) and **G3** (rib-action round-trip).

## 8. Next step

G1 shipped and two lanes (Quality, Features) render as boards. Next: build the **Security** lane and
**Release Train** as boards (more boards to lay out), then design **G4** (the top-level `CIMPL` surface +
region layout) in the Keelson base and compose the lane boards into the full page — and finally the
**Cluster ICC** (which also needs G3, the rib-action round-trip).
