import type { CanvasBoardView, RibExec } from "@keelson/shared";
import { errText } from "@keelson/shared";
import {
  GITLAB_GROUP,
  GITLAB_HOST,
  loadVenusBundle,
  runGraphql,
  serviceOf,
  VENUS_CORE,
} from "./activity.ts";
import { localExec } from "./exec.ts";
import {
  fetchReleaseReport,
  type ReleaseReport,
  type ServiceReport,
  type Tone,
  type VulnCounts,
} from "./quality.ts";

// Per-CVE detail from GitLab's `vulnerabilities` GraphQL connection, plus the
// OSV.dev fix-version map. Only the fields the board reads are modeled.
export interface VulnRecord {
  project_path: string;
  cve_id: string;
  severity: string;
  package_name: string;
  current_version: string;
  detected_at: string;
  state: string;
  web_url: string;
}

// Shape of `osdu-activity mr --output json` rows, the fields the Vuln-MRs tile
// reads. Vulnerability/dependency MRs are matched by label.
export interface SecurityMr {
  state?: string | null;
  draft?: boolean;
  labels?: string[];
  project_path?: string | null;
  iid?: number | null;
  detailed_merge_status?: string | null;
  latest_pipeline_status?: string | null;
}

// Flatten the bundle MR envelope (already core-scoped, project_path-stamped) to
// the fields the Vuln-MRs tile reads.
export function extractSecurityMrs(raw: unknown): SecurityMr[] {
  const projects = (raw as { data?: { projects?: unknown } } | null)?.data?.projects;
  if (!Array.isArray(projects)) return [];
  const out: SecurityMr[] = [];
  for (const p of projects) {
    const proj = p as { project_path?: string | null; merge_requests?: unknown };
    const path = proj.project_path ?? null;
    const mrs = Array.isArray(proj.merge_requests) ? proj.merge_requests : [];
    for (const m of mrs) {
      if (!m || typeof m !== "object") continue;
      const mr = m as SecurityMr;
      out.push({
        state: mr.state,
        draft: mr.draft,
        labels: mr.labels,
        iid: mr.iid,
        detailed_merge_status: mr.detailed_merge_status,
        latest_pipeline_status: mr.latest_pipeline_status,
        project_path: mr.project_path ?? path,
      });
    }
  }
  return out;
}

// GitLab's severity ladder, worst first. Exported as the vocabulary a caller can
// filter on; `severityRank` orders a report so any row cap keeps what matters.
export const SEVERITIES = ["critical", "high", "medium", "low", "unknown", "info"] as const;

export function severityRank(severity: string): number {
  const i = (SEVERITIES as readonly string[]).indexOf(severity);
  return i === -1 ? SEVERITIES.length : i;
}

// Worst first, then oldest first: an aged critical is the most actionable row a
// truncated report can lead with.
export function compareVulns(a: VulnRecord, b: VulnRecord): number {
  const bySeverity = severityRank(a.severity) - severityRank(b.severity);
  if (bySeverity !== 0) return bySeverity;
  return (parseMs(a.detected_at) ?? 0) - (parseMs(b.detected_at) ?? 0);
}

// One row per (project, CVE, package, version). GitLab records a vulnerability
// per detection site, so a CVE in a shared dependency repeats once per module
// that pulls it in — which a reader would otherwise count as separate findings.
// The project stays in the identity: two services sharing a vulnerable
// dependency are two findings to remediate, not one. The earliest detection
// wins, since that is when the exposure actually started.
export function dedupeVulns(vulns: readonly VulnRecord[]): VulnRecord[] {
  const byKey = new Map<string, VulnRecord>();
  for (const v of vulns) {
    const key = `${v.project_path}|${v.cve_id}|${v.package_name}|${v.current_version}`;
    const prior = byKey.get(key);
    if (!prior || (parseMs(v.detected_at) ?? 0) < (parseMs(prior.detected_at) ?? 0)) {
      byKey.set(key, v);
    }
  }
  return [...byKey.values()];
}

const OFFENDERS_CAP = 8;
const AGED_CRITICALS_CAP = 8;
const QUICK_WINS_CAP = 10;
const QUICK_WIN_CVES_CAP = 12;
const DEFAULT_AGED_DAYS = 30;
const DAY_MS = 86_400_000;

// Labels that mark an MR as security-fix work (case-insensitive).
const VULN_MR_LABELS: ReadonlySet<string> = new Set([
  "vulnerability management",
  "dependencies upgrade",
]);

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Sonar letter → the 5-step grade ramp (A green · B cyan · C yellow · D orange ·
// E red), distinct from toneRating's 3-step health bucket. Unknown reads neutral.
function gradeTone(rating: string | null | undefined): Tone {
  switch ((rating ?? "").toUpperCase()) {
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

// Stable per-name hue (djb2 → one of five ramp tones) so neighbouring service
// chips stay visually distinct. Empty names read neutral.
const HASH_TONES: Tone[] = ["accent", "info", "ok", "brand", "caution"];
export function hashTone(name: string): Tone {
  if (!name) return "neutral";
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h) ^ name.charCodeAt(i);
  }
  return HASH_TONES[Math.abs(h) % HASH_TONES.length] ?? "neutral";
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function totals(v: VulnCounts | null | undefined): { crit: number; high: number; medium: number } {
  return { crit: num(v?.critical), high: num(v?.high), medium: num(v?.medium) };
}

// Worst severity present, used to bucket a service in the pulse strip. A null
// vulnerabilities block is "unscanned" — distinct from a scanned-clean zero.
type WorstSeverity = "critical" | "high" | "med" | "clean" | "unscanned";
function worstSeverity(v: VulnCounts | null | undefined): WorstSeverity {
  if (!v) return "unscanned";
  if (num(v.critical) > 0) return "critical";
  if (num(v.high) > 0) return "high";
  if (num(v.medium) > 0 || num(v.low) > 0 || num(v.info) > 0 || num(v.unknown) > 0) return "med";
  return "clean";
}

type Segment = { label: string; n: number; tone: Tone };
function buildPulse(services: ServiceReport[]): Segment[] {
  let critical = 0;
  let high = 0;
  let med = 0;
  let clean = 0;
  for (const svc of services) {
    switch (worstSeverity(svc.vulnerabilities)) {
      case "critical":
        critical += 1;
        break;
      case "high":
        high += 1;
        break;
      case "med":
        med += 1;
        break;
      case "clean":
        clean += 1;
        break;
    }
  }
  return [
    { label: "Crit", n: critical, tone: "error" },
    { label: "High", n: high, tone: "caution" },
    { label: "Med", n: med, tone: "warn" },
    { label: "Clear", n: clean, tone: "ok" },
  ];
}

type StatItem = { label: string; value: string | number; sub?: string; tone?: Tone };
function withUnscanned(sub: string, unscanned: number): string {
  return unscanned > 0 ? `${sub} · ${unscanned} unscanned` : sub;
}

function buildKpis(services: ServiceReport[], mrs: SecurityMr[]): StatItem[] {
  const scanned = services.filter((s) => s.vulnerabilities != null);
  const unscanned = services.length - scanned.length;
  const vulnMr = buildVulnMrTile(mrs);

  if (scanned.length === 0) {
    return [
      { label: "Critical", value: "—", sub: "no scan data" },
      { label: "High", value: "—", sub: "no scan data" },
      { label: "Medium", value: "—", sub: "no scan data" },
      vulnMr,
    ];
  }

  let crit = 0;
  let high = 0;
  let medium = 0;
  for (const svc of scanned) {
    const t = totals(svc.vulnerabilities);
    crit += t.crit;
    high += t.high;
    medium += t.medium;
  }
  return [
    {
      label: "Critical",
      value: crit,
      sub: withUnscanned(crit > 0 ? "in core" : "core is clean", unscanned),
      tone: crit > 0 ? "error" : "ok",
    },
    {
      label: "High",
      value: high,
      sub: withUnscanned(high > 0 ? "in core" : "no high", unscanned),
      tone: high > 0 ? "warn" : "ok",
    },
    {
      label: "Medium",
      value: medium,
      sub: withUnscanned(medium > 0 ? "in core" : "no medium", unscanned),
      tone: "neutral",
    },
    vulnMr,
  ];
}

// Open, non-draft MRs labeled for vulnerability work that are queue-ready.
// Scoped to core, deduped by (project_path, iid) since IIDs are project-scoped.
function buildVulnMrTile(mrs: SecurityMr[]): StatItem {
  const seen = new Set<string>();
  let ready = 0;
  let draft = 0;
  let blocked = 0;
  for (const mr of mrs) {
    if (!VENUS_CORE.has(serviceOf(mr.project_path))) continue;
    if ((mr.state ?? "opened") !== "opened") continue;
    if (!(mr.labels ?? []).some((l) => VULN_MR_LABELS.has(l.trim().toLowerCase()))) continue;
    const key = `${mr.project_path}#${mr.iid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (mr.draft) {
      draft += 1;
      continue;
    }
    const isReady =
      mr.detailed_merge_status === "mergeable" &&
      (mr.latest_pipeline_status ?? "").toLowerCase() !== "failed";
    if (isReady) ready += 1;
    else blocked += 1;
  }
  if (ready + draft + blocked === 0) {
    return { label: "Vuln MRs", value: 0, sub: "none in flight" };
  }
  const tail: string[] = [];
  if (blocked > 0) tail.push(`+${blocked} blocked`);
  if (draft > 0) tail.push(`+${draft} draft`);
  return {
    label: "Vuln MRs",
    value: ready,
    sub: tail.length > 0 ? tail.join(" · ") : "ready to merge",
    tone: ready > 0 ? "ok" : "neutral",
  };
}

type GridCell = { label: string; href?: string; badge: { text: string; tone?: Tone } };

// "Low security rating" cells, worst-first (E→A). Confirmed-A services are
// dropped — only below-A grades and unscanned ("—", a missing scan is itself a
// gap) reach the grid, so the section reads as a problem list, not a full matrix.
function buildSastGrid(services: ServiceReport[]): GridCell[] {
  const rank = (g: string) => {
    // A single-char guard: "".indexOf in any string is 0, so an empty rating
    // would otherwise sort as worst. Unknown / unscanned sorts last.
    const i = g.length === 1 ? "EDCBA".indexOf(g) : -1;
    return i === -1 ? 5 : i;
  };
  const name = (svc: ServiceReport) => svc.display_name || svc.name || "—";
  return services
    .map((svc) => ({ svc, rating: (svc.sonar?.security_rating ?? "").trim().toUpperCase() }))
    .filter(({ rating }) => rating !== "A")
    .sort((a, b) => rank(a.rating) - rank(b.rating) || name(a.svc).localeCompare(name(b.svc)))
    .map(({ svc, rating }) => {
      const href = sonarSecurityRatingUrl(svc.sonar?.sonar_url ?? null);
      return {
        label: name(svc),
        ...(href ? { href } : {}),
        badge: { text: rating || "—", tone: gradeTone(rating) },
      };
    });
}

function sonarSecurityRatingUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const id = parsed.searchParams.get("id");
    if (!id) return null;
    return `${parsed.origin}/component_measures?id=${encodeURIComponent(id)}&metric=security_rating&view=list`;
  } catch {
    return null;
  }
}

type BarItem = {
  label: string;
  value: number;
  total: number;
  tone?: Tone;
  trailing?: string;
  href?: string;
};
// Top services by critical+high count, with a severity bar and crit/high tail.
function buildOffenders(services: ServiceReport[], vulns: VulnRecord[]): BarItem[] {
  const pathByService = new Map<string, string>();
  for (const v of vulns) {
    const svc = serviceOf(v.project_path);
    if (svc && !pathByService.has(svc)) pathByService.set(svc, v.project_path);
  }

  const rows = services
    .filter((svc) => svc.vulnerabilities != null)
    .map((svc) => {
      const t = totals(svc.vulnerabilities);
      return {
        label: svc.display_name || svc.name || "—",
        key: svc.name ?? "",
        crit: t.crit,
        high: t.high,
      };
    })
    .filter((r) => r.crit + r.high > 0)
    .sort((a, b) => b.crit - a.crit || b.high - a.high || a.label.localeCompare(b.label))
    .slice(0, OFFENDERS_CAP);
  const max = rows.reduce((acc, r) => Math.max(acc, r.crit + r.high), 0);
  return rows.map((r) => {
    const projectPath = pathByService.get(r.key);
    const href = projectPath
      ? `https://${GITLAB_HOST}/${projectPath}/-/security/vulnerability_report`
      : undefined;
    return {
      label: r.label,
      value: r.crit + r.high,
      total: max,
      tone: r.crit > 0 ? "error" : "warn",
      trailing: `${r.crit} crit · ${r.high} high`,
      ...(href ? { href } : {}),
    };
  });
}

type RowItem = {
  glyph?: Tone;
  chip?: { label: string; tone?: Tone };
  text: string;
  href?: string;
  trailing?: string;
  detail?: string;
};

// GitLab writes a Maven coordinate as `group/artifact`, where the reverse-DNS
// group is a repeated prefix that wraps a row onto a second line. Anything else
// — a Go module path, an npm scope, a bare name — is already the whole identity
// and is returned untouched; a shortened name keeps its full form in `detail`.
function artifactLabel(packageName: string): string {
  const [group, artifact, ...rest] = packageName.split("/");
  if (rest.length > 0 || !group || !artifact) return packageName;
  if (group.startsWith("@") || !group.includes(".")) return packageName;
  return artifact;
}

// Critical CVEs in DETECTED/CONFIRMED state older than the aged threshold,
// oldest first. `now` is injected so age math is deterministic in tests.
function buildAgedCriticals(vulns: VulnRecord[], now: Date, agedDays: number): RowItem[] {
  const cutoff = agedDays * DAY_MS;
  return vulns
    .filter((v) => v.severity === "critical")
    .filter((v) => v.state === "DETECTED" || v.state === "CONFIRMED")
    .map((v) => ({ v, detected: parseMs(v.detected_at) }))
    .filter((x): x is { v: VulnRecord; detected: number } => x.detected !== null)
    .filter((x) => now.getTime() - x.detected > cutoff)
    .sort((a, b) => a.detected - b.detected)
    .slice(0, AGED_CRITICALS_CAP)
    .map(({ v }) => {
      const svc = serviceOf(v.project_path);
      // The service chip takes a hash-stable hue; the installed version trails
      // as mono. Age lives in the section header, not per-row.
      return {
        glyph: "error" as Tone,
        chip: { label: svc || "—", tone: hashTone(svc) },
        text: `${v.cve_id} · ${artifactLabel(v.package_name)}`,
        ...(v.web_url ? { href: v.web_url } : {}),
        ...(v.current_version ? { trailing: v.current_version } : {}),
      };
    });
}

function agedSummary(
  vulns: VulnRecord[],
  now: Date,
  agedDays: number,
): { crit: number; high: number } {
  const cutoff = agedDays * DAY_MS;
  let crit = 0;
  let high = 0;
  for (const v of vulns) {
    if (v.state !== "DETECTED" && v.state !== "CONFIRMED") continue;
    const detected = parseMs(v.detected_at);
    if (detected === null || now.getTime() - detected <= cutoff) continue;
    if (v.severity === "critical") crit += 1;
    else if (v.severity === "high") high += 1;
  }
  return { crit, high };
}

// Compare two semver-ish versions; pre-release / build metadata is dropped, a
// non-numeric piece (git SHA) makes the version unparseable so it never ranks.
function semverParts(raw: string): [number, number, number] | null {
  let s = raw.trim();
  if (!s) return null;
  if (s[0] === "v" || s[0] === "V") s = s.slice(1);
  for (const sep of ["-", "+"]) {
    const i = s.indexOf(sep);
    if (i >= 0) s = s.slice(0, i);
  }
  const pieces = s.split(".");
  const major = toInt(pieces[0]);
  if (major === null) return null;
  return [major, toInt(pieces[1]) ?? 0, toInt(pieces[2]) ?? 0];
}
function toInt(piece: string | undefined): number | null {
  if (!piece || !/^\d+$/.test(piece)) return null;
  return Number.parseInt(piece, 10);
}
function compareSemver(a: string, b: string): number {
  const pa = semverParts(a);
  const pb = semverParts(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

// A major bump in a JVM/Python-style package is treated as high-risk and kept
// out of Quick Wins; the deeper read belongs in chat (mirrors cimpl-agent).
const FRAGILE_PREFIXES = ["com.", "org.", "io."];
function isHighRisk(from: string, to: string, pkg: string): boolean {
  const a = semverParts(from);
  const b = semverParts(to);
  if (!a || !b || a[0] === b[0]) return false;
  return FRAGILE_PREFIXES.some((p) => pkg.toLowerCase().startsWith(p));
}

// The worst tier a bump clears, in two registers: the terse annotation the row
// trails with (the crit/high/med vocabulary the offender bars and KPI tiles
// already use), and the sentence its disclosure opens with. The ids come back
// with them so the sentence and the list it introduces can't disagree.
function quickWinImpact(
  crit: ReadonlySet<string>,
  high: ReadonlySet<string>,
  med: ReadonlySet<string>,
): { terse: string; full: string; cves: string[] } {
  const [tier, abbr, word] =
    crit.size > 0
      ? ([crit, "crit", "critical"] as const)
      : high.size > 0
        ? ([high, "high", "high"] as const)
        : ([med, "med", "medium"] as const);
  const n = tier.size;
  return {
    terse: `${n} ${abbr}`,
    full: `fixes ${n} ${word} ${n === 1 ? "CVE" : "CVEs"}`,
    cves: [...tier].sort(),
  };
}

// Dependency bumps that clear crit/high CVEs: group vulns by package, take the
// highest published fix and highest current version, skip no-fix / already-fixed
// / high-risk groups, rank by criticals-then-highs cleared.
function buildQuickWins(vulns: VulnRecord[], fixes: Map<string, string>): RowItem[] {
  const groups = new Map<string, VulnRecord[]>();
  for (const v of vulns) {
    if (!v.package_name) continue;
    const arr = groups.get(v.package_name) ?? [];
    arr.push(v);
    groups.set(v.package_name, arr);
  }

  const rows: (RowItem & { crit: number; high: number })[] = [];
  for (const [pkg, members] of groups) {
    let to = "";
    for (const m of members) {
      const fix = fixes.get(osvFixKey(pkg, m.cve_id, m.current_version));
      if (fix && (!to || compareSemver(fix, to) > 0)) to = fix;
    }
    if (!to) continue;
    let from = "";
    for (const m of members) {
      if (m.current_version && (!from || compareSemver(m.current_version, from) > 0)) {
        from = m.current_version;
      }
    }
    if (!from || compareSemver(from, to) >= 0) continue;
    if (isHighRisk(from, to, pkg)) continue;

    const critCves = new Set<string>();
    const highCves = new Set<string>();
    const medCves = new Set<string>();
    for (const m of members) {
      if (!fixes.get(osvFixKey(pkg, m.cve_id, m.current_version))) continue;
      if (m.severity === "critical") critCves.add(m.cve_id);
      else if (m.severity === "high") highCves.add(m.cve_id);
      else if (m.severity === "medium") medCves.add(m.cve_id);
    }
    if (critCves.size + highCves.size + medCves.size === 0) continue;

    const scopeList = [
      ...new Set(members.map((m) => serviceOf(m.project_path)).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    const url = members.find(
      (m) => fixes.get(osvFixKey(pkg, m.cve_id, m.current_version)) && m.web_url,
    )?.web_url;

    const impact = quickWinImpact(critCves, highCves, medCves);
    const label = artifactLabel(pkg);
    const shown = impact.cves.slice(0, QUICK_WIN_CVES_CAP);
    const cveLine =
      impact.cves.length > shown.length
        ? `${shown.join(", ")} +${impact.cves.length - shown.length} more`
        : shown.join(", ");
    const lines = [`${impact.full}: ${cveLine}`];
    if (label !== pkg) lines.push(`Package: ${pkg}`);
    if (scopeList.length > 0) {
      lines.push(`Services (${scopeList.length}): ${scopeList.join(", ")}`);
    }

    rows.push({
      text: `${label} ${from} → ${to}`,
      trailing: impact.terse,
      // package_name is GitLab's string; nothing here bounds it, and `detail` is
      // the only field on this board with a schema max.
      detail: lines.join("\n").slice(0, 4000),
      ...(url ? { href: url } : {}),
      crit: critCves.size,
      high: highCves.size,
    });
  }
  rows.sort((a, b) => b.crit - a.crit || b.high - a.high || a.text.localeCompare(b.text));
  return rows.slice(0, QUICK_WINS_CAP).map(({ crit: _c, high: _h, ...row }) => row);
}

export interface SecurityInputs {
  report: ReleaseReport;
  vulns?: VulnRecord[];
  fixes?: Map<string, string>;
  mrs?: SecurityMr[];
  now?: Date;
  agedDays?: number;
}

/**
 * Shape an `osdu-quality release` report (counts + Sonar) plus per-CVE GitLab
 * detail and OSV fix versions into a Security board — a severity pulse, KPI
 * tiles, a SAST grade grid, inline top-offender bars, aged-critical CVE cards,
 * and quick-win dependency bumps. Counts-based sections render from the report
 * alone; the CVE sections need the GitLab/OSV inputs and stay empty without
 * them. Always returns a schema-valid board.
 */
export function buildSecurityBoard(inputs: SecurityInputs): CanvasBoardView {
  const { report } = inputs;
  const services = report.services ?? [];
  // The group GraphQL query returns CVEs across every osdu/platform project;
  // scope them to core so the CVE sections agree with the core-scoped KPI tiles
  // and offenders (both fed by the core-only release report). Scoping first is
  // the cheaper order: the filter keys on project_path, which is part of the
  // dedupe identity, so a key's records are all kept or all dropped together.
  const vulns = dedupeVulns(
    (inputs.vulns ?? []).filter((v) => VENUS_CORE.has(serviceOf(v.project_path))),
  );
  const fixes = inputs.fixes ?? new Map<string, string>();
  const mrs = inputs.mrs ?? [];
  const now = inputs.now ?? new Date();
  const agedDays = inputs.agedDays ?? DEFAULT_AGED_DAYS;

  const sast = buildSastGrid(services);
  const offenders = buildOffenders(services, vulns);
  const aged = buildAgedCriticals(vulns, now, agedDays);
  const agedTotals = agedSummary(vulns, now, agedDays);
  const quickWins = buildQuickWins(vulns, fixes);

  const sections: CanvasBoardView["sections"] = [
    { kind: "stats", items: buildKpis(services, mrs) },
  ];
  if (sast.length > 0) {
    sections.push({ kind: "grid", title: "Low security rating", cells: sast });
  }
  if (offenders.length > 0) {
    sections.push({
      kind: "bars",
      inline: true,
      title: "Top offenders · crit + high",
      items: offenders,
    });
  }
  if (aged.length > 0) {
    sections.push({
      kind: "rows",
      title: `Aged criticals · ${agedTotals.crit} crit · ${agedTotals.high} high · >${agedDays}d`,
      items: aged,
    });
  }
  if (quickWins.length > 0) {
    sections.push({ kind: "rows", title: "Quick wins", items: quickWins });
  }

  return {
    view: "board",
    title: `Security · ${report.release ?? "current"}`,
    header: {
      segments: buildPulse(services),
    },
    sections,
  };
}

// Envelope extraction for the GitLab `vulnerabilities` GraphQL connection. The
// collector hands the flattened `nodes` array; this normalizes each node to a
// VulnRecord, keeping only CVE-identified dependency/container findings.
export function extractVulns(nodes: unknown): VulnRecord[] {
  if (!Array.isArray(nodes)) return [];
  const out: VulnRecord[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as Record<string, unknown>;
    const cve = cveIdentifier(node.identifiers);
    if (!cve) continue;
    const dep = dependencyOf(node.location);
    out.push({
      project_path: String((node.project as { fullPath?: unknown })?.fullPath ?? ""),
      cve_id: cve,
      severity: String(node.severity ?? "").toLowerCase(),
      package_name: dep.name,
      current_version: dep.version,
      detected_at: String(node.detectedAt ?? ""),
      state: String(node.state ?? "").toUpperCase(),
      web_url: String(node.webUrl ?? ""),
    });
  }
  return out;
}

function cveIdentifier(identifiers: unknown): string {
  if (!Array.isArray(identifiers)) return "";
  for (const id of identifiers) {
    const o = id as { externalType?: unknown; externalId?: unknown };
    if (String(o?.externalType ?? "").toLowerCase() === "cve" && o?.externalId) {
      return String(o.externalId).trim().toUpperCase();
    }
  }
  return "";
}

function dependencyOf(location: unknown): { name: string; version: string } {
  const dep = (location as { dependency?: { package?: { name?: unknown }; version?: unknown } })
    ?.dependency;
  return {
    name: String(dep?.package?.name ?? ""),
    version: String(dep?.version ?? ""),
  };
}

// Composite key for the OSV fix map. The fix is specific to all three parts: a
// CVE's fix is package-specific (one OSV record lists fixes for several
// packages), and the recommended version depends on the line the package is
// installed on — 10.1.54 and 9.0.100 take different fixes for the same CVE, so
// keying without the version lets one overwrite the other. NUL separates because
// it cannot occur in any part. Spell it as an escape, never a literal byte: a raw
// NUL makes the whole file read as binary, which silently drops it from grep and
// other text tooling.
const OSV_KEY_SEP = "\0";

export function osvFixKey(packageName: string, cveId: string, installedVersion: string): string {
  return `${packageName}${OSV_KEY_SEP}${cveId}${OSV_KEY_SEP}${installedVersion}`;
}

// Split a fix-map key back into its parts so callers can present the map without
// reproducing the key format — or leaking the separator into output a model reads.
export function osvFixParts(key: string): {
  packageName: string;
  cveId: string;
  installedVersion: string;
} {
  const [packageName = "", cveId = "", installedVersion = ""] = key.split(OSV_KEY_SEP);
  return { packageName, cveId, installedVersion };
}

// GitLab dependency-scanning names a Maven coordinate `group/artifact` while OSV
// uses `group:artifact`; normalize the separator so the two match.
function normalizePackageName(name: string): string {
  return name.trim().toLowerCase().replaceAll(":", "/");
}

// --- fetch ---------------------------------------------------------------
// The Security board composes four one-shot sources; each degrades independently,
// pushing a note rather than throwing. Shared by the collector and the
// `osdu_security` chat tool.

const VULN_PAGE_SIZE = 100;
const MAX_VULN_PAGES = 20;
const OSV_BATCH = 8;
const OSV_TIMEOUT_MS = 4_000;
const MAX_OSV_LOOKUPS = 400;

const VULN_CONNECTION = (cursor: string | null): string => {
  const after = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
  return `vulnerabilities(state: [DETECTED, CONFIRMED], first: ${VULN_PAGE_SIZE}${after}) { pageInfo { hasNextPage endCursor } nodes { detectedAt severity state webUrl identifiers { externalType externalId } project { fullPath } location { ... on VulnerabilityLocationDependencyScanning { dependency { package { name } version } } ... on VulnerabilityLocationContainerScanning { dependency { package { name } version } } } } }`;
};

function vulnQuery(group: string, cursor: string | null): string {
  return `{ group(fullPath: ${JSON.stringify(group)}) { ${VULN_CONNECTION(cursor)} } }`;
}

function projectVulnQuery(fullPath: string, cursor: string | null): string {
  return `{ project(fullPath: ${JSON.stringify(fullPath)}) { ${VULN_CONNECTION(cursor)} } }`;
}

interface VulnConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: unknown[];
}

// Page one vulnerabilities connection to exhaustion (or the page cap), appending
// raw nodes. `label` names the scope in the degraded/cap notes.
async function pageVulns(
  query: (cursor: string | null) => string,
  read: (json: unknown) => VulnConnection | undefined,
  label: string,
  nodes: unknown[],
  errors: string[],
): Promise<void> {
  let cursor: string | null = null;
  for (let page = 0; page < MAX_VULN_PAGES; page++) {
    const res = await runGraphql(query(cursor));
    if (res.error || !res.json) {
      errors.push(`vulns degraded for ${label}: ${res.error ?? "no data"}`);
      return;
    }
    const conn = read(res.json);
    // A successful envelope carrying no connection (an inaccessible or renamed
    // project resolves to `data.project: null`) is missing data, not an absence
    // of findings — report it rather than let the scope read as clean.
    if (!conn) {
      errors.push(`vulns degraded for ${label}: response carried no vulnerability connection`);
      return;
    }
    nodes.push(...(conn.nodes ?? []));
    if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) return;
    cursor = conn.pageInfo.endCursor;
    if (page === MAX_VULN_PAGES - 1) {
      errors.push(
        `vulns: hit the ${MAX_VULN_PAGES}-page cap for ${label} — CVE detail may underreport`,
      );
    }
  }
}

// The whole group's CVE detail, for an unscoped report.
async function collectVulns(errors: string[]): Promise<VulnRecord[]> {
  const nodes: unknown[] = [];
  await pageVulns(
    (cursor) => vulnQuery(GITLAB_GROUP, cursor),
    (json) =>
      (json as { data?: { group?: { vulnerabilities?: VulnConnection } | null } })?.data?.group
        ?.vulnerabilities,
    GITLAB_GROUP,
    nodes,
    errors,
  );
  return extractVulns(nodes);
}

// CVE detail for named projects, for a scoped report. The group sweep pages every
// project in the group against one shared page cap, so a service ordered late in
// it loses most of its detail — querying each project directly is what makes a
// scoped report complete rather than merely smaller.
async function collectProjectVulns(
  paths: readonly string[],
  errors: string[],
): Promise<VulnRecord[]> {
  const nodes: unknown[] = [];
  for (const path of paths) {
    await pageVulns(
      (cursor) => projectVulnQuery(path, cursor),
      (json) =>
        (json as { data?: { project?: { vulnerabilities?: VulnConnection } | null } })?.data
          ?.project?.vulnerabilities,
      path,
      nodes,
      errors,
    );
  }
  return extractVulns(nodes);
}

// GitLab dependency-scanning writes a Maven coordinate as `group/artifact`; OSV
// keys the same package as `group:artifact`. Returns null for anything that
// isn't a single-slash coordinate, which is then simply left without a fix
// rather than queried under a guessed ecosystem.
function mavenCoordinate(packageName: string): string | null {
  const parts = packageName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${parts[0]}:${parts[1]}`;
}

// Every CVE id a record answers to: OSV returns the ecosystem advisory (GHSA-…)
// and carries the CVE it fixes in `aliases`.
function osvRecordCves(record: unknown): string[] {
  const r = record as { id?: unknown; aliases?: unknown };
  const ids = [r?.id, ...(Array.isArray(r?.aliases) ? r.aliases : [])];
  return ids.filter((i): i is string => typeof i === "string" && i.startsWith("CVE-"));
}

// Ask OSV which advisories affect one installed package version. A failure is
// recorded rather than swallowed: an unreachable or rate-limited OSV drops every
// fix recommendation, and an empty fix list is otherwise indistinguishable from
// "this package has no published fix".
async function osvQueryPackage(
  coordinate: string,
  version: string,
  errors: string[],
): Promise<unknown[]> {
  try {
    const r = await fetch("https://api.osv.dev/v1/query", {
      method: "POST",
      body: JSON.stringify({
        package: { name: coordinate, ecosystem: "Maven" },
        version,
      }),
      signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
    });
    if (!r.ok) {
      errors.push(`osv degraded for ${coordinate}@${version}: HTTP ${r.status}`);
      return [];
    }
    const body = (await r.json()) as { vulns?: unknown };
    return Array.isArray(body?.vulns) ? body.vulns : [];
  } catch (e) {
    errors.push(`osv degraded for ${coordinate}@${version}: ${errText(e)}`);
    return [];
  }
}

// Fix versions for the CVEs we found, keyed by (package, CVE).
//
// Queried by installed package+version, NOT by CVE id: OSV's CVE-keyed record is
// the upstream advisory, which carries no package coordinates and expresses its
// fixes as git SHAs, so matching it against a package never resolves and every
// lookup came back empty. The ecosystem advisory (GHSA-…) is the one holding
// `{package, ranges.events.fixed}`, and it is only reachable by querying the
// package. Querying per package also collapses the request count: many CVEs
// share one vulnerable dependency.
async function collectFixes(vulns: VulnRecord[], errors: string[]): Promise<Map<string, string>> {
  const fixes = new Map<string, string>();
  // The CVEs we hold per package — a fix is only recorded for a CVE actually
  // reported against that package, never for everything OSV knows about it.
  const wanted = new Map<string, Set<string>>();
  const targets = new Map<string, { packageName: string; version: string }>();
  for (const v of vulns) {
    if (!v.cve_id || !v.package_name || !v.current_version) continue;
    const key = `${v.package_name}@${v.current_version}`;
    if (!wanted.has(key)) wanted.set(key, new Set());
    wanted.get(key)?.add(v.cve_id);
    targets.set(key, { packageName: v.package_name, version: v.current_version });
  }

  let keys = [...targets.keys()];
  if (keys.length > MAX_OSV_LOOKUPS) {
    errors.push(
      `osv: ${keys.length} packages exceeds the ${MAX_OSV_LOOKUPS} lookup cap — quick wins may underreport`,
    );
    keys = keys.slice(0, MAX_OSV_LOOKUPS);
  }

  for (let i = 0; i < keys.length; i += OSV_BATCH) {
    const batch = keys.slice(i, i + OSV_BATCH);
    await Promise.all(
      batch.map(async (key) => {
        const target = targets.get(key);
        if (!target) return;
        const coordinate = mavenCoordinate(target.packageName);
        if (!coordinate) return;
        const records = await osvQueryPackage(coordinate, target.version, errors);
        const cves = wanted.get(key) ?? new Set<string>();
        for (const record of records) {
          const fix = parseOsvFixed(record, target.packageName, target.version);
          if (!fix) continue;
          for (const cve of osvRecordCves(record)) {
            if (cves.has(cve)) fixes.set(osvFixKey(target.packageName, cve, target.version), fix);
          }
        }
      }),
    );
  }
  return fixes;
}

export interface SecurityFetchResult {
  inputs: SecurityInputs;
  errors: string[];
}

// Compose the four Security sources into the board inputs: the osdu-quality
// report (counts + Sonar), per-CVE GitLab detail, OSV fix versions, and the
// core-scoped vuln MRs from the shared Venus bundle. The three independent
// sources fetch concurrently; only the OSV fix lookup depends on the vulns.
//
// `services` narrows every source to the named core services; empty means all of
// them (the collectors' shape, so the published boards stay platform-wide).
// Narrowing before `collectFixes` is what makes a scoped call cheap: OSV is
// queried once per distinct vulnerable (package, installed version), which is
// both the slow leg and the one under a truncating cap.
export async function fetchSecurityInputs(
  exec: RibExec = localExec(),
  services: readonly string[] = [],
): Promise<SecurityFetchResult> {
  const errors: string[] = [];
  const scope = new Set(services);
  const [bundle, quality, sweptVulns] = await Promise.all([
    loadVenusBundle(),
    fetchReleaseReport(exec, services),
    // Only the unscoped sweep can run concurrently with the report; a scoped run
    // queries each project by the gitlab_path the report carries, so it has to
    // wait for it.
    scope.size === 0 ? collectVulns(errors) : Promise.resolve(null),
  ]);
  errors.push(...bundle.errors);
  if (quality.error) errors.push(`quality degraded: ${quality.error}`);
  const vulnsAll =
    sweptVulns ??
    (await collectProjectVulns(
      (quality.report.services ?? [])
        .map((s) => s.gitlab_path)
        .filter((p): p is string => Boolean(p)),
      errors,
    ));
  // Scope CVEs to the core services so the tool result agrees with the board
  // (buildSecurityBoard applies the same VENUS_CORE filter) and OSV lookups skip
  // off-core packages.
  const inScope = (path: string | null | undefined): boolean => {
    const svc = serviceOf(path);
    return VENUS_CORE.has(svc) && (scope.size === 0 || scope.has(svc));
  };
  const vulns = vulnsAll.filter((v) => inScope(v.project_path));
  const mrs = extractSecurityMrs(bundle.mrsRaw).filter((mr) => inScope(mr.project_path));
  const fixes = await collectFixes(vulns, errors);
  return { inputs: { report: quality.report, vulns, fixes, mrs, now: new Date() }, errors };
}

// An OSV record → the fixed version to recommend for `packageName`, or "" when
// none applies. Only `affected` entries whose package matches are considered — a
// record can carry fixes for unrelated packages, and applying the wrong one
// would recommend a bogus bump. Git-SHA "fixed" events are rejected (not
// installable).
//
// With `currentVersion`, this is the LOWEST fix above it — the minimal upgrade
// that clears the CVE. One advisory usually patches every supported line at
// once (Tomcat 9.0.118 / 10.1.55 / 11.0.22), so taking the highest would tell a
// service on 10.1.54 to jump a major version when the patch beside it does the
// job. Without a version to compare against, the newest fix is the only honest
// answer.
const VERSION_RE = /^v?\d+(?:\.\w+)*(?:[-+][\w.\-+]+)?$/;
export function parseOsvFixed(body: unknown, packageName: string, currentVersion?: string): string {
  const affected = (body as { affected?: unknown })?.affected;
  if (!Array.isArray(affected)) return "";
  const target = normalizePackageName(packageName);
  const candidates: string[] = [];
  for (const entry of affected) {
    const name = (entry as { package?: { name?: unknown } })?.package?.name;
    if (typeof name !== "string" || normalizePackageName(name) !== target) continue;
    const ranges = (entry as { ranges?: unknown })?.ranges;
    if (!Array.isArray(ranges)) continue;
    for (const range of ranges) {
      const events = (range as { events?: unknown })?.events;
      if (!Array.isArray(events)) continue;
      for (const event of events) {
        const fixed = (event as { fixed?: unknown })?.fixed;
        if (typeof fixed !== "string" || !VERSION_RE.test(fixed)) continue;
        candidates.push(fixed);
      }
    }
  }
  if (candidates.length === 0) return "";
  const upgrades =
    currentVersion && semverParts(currentVersion)
      ? candidates.filter((c) => compareSemver(c, currentVersion) > 0)
      : [];
  if (upgrades.length > 0) {
    return upgrades.reduce((lowest, c) => (compareSemver(c, lowest) < 0 ? c : lowest));
  }
  // No comparable current version: fall back to the newest known fix.
  if (currentVersion && semverParts(currentVersion)) return "";
  return candidates.reduce((highest, c) => (compareSemver(c, highest) > 0 ? c : highest));
}
