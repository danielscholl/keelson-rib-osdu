import type {
  CanvasBoardView,
  CanvasCell,
  CanvasCellBadge,
  CanvasTableView,
  CanvasTone,
  RibExec,
} from "@keelson/shared";
import { localExec } from "./exec.ts";

// Shape of `osdu-quality release --output json`. Only the fields the lane reads
// are modeled; the CLI emits more (allure links, ncloc, …).
export interface SonarMetrics {
  coverage_pct?: number | null;
  quality_gate?: string | null;
  reliability_rating?: string | null;
  security_rating?: string | null;
  maintainability_rating?: string | null;
  sonar_url?: string | null;
}
// A per-stage test result — a pass rate plus the raw counts the KPI tiles, the
// stage bars, and the worst-acceptance table sum over.
export interface TestMetrics {
  pass_rate?: number | null;
  passed?: number | null;
  failed?: number | null;
  skipped?: number | null;
}
export interface VulnCounts {
  critical?: number | null;
  high?: number | null;
  medium?: number | null;
  low?: number | null;
  info?: number | null;
  unknown?: number | null;
}
export interface ServiceReport {
  name?: string;
  display_name?: string | null;
  gitlab_path?: string | null;
  pipeline_url?: string | null;
  sonar?: SonarMetrics | null;
  unit?: TestMetrics | null;
  acceptance?: TestMetrics | null;
  vulnerabilities?: VulnCounts | null;
}
export interface ReleaseReport {
  release?: string | null;
  branch?: string | null;
  services?: ServiceReport[];
}

// Fetch the one-shot `osdu-quality release` report (auth via GITLAB_TOKEN/glab).
// Shared by the Quality + Security collectors and the `osdu_quality` chat tool.
// Degrades to an empty report with `error` set, so a CLI-missing / auth-expired
// failure is distinguishable from a genuinely empty report (collectors log it;
// the tool surfaces it in `notes`).
//
// `services` scopes the report to named services via the CLI's own `--service`
// flag; empty means every service in the CLI's service map. The collectors pass
// nothing, so the published boards stay platform-wide.
export async function fetchReleaseReport(
  exec: RibExec = localExec(),
  services: readonly string[] = [],
): Promise<{ report: ReleaseReport; error?: string }> {
  const args = ["release", "--output", "json"];
  if (services.length > 0) args.push("--service", services.join(","));
  const res = await exec.runJSON<ReleaseReport>("osdu-quality", args, {
    timeoutMs: 120_000,
  });
  return res.ok ? { report: res.data } : { report: { services: [] }, error: res.error };
}

export type Tone = CanvasTone;
type Cell = CanvasCell;

// Pass-rate / coverage tone thresholds mirror cimpl-agent's SonarTable (passCls
// 95/80, covCls 80/50) so the lane's colours match the prototype.
const PASS_GREEN = 95;
const PASS_YELLOW = 80;
const COV_GREEN = 80;
const COV_YELLOW = 50;
// Weakest-link service health (cimpl-agent ReleaseAnalyzer): grade A–E → 100…20,
// an absent signal floors at 70 (concerning, not confirmed-broken), bucketed at
// 80 (good) / 50 (fail). Drives the Good/Poor/Fail pulse and the worst-first sort.
const HEALTH_GOOD = 80;
const HEALTH_FAIL = 50;
const NULL_FLOOR = 70;
const SONAR_CAP = 10;
const WORST_CAP = 10;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
function stageCounts(m: TestMetrics | null | undefined): {
  passed: number;
  failed: number;
  skipped: number;
} {
  return {
    passed: num(m?.passed) ?? 0,
    failed: num(m?.failed) ?? 0,
    skipped: num(m?.skipped) ?? 0,
  };
}
// A stage's pass rate: the reported `pass_rate`, else derived from counts as
// passed/(passed+failed+skipped) — the same total-tests denominator the stage
// bars and KPI tiles use, so every count-derived view agrees on a counts-only
// stage instead of the pulse/table and the bar disagreeing.
function stageRate(m: TestMetrics | null | undefined): number | null {
  const reported = num(m?.pass_rate);
  if (reported !== null) return reported;
  const c = stageCounts(m);
  const total = c.passed + c.failed + c.skipped;
  return total > 0 ? round1((c.passed / total) * 100) : null;
}
// Whether a stage carries any raw count. Distinguishes a real zero from
// "unknown" so the count-derived sections (KPI Fail/Skip, bars, worst table)
// don't fabricate zeros for a pass-rate-only / partial report.
function hasCounts(m: TestMetrics | null | undefined): boolean {
  return num(m?.passed) !== null || num(m?.failed) !== null || num(m?.skipped) !== null;
}

function toneRate(value: number | null): Tone {
  if (value === null) return "neutral";
  if (value >= PASS_GREEN) return "ok";
  if (value >= PASS_YELLOW) return "warn";
  return "error";
}
function toneCoverage(value: number | null): Tone {
  if (value === null) return "neutral";
  if (value >= COV_GREEN) return "ok";
  if (value >= COV_YELLOW) return "warn";
  return "error";
}
// 5-step grade ramp (A green · B cyan · C yellow · D orange · E red); unknown
// reads neutral. Mirrors the Security lane's SAST grades.
function gradeTone(rating: string): Tone {
  switch (rating) {
    case "A":
      return "ok";
    case "B":
      return "info";
    case "C":
      return "warn";
    case "D":
      return "caution";
    case "E":
      return "error";
    default:
      return "neutral";
  }
}
function gradeBadge(rating: string | null | undefined): CanvasCellBadge {
  const r = (rating ?? "").toUpperCase();
  const text = r.length === 1 && "ABCDE".includes(r) ? r : "—";
  return text === "—" ? { text } : { text, tone: gradeTone(text) };
}

const GRADE_SCORE: Record<string, number> = { A: 100, B: 80, C: 60, D: 40, E: 20 };
function gradeScore(rating: string | null | undefined): number {
  return GRADE_SCORE[(rating ?? "").toUpperCase()] ?? NULL_FLOOR;
}
// Weakest signal across grades + coverage + pass rates; an absent number floors
// at NULL_FLOOR so an unscanned service reads "poor", not "fail".
function serviceHealth(svc: ServiceReport): number {
  const sonar = svc.sonar ?? {};
  return Math.min(
    gradeScore(sonar.reliability_rating),
    gradeScore(sonar.security_rating),
    gradeScore(sonar.maintainability_rating),
    num(sonar.coverage_pct) ?? NULL_FLOOR,
    stageRate(svc.unit) ?? NULL_FLOOR,
    stageRate(svc.acceptance) ?? NULL_FLOOR,
  );
}

type Segment = { label: string; n: number; tone: Tone };
function buildPulse(services: ServiceReport[]): Segment[] {
  let good = 0;
  let poor = 0;
  let fail = 0;
  for (const svc of services) {
    const h = serviceHealth(svc);
    if (h >= HEALTH_GOOD) good += 1;
    else if (h >= HEALTH_FAIL) poor += 1;
    else fail += 1;
  }
  return [
    { label: "Good", n: good, tone: "ok" },
    { label: "Poor", n: poor, tone: "warn" },
    { label: "Fail", n: fail, tone: "error" },
  ];
}

// ---- KPI tiles: Pass / Flaky / Fail / Skip, summed across unit + acceptance ----
type StatItem = { label: string; value: string | number; sub?: string; tone?: Tone };
function buildKpis(services: ServiceReport[]): StatItem[] {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const svc of services) {
    for (const stage of [svc.unit, svc.acceptance]) {
      const c = stageCounts(stage);
      passed += c.passed;
      failed += c.failed;
      skipped += c.skipped;
    }
  }
  const total = passed + failed + skipped;
  const passPct = total > 0 ? round1((passed / total) * 100) : null;
  const ofTotal = (n: number) => (total > 0 ? `${round1((n / total) * 100)}% of total` : "—");
  return [
    {
      label: "Pass",
      value: passPct === null ? "—" : `${passPct}%`,
      sub: "CI tests",
      tone: toneRate(passPct),
    },
    // `release` carries no flake signal — mirrors cimpl-agent's deferred Flaky tile.
    { label: "Flaky", value: 0, sub: "no signal", tone: "neutral" },
    // With no counts at all, Fail/Skip are unknown (not zero) — show a dash.
    {
      label: "Fail",
      value: total > 0 ? failed : "—",
      sub: ofTotal(failed),
      tone: total > 0 && failed > 0 ? "error" : total > 0 ? "ok" : "neutral",
    },
    {
      label: "Skip",
      value: total > 0 ? skipped : "—",
      sub: ofTotal(skipped),
      tone: total > 0 && skipped > 0 ? "warn" : "neutral",
    },
  ];
}

// ---- Sonar table: Service · Acc · Unit · Quality(coverage% + R/S/M grades) ----
function pctCell(value: number | null): Cell {
  return value === null ? "—" : { value: `${value.toFixed(1)}%`, tone: toneRate(value) };
}
// Emit an href only for http(s) URLs — the base renderer drops unsafe schemes,
// but keep the producer honest (mirrors the Security lane's protocol guard).
function httpHref(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const p = new URL(raw);
    if (p.protocol !== "http:" && p.protocol !== "https:") return undefined;
    if (p.username || p.password) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}
function serviceCell(label: string, url: string | null | undefined): Cell {
  const href = httpHref(url);
  return href ? { value: label, href } : label;
}
function qualityCell(sonar: SonarMetrics | null | undefined): Cell {
  const s = sonar ?? {};
  const coverage = num(s.coverage_pct);
  return {
    value: coverage === null ? "—" : `${Math.round(coverage)}%`,
    tone: toneCoverage(coverage),
    badges: [
      gradeBadge(s.reliability_rating),
      gradeBadge(s.security_rating),
      gradeBadge(s.maintainability_rating),
    ],
  };
}
const SONAR_COLUMNS = [
  { key: "service", label: "Service" },
  { key: "accept", label: "Acc" },
  { key: "unit", label: "Unit" },
  { key: "quality", label: "Quality" },
];
/**
 * Shape an `osdu-quality release` report into the Sonar table — Service · Acc %
 * · Unit % · a Quality cell packing coverage % beside R/S/M grade chips. Rows
 * are worst-health first, capped to the lane's depth.
 */
export function buildQualityTable(report: ReleaseReport): CanvasTableView {
  const services = report.services ?? [];
  const rows = services
    .map((svc) => ({
      health: serviceHealth(svc),
      name: (svc.display_name || svc.name || "—").toLowerCase(),
      row: {
        service: serviceCell(svc.display_name || svc.name || "—", svc.sonar?.sonar_url),
        accept: pctCell(stageRate(svc.acceptance)),
        unit: pctCell(stageRate(svc.unit)),
        quality: qualityCell(svc.sonar),
      } satisfies Record<string, Cell>,
    }))
    .sort((a, b) => a.health - b.health || a.name.localeCompare(b.name))
    .slice(0, SONAR_CAP)
    .map((s) => s.row);
  return {
    view: "table",
    columns: SONAR_COLUMNS,
    rows,
    caption: `Quality · ${services.length} services · ${report.release ?? "current"}`,
  };
}

// ---- Test performance: pulse + aggregate stage bars + worst-acceptance table ----
function buildTestPulse(services: ServiceReport[]): Segment[] {
  let passing = 0;
  let slipping = 0;
  let failing = 0;
  for (const svc of services) {
    const a = stageRate(svc.acceptance);
    // An unmeasured service reads failing, mirroring cimpl-agent's bucket.
    if (a === null) failing += 1;
    else if (a >= PASS_GREEN) passing += 1;
    else if (a >= PASS_YELLOW) slipping += 1;
    else failing += 1;
  }
  return [
    { label: "Passing", n: passing, tone: "ok" },
    { label: "Slipping", n: slipping, tone: "warn" },
    { label: "Failing", n: failing, tone: "error" },
  ];
}

type BarItem = { label: string; value: number; total: number; tone?: Tone; trailing?: string };
function stageBar(
  label: string,
  services: ServiceReport[],
  pick: (s: ServiceReport) => TestMetrics | null | undefined,
): BarItem | null {
  let passed = 0;
  let total = 0;
  for (const svc of services) {
    const c = stageCounts(pick(svc));
    passed += c.passed;
    total += c.passed + c.failed + c.skipped;
  }
  if (total <= 0) return null;
  const pct = round1((passed / total) * 100);
  return {
    label,
    value: passed,
    total,
    tone: toneRate(pct),
    trailing: `${passed.toLocaleString()} / ${total.toLocaleString()} · ${pct.toFixed(1)}%`,
  };
}

// A filled count chip — toned when non-zero, dim at zero (mirrors the prototype).
function countCell(n: number, tone: Tone): Cell {
  return { badges: [n > 0 ? { text: n.toLocaleString(), tone } : { text: n.toLocaleString() }] };
}
const WORST_COLUMNS = [
  { key: "service", label: "Service" },
  { key: "pct", label: "Pass %" },
  { key: "passed", label: "Pass" },
  { key: "skipped", label: "Skip" },
  { key: "failed", label: "Fail" },
];
function buildWorstAcceptance(services: ServiceReport[]): CanvasTableView {
  const rows = services
    .map((svc) => ({
      name: svc.display_name || svc.name || "—",
      pipeline_url: svc.pipeline_url ?? null,
      present: hasCounts(svc.acceptance),
      ...stageCounts(svc.acceptance),
      pct: stageRate(svc.acceptance),
    }))
    // A pass-rate-only stage has no counts to break down — the Sonar table
    // already shows its rate, so it doesn't belong in the count table.
    .filter((r) => r.present && r.pct !== null)
    .sort(
      (a, b) =>
        (a.pct ?? Number.POSITIVE_INFINITY) - (b.pct ?? Number.POSITIVE_INFINITY) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, WORST_CAP)
    .map(
      (r) =>
        ({
          service: serviceCell(r.name, r.pipeline_url),
          pct: r.pct === null ? "—" : { value: `${Math.round(r.pct)}%`, tone: toneRate(r.pct) },
          passed: countCell(r.passed, "ok"),
          skipped: countCell(r.skipped, "warn"),
          failed: countCell(r.failed, "error"),
        }) satisfies Record<string, Cell>,
    );
  return { view: "table", columns: WORST_COLUMNS, rows };
}

/**
 * Shape an `osdu-quality release` report into the Quality board — a Good/Poor/
 * Fail pulse, Pass/Flaky/Fail/Skip KPI tiles, the Sonar table, and a Test
 * Performance block (Passing/Slipping/Failing pulse, aggregate Unit/Acceptance
 * bars, and a worst-acceptance table). Degrades to a valid empty board.
 */
export function buildQualityBoard(report: ReleaseReport): CanvasBoardView {
  const services = report.services ?? [];
  const sections: CanvasBoardView["sections"] = [{ kind: "stats", items: buildKpis(services) }];

  if (services.length > 0) {
    const sonar = buildQualityTable(report);
    sections.push({ kind: "table", columns: sonar.columns, rows: sonar.rows });
    sections.push({ kind: "segments", title: "Test performance", items: buildTestPulse(services) });
    const bars = [
      stageBar("Unit tests", services, (s) => s.unit),
      stageBar("Acceptance tests", services, (s) => s.acceptance),
    ].filter((b): b is BarItem => b !== null);
    if (bars.length > 0) sections.push({ kind: "bars", items: bars });
    const worst = buildWorstAcceptance(services);
    if (worst.rows.length > 0)
      sections.push({ kind: "table", columns: worst.columns, rows: worst.rows });
  }

  return {
    view: "board",
    title: `Quality · ${report.release ?? "current"}`,
    header: { segments: buildPulse(services) },
    sections,
  };
}
