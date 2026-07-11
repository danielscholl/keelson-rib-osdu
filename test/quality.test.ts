import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildQualityBoard, buildQualityTable, type ReleaseReport } from "../src/quality.ts";
import report from "./fixtures/release-report.json";

const table = buildQualityTable(report as ReleaseReport);
const board = buildQualityBoard(report as ReleaseReport);
const serviceValue = (c: unknown) =>
  c && typeof c === "object" ? (c as { value?: unknown }).value : c;
const rowByService = (svc: string) =>
  table.rows.find((r) => serviceValue(r.service) === svc) as Record<string, unknown> | undefined;

describe("buildQualityTable", () => {
  test("emits a valid canvas table view", () => {
    expect(canvasViewSchema.safeParse(table).success).toBe(true);
  });

  test("is the prototype's Service · Acc · Unit · Quality shape", () => {
    expect(table.columns.map((c) => c.key)).toEqual(["service", "accept", "unit", "quality"]);
  });

  test("links Service cells to safe Sonar URLs", () => {
    expect(rowByService("Register")?.service).toEqual({
      value: "Register",
      href: "https://sonarcloud.io/project/overview?id=register",
    });
    expect(rowByService("Search")?.service).toBe("Search");
    expect(rowByService("Wellbore Worker")?.service).toBe("Wellbore Worker");
  });

  test("Acc / Unit cells are toned one-decimal pass rates", () => {
    expect(rowByService("CRS Conversion")?.accept).toEqual({ value: "0.0%", tone: "error" });
    expect(rowByService("Register")?.accept).toEqual({ value: "80.7%", tone: "warn" });
    expect(rowByService("Partition")?.accept).toEqual({ value: "100.0%", tone: "ok" });
    expect(rowByService("Register")?.unit).toEqual({ value: "97.0%", tone: "ok" });
  });

  test("Quality cell packs coverage % beside R/S/M grade badges", () => {
    expect(rowByService("CRS Conversion")?.quality).toEqual({
      value: "11%",
      tone: "error",
      badges: [
        { text: "B", tone: "info" },
        { text: "A", tone: "ok" },
        { text: "A", tone: "ok" },
      ],
    });
    // D rating rides the caution step; coverage 82.6 → ok.
    expect(rowByService("Search")?.quality).toEqual({
      value: "83%",
      tone: "ok",
      badges: [
        { text: "D", tone: "caution" },
        { text: "A", tone: "ok" },
        { text: "A", tone: "ok" },
      ],
    });
  });

  test("a service with no sonar renders a dash value and dash grade badges", () => {
    expect(rowByService("Wellbore Worker")?.quality).toEqual({
      value: "—",
      tone: "neutral",
      badges: [{ text: "—" }, { text: "—" }, { text: "—" }],
    });
    expect(rowByService("Wellbore Worker")?.accept).toBe("—");
  });

  test("rows are worst-health first (weakest signal), then name", () => {
    expect(table.rows.map((r) => serviceValue(r.service))).toEqual([
      "CRS Conversion",
      "Register",
      "Search",
      "Wellbore Worker",
      "Partition",
    ]);
  });

  test("caption carries service count and release", () => {
    expect(table.caption).toBe("Quality · 5 services · default");
  });
});

describe("buildQualityTable edge cases", () => {
  test("empty report still yields a valid table with no rows", () => {
    const empty = buildQualityTable({ services: [] });
    expect(empty.rows).toHaveLength(0);
    expect(canvasViewSchema.safeParse(empty).success).toBe(true);
  });

  test("missing services key is tolerated", () => {
    expect(canvasViewSchema.safeParse(buildQualityTable({})).success).toBe(true);
  });
});

describe("buildQualityBoard", () => {
  test("emits a valid canvas board view", () => {
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("section order mirrors the prototype lane", () => {
    expect(board.sections.map((s) => s.kind)).toEqual([
      "stats",
      "table",
      "segments",
      "bars",
      "table",
    ]);
  });

  test("header pulse buckets every service into good/poor/fail", () => {
    const segs = board.header?.segments ?? [];
    expect(segs.map((s) => s.label)).toEqual(["Good", "Poor", "Fail"]);
    expect(segs).toEqual([
      { label: "Good", n: 1, tone: "ok" },
      { label: "Poor", n: 1, tone: "warn" },
      { label: "Fail", n: 3, tone: "error" },
    ]);
  });

  test("KPI tiles are Pass / Flaky / Fail / Skip summed across stages", () => {
    const stats = board.sections.find((s) => s.kind === "stats");
    if (stats?.kind !== "stats") throw new Error("no stats section");
    expect(stats.items.map((i) => i.label)).toEqual(["Pass", "Flaky", "Fail", "Skip"]);
    expect(stats.items[0]).toEqual({ label: "Pass", value: "95.8%", sub: "CI tests", tone: "ok" });
    expect(stats.items[2]).toEqual({
      label: "Fail",
      value: 19,
      sub: "3.8% of total",
      tone: "error",
    });
    expect(stats.items[3]).toEqual({
      label: "Skip",
      value: 2,
      sub: "0.4% of total",
      tone: "warn",
    });
  });

  test("test-performance pulse buckets services by acceptance pass rate", () => {
    const seg = board.sections.find((s) => s.kind === "segments");
    if (seg?.kind !== "segments") throw new Error("no segments section");
    expect(seg.title).toBe("Test performance");
    expect(seg.items).toEqual([
      { label: "Passing", n: 2, tone: "ok" },
      { label: "Slipping", n: 1, tone: "warn" },
      { label: "Failing", n: 2, tone: "error" },
    ]);
  });

  test("stage bars aggregate unit + acceptance counts with a toned pass rate", () => {
    const bars = board.sections.find((s) => s.kind === "bars");
    if (bars?.kind !== "bars") throw new Error("no bars section");
    expect(bars.items).toEqual([
      { label: "Unit tests", value: 379, total: 382, tone: "ok", trailing: "379 / 382 · 99.2%" },
      {
        label: "Acceptance tests",
        value: 97,
        total: 115,
        tone: "warn",
        trailing: "97 / 115 · 84.3%",
      },
    ]);
  });

  test("worst-acceptance table is worst-first with filled count badges", () => {
    const tables = board.sections.filter((s) => s.kind === "table");
    const worst = tables[tables.length - 1];
    if (worst?.kind !== "table") throw new Error("no worst table");
    expect(worst.columns.map((c) => c.key)).toEqual([
      "service",
      "pct",
      "passed",
      "skipped",
      "failed",
    ]);
    expect(worst.rows.map((r) => serviceValue(r.service))).toEqual([
      "CRS Conversion",
      "Register",
      "Partition",
      "Search",
    ]);
    // A zero count stays a plain (dim) chip; non-zero counts are toned.
    expect(worst.rows[0]).toEqual({
      service: {
        value: "CRS Conversion",
        href: "https://gitlab.example.com/osdu/crs-conversion/-/pipelines/102",
      },
      pct: { value: "0%", tone: "error" },
      passed: { badges: [{ text: "0" }] },
      skipped: { badges: [{ text: "2", tone: "warn" }] },
      failed: { badges: [{ text: "5", tone: "error" }] },
    });
    const partitionCell = worst.rows.find((r) => serviceValue(r.service) === "Partition")?.service;
    expect(partitionCell).toBe("Partition");
    expect(typeof partitionCell).toBe("string");
  });
});

describe("buildQualityBoard edge cases", () => {
  test("empty report yields a valid board with only the KPI tiles", () => {
    const empty = buildQualityBoard({ services: [] });
    expect(canvasViewSchema.safeParse(empty).success).toBe(true);
    expect(empty.sections.map((s) => s.kind)).toEqual(["stats"]);
  });

  // A stage with counts but no pass_rate must derive one rate the whole lane
  // agrees on — the Sonar cell, the pulse, the worst table, and the bar.
  test("a stage with counts but no pass_rate is derived consistently across views", () => {
    const report: ReleaseReport = {
      services: [
        {
          name: "x",
          display_name: "X",
          sonar: {
            coverage_pct: 90,
            reliability_rating: "A",
            security_rating: "A",
            maintainability_rating: "A",
          },
          unit: { passed: 10, failed: 0, skipped: 0 },
          // 12 / (12 + 0 + 3) = 80% — the same total-tests denominator as the bar.
          acceptance: { passed: 12, failed: 0, skipped: 3 },
        },
      ],
    };
    const t = buildQualityTable(report);
    expect(t.rows[0]?.accept).toEqual({ value: "80.0%", tone: "warn" });
    const b = buildQualityBoard(report);
    const seg = b.sections.find((s) => s.kind === "segments");
    if (seg?.kind !== "segments") throw new Error("no segments section");
    // 80% → Slipping, never the Failing/unmeasured bucket.
    expect(seg.items).toContainEqual({ label: "Slipping", n: 1, tone: "warn" });
    const bars = b.sections.find((s) => s.kind === "bars");
    if (bars?.kind !== "bars") throw new Error("no bars section");
    // The bar reports the same 80% (12 / 15) as the table and pulse.
    expect(bars.items).toContainEqual({
      label: "Acceptance tests",
      value: 12,
      total: 15,
      tone: "warn",
      trailing: "12 / 15 · 80.0%",
    });
    const tables = b.sections.filter((s) => s.kind === "table");
    const worst = tables[tables.length - 1];
    if (worst?.kind !== "table") throw new Error("no worst table");
    expect(worst.rows[0]?.pct).toEqual({ value: "80%", tone: "warn" });
  });

  // A pass-rate-only report (no raw counts) must not fabricate zeros in the
  // count-derived sections — older/partial osdu-quality output looks like this.
  test("a pass-rate-only stage (no counts) does not fabricate zero counts", () => {
    const report: ReleaseReport = {
      services: [
        {
          name: "y",
          display_name: "Y",
          sonar: {
            coverage_pct: 90,
            reliability_rating: "A",
            security_rating: "A",
            maintainability_rating: "A",
          },
          unit: { pass_rate: 100 },
          acceptance: { pass_rate: 90 },
        },
      ],
    };
    const b = buildQualityBoard(report);
    const stats = b.sections.find((s) => s.kind === "stats");
    if (stats?.kind !== "stats") throw new Error("no stats section");
    // Unknown counts read as a dash, not a fabricated 0.
    expect(stats.items.find((i) => i.label === "Fail")?.value).toBe("—");
    expect(stats.items.find((i) => i.label === "Skip")?.value).toBe("—");
    // No count bars and no worst-acceptance table without real counts; the Sonar
    // table still carries the rate from pass_rate.
    expect(b.sections.map((s) => s.kind)).toEqual(["stats", "table", "segments"]);
    expect(buildQualityTable(report).rows[0]?.accept).toEqual({ value: "90.0%", tone: "warn" });
  });

  test("non-http service URLs stay plain strings", () => {
    const report: ReleaseReport = {
      services: [
        {
          name: "unsafe",
          display_name: "Unsafe",
          pipeline_url: "gitlab.example.com/osdu/unsafe/-/pipelines/1",
          sonar: {
            coverage_pct: 90,
            reliability_rating: "A",
            security_rating: "A",
            maintainability_rating: "A",
            sonar_url: "javascript:alert(1)",
          },
          unit: { passed: 1, failed: 0, skipped: 0 },
          acceptance: { pass_rate: 50, passed: 1, failed: 1, skipped: 0 },
        },
      ],
    };
    const t = buildQualityTable(report);
    expect(canvasViewSchema.safeParse(t).success).toBe(true);
    expect(t.rows[0]?.service).toBe("Unsafe");

    const b = buildQualityBoard(report);
    expect(canvasViewSchema.safeParse(b).success).toBe(true);
    const tables = b.sections.filter((s) => s.kind === "table");
    const worst = tables[tables.length - 1];
    if (worst?.kind !== "table") throw new Error("no worst table");
    expect(worst.rows[0]?.service).toBe("Unsafe");
  });
});
