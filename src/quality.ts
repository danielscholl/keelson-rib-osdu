import type {
  CanvasBoardView,
  CanvasCell,
  CanvasCellBadge,
  CanvasTableView,
  CanvasTone,
  RibExec,
} from "@keelson/shared";
import {
  defaultCacheDir,
  readCacheEntry,
  releaseLock,
  tryClaimLock,
  ttlFromEnv,
  writeCacheEntry,
} from "./cache.ts";
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
// stage bars, and the worst-acceptance table sum over. `status` is the CLI's own
// verdict; "missing" marks a stage it found no job for, which must not read as a
// failure.
export interface TestMetrics {
  pass_rate?: number | null;
  passed?: number | null;
  failed?: number | null;
  skipped?: number | null;
  status?: string | null;
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
  generated_at?: string | null;
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
//
// The unscoped report is the rib's single heaviest GitLab load (a pipelines +
// Sonar sweep of every core service), and Quality and Security both need it —
// often at the same instant, since a stale surface fires both lanes on open. So
// unscoped fetches ride the cross-process file cache with a single-flight lock:
// the loser waits for the winner's write instead of duplicating the sweep. A
// scoped call bypasses the cache; a TTL of 0 disables it entirely.
export interface ReportCacheDeps {
  cacheDir?: string | null;
  ttlMs?: number;
  now?: () => number;
  lockWaitMs?: number;
  lockPollMs?: number;
}

const REPORT_CACHE_VERSION = 1;
const REPORT_CACHE_FILE = `release-report-v${REPORT_CACHE_VERSION}.json`;
const REPORT_LOCK_FILE = `${REPORT_CACHE_FILE}.lock`;
const REPORT_TTL_MS = 600_000;
// The unscoped sweep runs ~40s alone, but the GitLab-backed lanes all fire on
// surface open and it slows several-fold under that contention.
const REPORT_FETCH_TIMEOUT_MS = 240_000;
// Ordered past REPORT_FETCH_TIMEOUT_MS so a waiter only self-fetches once the
// holder has settled; the index.ts node timeouts must clear the worst case,
// REPORT_LOCK_WAIT_MS + REPORT_FETCH_TIMEOUT_MS.
const REPORT_LOCK_WAIT_MS = 250_000;
const REPORT_LOCK_STALE_MS = 270_000;
const REPORT_LOCK_POLL_MS = 1_000;

export async function fetchReleaseReport(
  exec: RibExec = localExec(),
  services: readonly string[] = [],
  deps: ReportCacheDeps = {},
): Promise<{ report: ReleaseReport; error?: string }> {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? ttlFromEnv("KEELSON_OSDU_REPORT_TTL_MS", REPORT_TTL_MS);
  const cacheDir =
    services.length > 0 || ttlMs <= 0 || deps.cacheDir === null
      ? null
      : (deps.cacheDir ?? defaultCacheDir());
  const read = (): ReleaseReport | null =>
    cacheDir
      ? readCacheEntry<ReleaseReport>(
          cacheDir,
          REPORT_CACHE_FILE,
          REPORT_CACHE_VERSION,
          now(),
          ttlMs,
        )
      : null;

  let hit = read();
  if (hit) return { report: hit };

  let locked = false;
  if (cacheDir) {
    locked = tryClaimLock(cacheDir, REPORT_LOCK_FILE, REPORT_LOCK_STALE_MS);
    if (!locked) {
      const pollMs = deps.lockPollMs ?? REPORT_LOCK_POLL_MS;
      const deadline = Date.now() + (deps.lockWaitMs ?? REPORT_LOCK_WAIT_MS);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        hit = read();
        if (hit) return { report: hit };
        // Lock gone with nothing cached: the holder failed — take over.
        if (tryClaimLock(cacheDir, REPORT_LOCK_FILE, REPORT_LOCK_STALE_MS)) {
          locked = true;
          break;
        }
      }
    }
  }

  try {
    // A rival may have fetched, written, and released between the first read
    // and this claim — re-check before paying for the sweep.
    if (locked) {
      hit = read();
      if (hit) return { report: hit };
    }
    const args = ["release", "--output", "json"];
    if (services.length > 0) args.push("--service", services.join(","));
    const res = await exec.runJSON<ReleaseReport>("osdu-quality", args, {
      timeoutMs: REPORT_FETCH_TIMEOUT_MS,
    });
    if (!res.ok) return { report: { services: [] }, error: res.error };
    if (cacheDir) {
      writeCacheEntry(cacheDir, REPORT_CACHE_FILE, REPORT_CACHE_VERSION, res.data, now());
    }
    return { report: res.data };
  } finally {
    if (cacheDir && locked) releaseLock(cacheDir, REPORT_LOCK_FILE);
  }
}

export type Tone = CanvasTone;
type Cell = CanvasCell;

// Pass-rate / coverage tone thresholds mirror cimpl-agent's SonarTable (passCls
// 95/80, covCls 80/50) so the lane's colours match the prototype.
const PASS_GREEN = 95;
const PASS_YELLOW = 80;
const COV_GREEN = 80;
// Matches the PMC report's own coverage_status band, so a service doesn't read
// amber here and red there.
const COV_YELLOW = 60;
// Weakest-link service health, bucketed at 80 (good) / 50 (fail). Drives the
// Good/Poor/Fail pulse and the worst-first sort.
const HEALTH_GOOD = 80;
const HEALTH_FAIL = 50;
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
// A stage the CLI found no job for. Distinct from a failing stage: it carries no
// rate, and the CLI says so outright in `status`.
function stageMissing(m: TestMetrics | null | undefined): boolean {
  return stageRate(m) === null || m?.status === "missing";
}

// The reader-facing label for the report's scope. `release` is the CLI's
// sentinel when no release was resolved, so fall through to the branch label it
// composed for exactly this purpose. Shared with the Security lane so both
// boards title themselves the same way.
export function scopeLabel(report: ReleaseReport): string {
  const release = report.release?.trim();
  if (release && release !== "default") return release;
  return report.branch?.trim() || "current";
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

// Weakest of the signals the board itself displays — coverage and the two pass
// rates — so every red in the headline traces to a visible cell. Sonar letter
// grades are opinions rendered as chips, not failures, and stay off the axis
// (they made three 100%-passing services read "Fail" on a lone letter). Null
// when a service has no numeric signal at all — that is "unknown", not a score.
function serviceHealth(svc: ServiceReport): number | null {
  const signals = [
    num(svc.sonar?.coverage_pct),
    stageRate(svc.unit),
    stageRate(svc.acceptance),
  ].filter((v): v is number => v !== null);
  return signals.length > 0 ? Math.min(...signals) : null;
}

type Segment = { label: string; n: number; tone: Tone };
function buildPulse(services: ServiceReport[]): Segment[] {
  let good = 0;
  let poor = 0;
  let fail = 0;
  let missing = 0;
  for (const svc of services) {
    const h = serviceHealth(svc);
    if (h === null) missing += 1;
    else if (h >= HEALTH_GOOD) good += 1;
    else if (h >= HEALTH_FAIL) poor += 1;
    else fail += 1;
  }
  const segments: Segment[] = [
    { label: "Good", n: good, tone: "ok" },
    { label: "Poor", n: poor, tone: "warn" },
    { label: "Fail", n: fail, tone: "error" },
  ];
  if (missing > 0) segments.push({ label: "No data", n: missing, tone: "neutral" });
  return segments;
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
  // Unit dominates the blended denominator and rarely fails, so name what the
  // percentage is over rather than letting it read as an acceptance figure.
  const gateScoped = services.filter((s) => (s.sonar?.quality_gate ?? "").trim().length > 0);
  const gateFailing = gateScoped.filter(
    (s) => (s.sonar?.quality_gate ?? "").toUpperCase() !== "OK",
  ).length;
  return [
    {
      label: "Pass",
      value: passPct === null ? "—" : `${passPct}%`,
      sub: "unit + acceptance",
      tone: toneRate(passPct),
    },
    // No Flaky tile: `release` carries no flake signal, so it was a permanent
    // `0 · no signal` placeholder. A fifth tile squeezed the row to 90px and wrapped
    // the Gate fraction across two lines, so the slot goes to a signal that exists.
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
    // The Sonar gate is the loudest signal the upstream PMC report leads with,
    // and the report already carries it per service — surface the count so it
    // doesn't take ten table rows to notice.
    {
      label: "Gate",
      value: gateScoped.length > 0 ? `${gateFailing} / ${gateScoped.length}` : "—",
      // Not every service has a Sonar project, so say how many the denominator
      // leaves out rather than letting it pass for the service count.
      sub:
        gateScoped.length === 0
          ? "no signal"
          : services.length > gateScoped.length
            ? `failing · ${services.length - gateScoped.length} no gate`
            : "failing",
      tone: gateScoped.length === 0 ? "neutral" : gateFailing > 0 ? "error" : "ok",
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
      // The table ranks measured evidence; a no-signal service sorts last (its
      // count rides the header's "No data" segment) instead of displacing a
      // genuinely failing row from the visible slice.
      health: serviceHealth(svc) ?? Number.POSITIVE_INFINITY,
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
    // Say when the slice is a slice: 10 of 23 rows with no caption reads as the
    // whole platform.
    caption:
      rows.length < services.length
        ? `Worst ${rows.length} of ${services.length} services · ${scopeLabel(report)}`
        : `Quality · ${services.length} services · ${scopeLabel(report)}`,
  };
}

// ---- Test performance: pulse + aggregate stage bars + worst-acceptance table ----
// An unmeasured service gets its own bucket rather than reading as a failure:
// counting it red made this pulse contradict the worst-acceptance table below it,
// which filters those services out, and the CLI's own `acceptance_below_80`.
function buildTestPulse(services: ServiceReport[]): Segment[] {
  let passing = 0;
  let slipping = 0;
  let failing = 0;
  let missing = 0;
  for (const svc of services) {
    const a = stageRate(svc.acceptance);
    if (stageMissing(svc.acceptance)) missing += 1;
    else if ((a as number) >= PASS_GREEN) passing += 1;
    else if ((a as number) >= PASS_YELLOW) slipping += 1;
    else failing += 1;
  }
  const segments: Segment[] = [
    { label: "Passing", n: passing, tone: "ok" },
    { label: "Slipping", n: slipping, tone: "warn" },
    { label: "Failing", n: failing, tone: "error" },
  ];
  if (missing > 0) segments.push({ label: "No data", n: missing, tone: "neutral" });
  return segments;
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
// `n` (total tests run) sits beside the rate so a 0% on a 2-test sample can't
// read as the peer of a 30% with 98 real failures.
const WORST_COLUMNS = [
  { key: "service", label: "Service" },
  { key: "pct", label: "Pass %" },
  { key: "n", label: "n" },
  { key: "passed", label: "Pass" },
  { key: "skipped", label: "Skip" },
  { key: "failed", label: "Fail" },
];
function buildWorstAcceptance(services: ServiceReport[]): CanvasTableView {
  const eligible = services.filter(
    (svc) => hasCounts(svc.acceptance) && stageRate(svc.acceptance) !== null,
  ).length;
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
          n: `${(r.passed + r.failed + r.skipped).toLocaleString()}`,
          passed: countCell(r.passed, "ok"),
          skipped: countCell(r.skipped, "warn"),
          failed: countCell(r.failed, "error"),
        }) satisfies Record<string, Cell>,
    );
  return {
    view: "table",
    columns: WORST_COLUMNS,
    rows,
    caption:
      rows.length < eligible
        ? `Worst ${rows.length} of ${eligible} measured services`
        : `${rows.length} measured service${rows.length === 1 ? "" : "s"}`,
  };
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
    sections.push({
      kind: "table",
      columns: sonar.columns,
      rows: sonar.rows,
      ...(sonar.caption ? { caption: sonar.caption } : {}),
    });
    sections.push({ kind: "segments", title: "Test performance", items: buildTestPulse(services) });
    const bars = [
      // Acceptance is the CLI's gitlab-dev environment; the upstream report
      // measures three, so name which one this is rather than implying all.
      stageBar("Unit tests", services, (s) => s.unit),
      stageBar("Acceptance tests (gitlab dev)", services, (s) => s.acceptance),
    ].filter((b): b is BarItem => b !== null);
    if (bars.length > 0) sections.push({ kind: "bars", items: bars });
    const worst = buildWorstAcceptance(services);
    if (worst.rows.length > 0)
      sections.push({
        kind: "table",
        columns: worst.columns,
        rows: worst.rows,
        ...(worst.caption ? { caption: worst.caption } : {}),
      });
  }

  return {
    view: "board",
    title: `Quality · ${scopeLabel(report)}`,
    header: { segments: buildPulse(services) },
    sections,
  };
}
