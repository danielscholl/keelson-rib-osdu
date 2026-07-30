import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildQualityBoard, buildQualityTable, type ReleaseReport } from "../src/quality.ts";
import report from "./fixtures/release-report.json";
import liveReport from "./fixtures/release-report-live.json";

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

  // Health is the min of coverage / unit / acceptance — the numbers the table
  // shows. Wellbore Worker has no signal at all, so it sorts last rather than
  // mid-pack: unknown must not displace measured evidence.
  test("rows are worst-health first (weakest visible signal), no-data last", () => {
    expect(table.rows.map((r) => serviceValue(r.service))).toEqual([
      "CRS Conversion",
      "Register",
      "Search",
      "Partition",
      "Wellbore Worker",
    ]);
  });

  // "default" is the CLI's no-release sentinel, so the caption falls through to
  // the branch label the CLI composed for readers.
  test("caption carries service count and the resolved scope label", () => {
    expect(table.caption).toBe("Quality · 5 services · master");
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

  // Buckets on the displayed numbers only: Partition 94.7 / Search 82.6 read
  // Good despite their D letters, CRS Conversion fails on its real 0% acceptance,
  // and signal-less Wellbore Worker is No data — not an invented "Poor".
  test("header pulse buckets on visible signals, with a No data segment", () => {
    const segs = board.header?.segments ?? [];
    expect(segs).toEqual([
      { label: "Good", n: 2, tone: "ok" },
      { label: "Poor", n: 1, tone: "warn" },
      { label: "Fail", n: 1, tone: "error" },
      { label: "No data", n: 1, tone: "neutral" },
    ]);
  });

  // Four tiles, not five: a fifth narrowed each to 90px and wrapped the Gate
  // fraction onto two lines in the 1/3-width lane.
  test("KPI tiles are Pass / Fail / Skip / Gate summed across stages", () => {
    const stats = board.sections.find((s) => s.kind === "stats");
    if (stats?.kind !== "stats") throw new Error("no stats section");
    expect(stats.items.map((i) => i.label)).toEqual(["Pass", "Fail", "Skip", "Gate"]);
    expect(stats.items[0]).toEqual({
      label: "Pass",
      value: "95.8%",
      sub: "unit + acceptance",
      tone: "ok",
    });
    expect(stats.items[1]).toEqual({
      label: "Fail",
      value: 19,
      sub: "3.8% of total",
      tone: "error",
    });
    expect(stats.items[2]).toEqual({
      label: "Skip",
      value: 2,
      sub: "0.4% of total",
      tone: "warn",
    });
    // Two of the five carry a Sonar gate verdict; both are ERROR. The sub names
    // the three with no Sonar project so 2/2 can't pass for the service count.
    expect(stats.items[3]).toEqual({
      label: "Gate",
      value: "2 / 2",
      sub: "failing · 3 no gate",
      tone: "error",
    });
  });

  // Sonar's alert_status vocabulary: only ERROR fails; WARN is scoped but not
  // failing; NONE means no gate configured and stays out of both counts.
  test("Gate tile counts only ERROR as failing and excludes NONE from scope", () => {
    const b = buildQualityBoard({
      services: [
        { name: "ok", sonar: { quality_gate: "OK" } },
        { name: "warn", sonar: { quality_gate: "warn" } },
        { name: "err", sonar: { quality_gate: "ERROR" } },
        { name: "none", sonar: { quality_gate: "NONE" } },
        { name: "absent", sonar: {} },
      ],
    });
    const stats = b.sections.find((s) => s.kind === "stats");
    if (stats?.kind !== "stats") throw new Error("no stats section");
    const gate = stats.items.find((i) => i.label === "Gate");
    expect(gate?.value).toBe("1 / 3");
    expect(gate?.sub).toBe("failing · 2 no gate");
    expect(gate?.tone).toBe("error");
  });

  test("test-performance pulse buckets services by acceptance pass rate", () => {
    const seg = board.sections.find((s) => s.kind === "segments");
    if (seg?.kind !== "segments") throw new Error("no segments section");
    expect(seg.title).toBe("Test performance");
    // Wellbore Worker has no acceptance stage at all; it gets its own bucket
    // rather than inflating Failing.
    expect(seg.items).toEqual([
      { label: "Passing", n: 2, tone: "ok" },
      { label: "Slipping", n: 1, tone: "warn" },
      { label: "Failing", n: 1, tone: "error" },
      { label: "No data", n: 1, tone: "neutral" },
    ]);
  });

  test("stage bars aggregate unit + acceptance counts with a toned pass rate", () => {
    const bars = board.sections.find((s) => s.kind === "bars");
    if (bars?.kind !== "bars") throw new Error("no bars section");
    expect(bars.items).toEqual([
      { label: "Unit tests", value: 379, total: 382, tone: "ok", trailing: "379 / 382 · 99.2%" },
      {
        label: "Acceptance tests (gitlab dev)",
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
      "n",
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
      n: "7",
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
      label: "Acceptance tests (gitlab dev)",
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

  test("credential-bearing service URLs stay plain strings (no userinfo in snapshot)", () => {
    const report: ReleaseReport = {
      services: [
        {
          name: "creds",
          display_name: "Creds",
          pipeline_url: "https://user:token@gitlab.example.com/osdu/creds/-/pipelines/1",
          sonar: {
            coverage_pct: 90,
            reliability_rating: "A",
            security_rating: "A",
            maintainability_rating: "A",
            sonar_url: "https://user:token@sonarcloud.io/project/overview?id=creds",
          },
          unit: { passed: 1, failed: 0, skipped: 0 },
          acceptance: { pass_rate: 50, passed: 1, failed: 1, skipped: 0 },
        },
      ],
    };
    const t = buildQualityTable(report);
    expect(canvasViewSchema.safeParse(t).success).toBe(true);
    expect(t.rows[0]?.service).toBe("Creds");

    const b = buildQualityBoard(report);
    expect(canvasViewSchema.safeParse(b).success).toBe(true);
    const tables = b.sections.filter((s) => s.kind === "table");
    const worst = tables[tables.length - 1];
    if (worst?.kind !== "table") throw new Error("no worst table");
    expect(worst.rows[0]?.service).toBe("Creds");
  });
});

// The focused fixture above pins cell shaping. This one is a capture of a real
// `osdu-quality release` payload, so it is the only fixture that reaches the row
// caps, carries the CLI's own `aggregates`, and contains the `status: "missing"`
// / `errors` / `sonar.source` fields the live CLI emits. Its job is to keep the
// board honest against the aggregates the same response ships.
describe("buildQualityBoard against a live-shaped payload", () => {
  const live = liveReport as ReleaseReport;
  const aggregates = (liveReport as { aggregates: Record<string, number> }).aggregates;
  const liveBoard = buildQualityBoard(live);
  const liveTable = buildQualityTable(live);
  const segmentsOf = (title: string) => {
    const s = liveBoard.sections.find((x) => x.kind === "segments" && x.title === title);
    if (s?.kind !== "segments") throw new Error(`no ${title} segments`);
    return s.items;
  };

  test("emits a valid board and reaches both row caps", () => {
    expect(canvasViewSchema.safeParse(liveBoard).success).toBe(true);
    expect(live.services?.length).toBeGreaterThan(10);
    const tables = liveBoard.sections.filter((s) => s.kind === "table");
    for (const t of tables) {
      if (t.kind !== "table") throw new Error("expected table");
      expect(t.rows).toHaveLength(10);
    }
  });

  // The defect this guards: bucketing an unmeasured stage as a failure made the
  // pulse disagree with the worst-acceptance table and with the CLI's own count.
  test("Failing matches the CLI's acceptance_below_80, with No data carrying the rest", () => {
    const items = segmentsOf("Test performance");
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.n]));
    expect(byLabel.Failing).toBe(aggregates.acceptance_below_80);
    const missing = (live.services ?? []).filter((s) => s.acceptance?.status === "missing").length;
    expect(missing).toBeGreaterThan(0);
    expect(byLabel["No data"]).toBe(missing);
    // Every service lands in exactly one bucket.
    expect(items.reduce((t, i) => t + i.n, 0)).toBe(live.services?.length ?? 0);
  });

  test("the Gate tile reports the CLI's quality_gate_failing count", () => {
    const stats = liveBoard.sections.find((s) => s.kind === "stats");
    if (stats?.kind !== "stats") throw new Error("no stats section");
    const gate = stats.items.find((i) => i.label === "Gate");
    const scoped = (live.services ?? []).filter((s) => s.sonar?.quality_gate).length;
    expect(gate?.value).toBe(`${aggregates.quality_gate_failing} / ${scoped}`);
    expect(gate?.tone).toBe("error");
  });

  test("both tables disclose that they are a slice, not the platform", () => {
    expect(liveTable.caption).toBe(`Worst 10 of ${live.services?.length} services · main · master`);
    const tables = liveBoard.sections.filter((s) => s.kind === "table");
    for (const t of tables) {
      if (t.kind !== "table") throw new Error("expected table");
      expect(t.caption).toMatch(/^Worst 10 of \d+/);
    }
  });

  // `release` is the sentinel "default" in the live payload, so the title must
  // fall through to the branch label rather than printing the sentinel.
  test("the title uses the branch label when release is the sentinel", () => {
    expect(live.release).toBe("default");
    expect(liveBoard.title).toBe("Quality · main · master");
  });

  // The design-proposal numbers, pinned: every Fail traces to a sub-50 signal
  // the board displays, and the three signal-less services read No data instead
  // of the letter-driven 15-Fail the old min-of-grades axis produced.
  test("header pulse reads Good 4 · Poor 7 · Fail 9 · No data 3", () => {
    expect(liveBoard.header?.segments).toEqual([
      { label: "Good", n: 4, tone: "ok" },
      { label: "Poor", n: 7, tone: "warn" },
      { label: "Fail", n: 9, tone: "error" },
      { label: "No data", n: 3, tone: "neutral" },
    ]);
  });

  test("no-data services never occupy a worst-first table slot", () => {
    const noData = (live.services ?? [])
      .filter(
        (s) =>
          s.sonar?.coverage_pct == null &&
          s.unit?.pass_rate == null &&
          s.acceptance?.pass_rate == null,
      )
      .map((s) => s.display_name || s.name);
    expect(noData.length).toBe(3);
    const shown = liveTable.rows.map((r) => {
      const c = r.service;
      return c && typeof c === "object" ? (c as { value?: unknown }).value : c;
    });
    for (const name of noData) expect(shown).not.toContain(name);
  });

  test("worst-acceptance rows carry the sample size beside the rate", () => {
    const tables = liveBoard.sections.filter((s) => s.kind === "table");
    const worst = tables[tables.length - 1];
    if (worst?.kind !== "table") throw new Error("no worst table");
    expect(worst.columns.map((c) => c.key)).toContain("n");
    // Notification's 0% is a two-test sample — the n cell is what says so.
    const notification = worst.rows.find((r) => {
      const c = r.service;
      return (c && typeof c === "object" ? (c as { value?: unknown }).value : c) === "Notification";
    });
    expect(notification?.n).toBe("2");
  });
});
