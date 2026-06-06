import type { CanvasBoardView, CanvasTableView } from "@keelson/shared";

// Shape of `osdu-quality release --output json`. Only the fields the table
// reads are modeled; the CLI emits more (pipeline urls, ncloc, …).
export interface SonarMetrics {
  coverage_pct?: number | null;
  reliability_rating?: string | null;
  security_rating?: string | null;
  maintainability_rating?: string | null;
}
export interface TestMetrics {
  pass_rate?: number | null;
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

export type Tone = "ok" | "warn" | "error" | "neutral" | "info" | "caution" | "brand";
type Scalar = string | number | boolean | null;
type Cell = Scalar | { value: Scalar; tone?: Tone };

// Pass-rate thresholds mirror the osdu-quality release report (GREEN_AT=85,
// YELLOW_AT=70); coverage uses a softer industry bar.
const RATE_GREEN = 85;
const RATE_YELLOW = 70;
const COVERAGE_GREEN = 70;
const COVERAGE_YELLOW = 50;

const COLUMNS = [
  { key: "service", label: "Service" },
  { key: "accept", label: "Accept %" },
  { key: "unit", label: "Unit %" },
  { key: "coverage", label: "Cov %" },
  { key: "reliability", label: "Reliability" },
  { key: "security", label: "Security" },
  { key: "maintainability", label: "Maintainability" },
  { key: "cve", label: "CVE C/H" },
];

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toneRate(value: number | null): Tone {
  if (value === null) return "neutral";
  if (value >= RATE_GREEN) return "ok";
  if (value >= RATE_YELLOW) return "warn";
  return "error";
}

function toneCoverage(value: number | null): Tone {
  if (value === null) return "neutral";
  if (value >= COVERAGE_GREEN) return "ok";
  if (value >= COVERAGE_YELLOW) return "warn";
  return "error";
}

function toneRating(rating: string | null | undefined): Tone {
  if (!rating) return "neutral";
  const r = rating.toUpperCase();
  if (r === "A") return "ok";
  if (r === "B" || r === "C") return "warn";
  if (r === "D" || r === "E") return "error";
  return "neutral";
}

// A bare scalar for an untoned cell; a {value, tone} object otherwise.
function cell(value: Scalar, tone: Tone): Cell {
  return tone === "neutral" ? value : { value, tone };
}

/**
 * Shape an `osdu-quality release` JSON report into a canvas table view. Mirrors
 * the CLI's columns; cells carry a generic `tone` so health reads as colour.
 * Rows are sorted worst-first: most error cells, then most warn cells, then
 * lowest acceptance pass-rate, then name.
 */
export function buildQualityTable(report: ReleaseReport): CanvasTableView {
  const services = report.services ?? [];
  const scored = services.map((svc) => {
    const sonar = svc.sonar ?? {};
    const accept = num(svc.acceptance?.pass_rate);
    const unit = num(svc.unit?.pass_rate);
    const coverage = num(sonar.coverage_pct);
    const reliability = sonar.reliability_rating ?? null;
    const security = sonar.security_rating ?? null;
    const maintainability = sonar.maintainability_rating ?? null;
    const critical = num(svc.vulnerabilities?.critical);
    const high = num(svc.vulnerabilities?.high);

    let cveTone: Tone = "neutral";
    if (svc.vulnerabilities) {
      cveTone = (critical ?? 0) > 0 ? "error" : (high ?? 0) > 0 ? "warn" : "ok";
    }

    const tones = {
      accept: toneRate(accept),
      unit: toneRate(unit),
      coverage: toneCoverage(coverage),
      reliability: toneRating(reliability),
      security: toneRating(security),
      maintainability: toneRating(maintainability),
      cve: cveTone,
    };
    const name = svc.display_name || svc.name || "—";
    const row: Record<string, Cell> = {
      service: name,
      accept: cell(accept ?? "—", tones.accept),
      unit: cell(unit ?? "—", tones.unit),
      coverage: cell(coverage ?? "—", tones.coverage),
      reliability: cell(reliability ?? "—", tones.reliability),
      security: cell(security ?? "—", tones.security),
      maintainability: cell(maintainability ?? "—", tones.maintainability),
      cve: cell(svc.vulnerabilities ? `C${critical ?? 0} / H${high ?? 0}` : "—", tones.cve),
    };
    const toneList = Object.values(tones);
    return {
      row,
      errors: toneList.filter((t) => t === "error").length,
      warns: toneList.filter((t) => t === "warn").length,
      accept: accept ?? -1,
      name: name.toLowerCase(),
    };
  });

  scored.sort(
    (a, b) =>
      b.errors - a.errors ||
      b.warns - a.warns ||
      a.accept - b.accept ||
      a.name.localeCompare(b.name),
  );

  return {
    view: "table",
    columns: COLUMNS,
    rows: scored.map((s) => s.row),
    caption: `Quality · ${services.length} services · ${report.release ?? "current"}`,
  };
}

// Worst tone across a service's signals — drives the good/poor/fail pulse.
function serviceHealth(svc: ServiceReport): "ok" | "warn" | "error" {
  const tones: Tone[] = [
    toneRate(num(svc.acceptance?.pass_rate)),
    toneRate(num(svc.unit?.pass_rate)),
    toneCoverage(num(svc.sonar?.coverage_pct)),
    toneRating(svc.sonar?.reliability_rating),
    toneRating(svc.sonar?.security_rating),
    toneRating(svc.sonar?.maintainability_rating),
  ];
  if (svc.vulnerabilities) {
    const critical = num(svc.vulnerabilities.critical) ?? 0;
    const high = num(svc.vulnerabilities.high) ?? 0;
    tones.push(critical > 0 ? "error" : high > 0 ? "warn" : "ok");
  }
  if (tones.includes("error")) return "error";
  if (tones.includes("warn")) return "warn";
  return "ok";
}

function average(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 10) / 10;
}

/**
 * Shape an `osdu-quality release` report into a composite board — a good/poor/
 * fail pulse, KPI tiles, and the per-service table as a section. Reuses
 * {@link buildQualityTable} for the table block.
 */
export function buildQualityBoard(report: ReleaseReport): CanvasBoardView {
  const services = report.services ?? [];
  let good = 0;
  let poor = 0;
  let fail = 0;
  for (const svc of services) {
    const health = serviceHealth(svc);
    if (health === "error") fail++;
    else if (health === "warn") poor++;
    else good++;
  }

  const avgAccept = average(services.map((s) => num(s.acceptance?.pass_rate)));
  const avgUnit = average(services.map((s) => num(s.unit?.pass_rate)));
  const withCriticals = services.filter((s) => (num(s.vulnerabilities?.critical) ?? 0) > 0).length;

  const table = buildQualityTable(report);

  return {
    view: "board",
    title: `Quality · ${report.release ?? "current"}`,
    header: {
      segments: [
        { label: "Good", n: good, tone: "ok" },
        { label: "Poor", n: poor, tone: "warn" },
        { label: "Fail", n: fail, tone: "error" },
      ],
    },
    sections: [
      {
        kind: "stats",
        items: [
          { label: "Services", value: services.length },
          {
            label: "Avg Accept",
            value: avgAccept ?? "—",
            sub: "pass rate",
            tone: toneRate(avgAccept),
          },
          { label: "Avg Unit", value: avgUnit ?? "—", sub: "pass rate", tone: toneRate(avgUnit) },
          {
            label: "Critical CVEs",
            value: withCriticals,
            sub: "services",
            tone: withCriticals > 0 ? "error" : "ok",
          },
        ],
      },
      {
        kind: "table",
        title: "Services · worst first",
        columns: table.columns,
        rows: table.rows,
        caption: table.caption,
      },
    ],
  };
}
