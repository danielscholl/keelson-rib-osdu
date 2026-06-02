import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildFeaturesBoard, extractEpics, extractMrs } from "../src/features.ts";
import epicsRaw from "./fixtures/activity-epics.json";
import mrsRaw from "./fixtures/activity-mrs.json";

const NOW = new Date("2026-06-02T00:00:00.000Z");
const epics = extractEpics(epicsRaw);
const mrs = extractMrs(mrsRaw);
const board = buildFeaturesBoard(epics, mrs, NOW);

const statsSection = board.sections.find((s) => s.kind === "stats");
const moversSection = board.sections.find((s) => s.kind === "cards");
const stalledSection = board.sections.find((s) => s.kind === "rows");

const kpi = (label: string) =>
  statsSection?.kind === "stats" ? statsSection.items.find((i) => i.label === label) : undefined;

describe("envelope extraction", () => {
  test("epics come from data.epics, MRs flatten data.projects[].merge_requests", () => {
    expect(epics).toHaveLength(4);
    expect(mrs).toHaveLength(5);
  });

  test("a missing/partial envelope yields empty lists, never a throw", () => {
    expect(extractEpics(null)).toEqual([]);
    expect(extractMrs({ data: {} })).toEqual([]);
    expect(extractEpics({ data: { epics: "nope" } })).toEqual([]);
  });
});

describe("buildFeaturesBoard", () => {
  test("emits a valid canvas board view", () => {
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("header carries the VENUS chip and an active/quiet/stalled pulse", () => {
    expect(board.header?.chip).toBe("VENUS");
    const segs = board.header?.segments ?? [];
    expect(segs.map((s) => s.label)).toEqual(["active", "quiet", "stalled"]);
    expect(segs.find((s) => s.label === "active")?.n).toBe(2);
    expect(segs.find((s) => s.label === "quiet")?.n).toBe(1);
    expect(segs.find((s) => s.label === "stalled")?.n).toBe(1);
  });

  test("MR KPI tiles count opened/draft/stale/blocked/ready with the CLI thresholds", () => {
    expect(kpi("Open MR")).toMatchObject({ value: 3, sub: "1 draft" });
    expect(kpi("Stale MR")).toMatchObject({ value: 1, sub: "> 7 days", tone: "ok" });
    expect(kpi("Blocked MR")).toMatchObject({ value: 1, sub: "CI failed", tone: "error" });
    expect(kpi("Ready MR")).toMatchObject({ value: 2, sub: "waiting", tone: "ok" });
  });

  test("Movers are active epics, progress-sorted, with bar/scope/velocity/owner", () => {
    expect(moversSection?.kind).toBe("cards");
    if (moversSection?.kind !== "cards") return;
    expect(moversSection.items).toHaveLength(2);

    const first = moversSection.items[0];
    expect(first?.title).toBe("Unified QA Reporting Dashboard");
    expect(first?.pill).toEqual({ label: "ACTIVE", tone: "ok" });
    expect(first?.bar).toEqual({ value: 8, total: 10 });
    expect(first?.href).toBe("https://community.opengroup.org/groups/osdu/platform/-/epics/69");
    expect(first?.fields?.map((f) => f.value)).toEqual([
      "80%",
      "8 of 10 tasks",
      "2 MRs/7d",
      "alice",
    ]);

    // No issues → MR-fallback scope, no progress bar, unowned.
    const second = moversSection.items[1];
    expect(second?.title).toBe("Schema Service Hardening");
    expect(second?.bar).toBeUndefined();
    expect(second?.fields?.map((f) => f.value)).toEqual([
      "67%",
      "2 of 3 MRs",
      "1 MR/7d",
      "unowned",
    ]);
  });

  test("Stalled are non-active epics, oldest first, with a why-flagged trailing", () => {
    expect(stalledSection?.kind).toBe("rows");
    if (stalledSection?.kind !== "rows") return;
    expect(stalledSection.items).toHaveLength(2);

    const oldest = stalledSection.items[0];
    expect(oldest?.text).toBe("Deprecated CRS Migration");
    expect(oldest?.chip).toEqual({ label: "STALE" });
    expect(oldest?.glyph).toBe("warn");
    expect(oldest?.trailing).toBe("stale-120d");

    const next = stalledSection.items[1];
    expect(next?.text).toBe("Legacy Ingestion Cleanup");
    expect(next?.chip).toEqual({ label: "QUIET" });
    expect(next?.glyph).toBe("neutral");
    expect(next?.trailing).toBe("stale-61d, unowned");
  });
});

describe("buildFeaturesBoard edge cases", () => {
  test("empty inputs still yield a valid board with just the KPI tiles", () => {
    const empty = buildFeaturesBoard([], [], NOW);
    expect(canvasViewSchema.safeParse(empty).success).toBe(true);
    expect(empty.sections.map((s) => s.kind)).toEqual(["stats"]);
  });

  test("a no-motion epic is flagged 'no motion', not stale-0d", () => {
    const b = buildFeaturesBoard([{ title: "Dormant", liveness: "dead", assignees: [] }], [], NOW);
    const rows = b.sections.find((s) => s.kind === "rows");
    expect(rows?.kind).toBe("rows");
    if (rows?.kind !== "rows") return;
    expect(rows.items[0]?.trailing).toBe("no motion, unowned");
  });

  test("missing liveness is non-active in both the pulse and the Stalled rows", () => {
    const b = buildFeaturesBoard([{ title: "No liveness", assignees: ["x"] }], [], NOW);
    expect(b.header?.segments?.find((s) => s.label === "stalled")?.n).toBe(1);
    const rows = b.sections.find((s) => s.kind === "rows");
    expect(rows?.kind).toBe("rows");
    if (rows?.kind !== "rows") return;
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]?.chip).toEqual({ label: "QUIET" });
  });

  test("the draft sublabel pluralizes", () => {
    const openSub = (drafts: number) => {
      const mrs = [
        { state: "opened", draft: false, created_at: "2026-06-01T00:00:00.000Z" },
        ...Array.from({ length: drafts }, () => ({ state: "opened", draft: true })),
      ];
      const s = buildFeaturesBoard([], mrs, NOW).sections.find((x) => x.kind === "stats");
      return s?.kind === "stats" ? s.items.find((i) => i.label === "Open MR")?.sub : undefined;
    };
    expect(openSub(0)).toBe("0 drafts");
    expect(openSub(1)).toBe("1 draft");
    expect(openSub(2)).toBe("2 drafts");
  });
});
