import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildQualityBoard, buildQualityTable, type ReleaseReport } from "../src/quality.ts";
import report from "./fixtures/release-report.json";

const table = buildQualityTable(report as ReleaseReport);
const board = buildQualityBoard(report as ReleaseReport);
const rowByService = (svc: string) =>
  table.rows.find((r) => r.service === svc) as Record<string, unknown> | undefined;

describe("buildQualityTable", () => {
  test("emits a valid canvas table view", () => {
    expect(canvasViewSchema.safeParse(table).success).toBe(true);
  });

  test("mirrors the osdu-quality CLI columns", () => {
    expect(table.columns.map((c) => c.key)).toEqual([
      "service",
      "accept",
      "unit",
      "coverage",
      "reliability",
      "security",
      "maintainability",
      "cve",
    ]);
  });

  test("pass-rate and coverage tones use the CLI thresholds", () => {
    expect(rowByService("CRS Conversion")?.accept).toEqual({ value: 0, tone: "error" });
    expect(rowByService("CRS Conversion")?.coverage).toEqual({ value: 10.9, tone: "error" });
    expect(rowByService("Register")?.accept).toEqual({ value: 80.7, tone: "warn" });
    expect(rowByService("Register")?.coverage).toEqual({ value: 56.4, tone: "warn" });
    expect(rowByService("Partition")?.accept).toEqual({ value: 100, tone: "ok" });
  });

  test("Sonar letter ratings: A -> ok, B/C -> warn, D/E -> error", () => {
    expect(rowByService("Search")?.reliability).toEqual({ value: "D", tone: "error" });
    expect(rowByService("CRS Conversion")?.reliability).toEqual({ value: "B", tone: "warn" });
    expect(rowByService("Partition")?.security).toEqual({ value: "A", tone: "ok" });
  });

  test("CVE cell formats C/H and tones by critical-then-high", () => {
    expect(rowByService("CRS Conversion")?.cve).toEqual({ value: "C10 / H33", tone: "error" });
    expect(rowByService("Register")?.cve).toEqual({ value: "C0 / H1", tone: "warn" });
    expect(rowByService("Partition")?.cve).toEqual({ value: "C0 / H0", tone: "ok" });
  });

  test("missing signals render as untoned dashes", () => {
    const w = rowByService("Wellbore Worker");
    expect(w?.accept).toBe("—");
    expect(w?.reliability).toBe("—");
    expect(w?.cve).toBe("—");
  });

  test("rows sorted worst-first", () => {
    const order = table.rows.map((r) => r.service);
    expect(order[0]).toBe("CRS Conversion");
    expect(order[order.length - 1]).toBe("Partition");
    expect(order.indexOf("Search")).toBeLessThan(order.indexOf("Register"));
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

  test("header pulse buckets every service into good/poor/fail", () => {
    const segs = board.header?.segments ?? [];
    expect(segs.map((s) => s.label)).toEqual(["Good", "Poor", "Fail"]);
    expect(segs.reduce((sum, s) => sum + s.n, 0)).toBe(5);
  });

  test("embeds the per-service table as a section", () => {
    const tableSection = board.sections.find((s) => s.kind === "table");
    expect(tableSection?.kind).toBe("table");
    if (tableSection?.kind === "table") {
      expect(tableSection.columns.map((c) => c.key)).toContain("service");
      expect(tableSection.rows).toHaveLength(5);
    }
  });

  test("stats include a services count and a critical-CVE tile", () => {
    const stats = board.sections.find((s) => s.kind === "stats");
    expect(stats?.kind).toBe("stats");
    if (stats?.kind === "stats") {
      const labels = stats.items.map((i) => i.label);
      expect(labels).toContain("Services");
      expect(labels).toContain("Critical CVEs");
    }
  });
});

describe("buildQualityBoard edge cases", () => {
  test("empty report still yields a valid board", () => {
    expect(canvasViewSchema.safeParse(buildQualityBoard({ services: [] })).success).toBe(true);
  });
});
