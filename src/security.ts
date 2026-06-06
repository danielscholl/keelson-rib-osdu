import type { CanvasBoardView } from "@keelson/shared";
import type { ReleaseReport, ServiceReport, Tone, VulnCounts } from "./quality.ts";

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

// The 17 Venus core services — mirrors cimpl-agent's bridge scope so the lane's
// "in core" counts match the upstream dashboard. Off-core projects (DDMS, etc.)
// stay out of the KPI/Vuln-MR totals.
const VENUS_CORE: ReadonlySet<string> = new Set([
  "partition",
  "entitlements",
  "legal",
  "storage",
  "indexer-service",
  "search-service",
  "file",
  "schema-service",
  "notification",
  "register",
  "dataset",
  "secret",
  "policy",
  "crs-catalog-service",
  "crs-conversion-service",
  "unit-service",
  "ingestion-workflow",
]);

const OFFENDERS_CAP = 8;
const AGED_CRITICALS_CAP = 8;
const QUICK_WINS_CAP = 10;
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

function serviceFromPath(projectPath: string | null | undefined): string {
  if (!projectPath) return "";
  return projectPath.split("/").pop() ?? "";
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
    if (!VENUS_CORE.has(serviceFromPath(mr.project_path))) continue;
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

type CardItem = {
  title: string;
  titleTone?: Tone;
  mono?: boolean;
  pill?: { label: string; tone: Tone };
  href?: string;
  fields?: { label?: string; value: string; tone?: Tone; href?: string }[];
  footnote?: string;
};

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
    .map((svc) => ({ svc, rating: (svc.sonar?.security_rating ?? "").toUpperCase() }))
    .filter(({ rating }) => rating !== "A")
    .sort((a, b) => rank(a.rating) - rank(b.rating) || name(a.svc).localeCompare(name(b.svc)))
    .map(({ svc, rating }) => ({
      label: name(svc),
      badge: { text: rating || "—", tone: gradeTone(rating) },
    }));
}

type BarItem = { label: string; value: number; total: number; tone?: Tone; trailing?: string };
// Top services by critical+high count, with a severity bar and crit/high tail.
function buildOffenders(services: ServiceReport[]): BarItem[] {
  const rows = services
    .filter((svc) => svc.vulnerabilities != null)
    .map((svc) => {
      const t = totals(svc.vulnerabilities);
      return { name: svc.display_name || svc.name || "—", crit: t.crit, high: t.high };
    })
    .filter((r) => r.crit + r.high > 0)
    .sort((a, b) => b.crit - a.crit || b.high - a.high || a.name.localeCompare(b.name))
    .slice(0, OFFENDERS_CAP);
  const max = rows.reduce((acc, r) => Math.max(acc, r.crit + r.high), 0);
  return rows.map((r) => ({
    label: r.name,
    value: r.crit + r.high,
    total: max,
    tone: r.crit > 0 ? "error" : "warn",
    trailing: `${r.crit} crit · ${r.high} high`,
  }));
}

// Critical CVEs in DETECTED/CONFIRMED state older than the aged threshold,
// oldest first. `now` is injected so age math is deterministic in tests.
function buildAgedCriticals(vulns: VulnRecord[], now: Date, agedDays: number): CardItem[] {
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
      const pkg = v.current_version ? `${v.package_name} ${v.current_version}` : v.package_name;
      const svc = serviceFromPath(v.project_path);
      // The CVE id reads as a red mono identifier; the service chip takes a
      // hash-stable hue. Age lives in the section header, not per-row.
      return {
        title: v.cve_id,
        titleTone: "error" as Tone,
        mono: true,
        pill: { label: svc || "—", tone: hashTone(svc) },
        ...(v.web_url ? { href: v.web_url } : {}),
        fields: [{ value: pkg || "—" }],
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

function quickWinImpact(crit: number, high: number, med: number): string {
  if (crit > 0) return `fixes ${crit} critical ${crit === 1 ? "CVE" : "CVEs"}`;
  if (high > 0) return `fixes ${high} high ${high === 1 ? "CVE" : "CVEs"}`;
  return `fixes ${med} medium ${med === 1 ? "CVE" : "CVEs"}`;
}

// Dependency bumps that clear crit/high CVEs: group vulns by package, take the
// highest published fix and highest current version, skip no-fix / already-fixed
// / high-risk groups, rank by criticals-then-highs cleared.
function buildQuickWins(vulns: VulnRecord[], fixes: Map<string, string>): CardItem[] {
  const groups = new Map<string, VulnRecord[]>();
  for (const v of vulns) {
    if (!v.package_name) continue;
    const arr = groups.get(v.package_name) ?? [];
    arr.push(v);
    groups.set(v.package_name, arr);
  }

  const rows: (CardItem & { crit: number; high: number })[] = [];
  for (const [pkg, members] of groups) {
    let to = "";
    for (const m of members) {
      const fix = fixes.get(osvFixKey(pkg, m.cve_id));
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
      if (!fixes.get(osvFixKey(pkg, m.cve_id))) continue;
      if (m.severity === "critical") critCves.add(m.cve_id);
      else if (m.severity === "high") highCves.add(m.cve_id);
      else if (m.severity === "medium") medCves.add(m.cve_id);
    }
    if (critCves.size + highCves.size + medCves.size === 0) continue;

    const scope = [...new Set(members.map((m) => serviceFromPath(m.project_path)).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
    const url = members.find((m) => fixes.get(osvFixKey(pkg, m.cve_id)) && m.web_url)?.web_url;
    rows.push({
      title: pkg,
      pill: { label: "QUICK WIN", tone: "ok" },
      ...(url ? { href: url } : {}),
      fields: [
        { value: `${from} → ${to}` },
        { value: quickWinImpact(critCves.size, highCves.size, medCves.size) },
        ...(scope ? [{ value: scope }] : []),
      ],
      crit: critCves.size,
      high: highCves.size,
    });
  }
  rows.sort((a, b) => b.crit - a.crit || b.high - a.high || a.title.localeCompare(b.title));
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
  // and offenders (both fed by the core-only release report).
  const vulns = (inputs.vulns ?? []).filter((v) => VENUS_CORE.has(serviceFromPath(v.project_path)));
  const fixes = inputs.fixes ?? new Map<string, string>();
  const mrs = inputs.mrs ?? [];
  const now = inputs.now ?? new Date();
  const agedDays = inputs.agedDays ?? DEFAULT_AGED_DAYS;

  const sast = buildSastGrid(services);
  const offenders = buildOffenders(services);
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
      kind: "cards",
      title: `Aged criticals · ${agedTotals.crit} crit · ${agedTotals.high} high · >${agedDays}d`,
      items: aged,
    });
  }
  if (quickWins.length > 0) {
    sections.push({ kind: "cards", title: "Quick wins", items: quickWins });
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

// Composite key for the OSV fix map: a CVE's fixed version is package-specific
// (one OSV record can list fixes for several packages/ecosystems), so quick-win
// lookups must be keyed by package, not CVE alone.
export function osvFixKey(packageName: string, cveId: string): string {
  return `${packageName} ${cveId}`;
}

// GitLab dependency-scanning names a Maven coordinate `group/artifact` while OSV
// uses `group:artifact`; normalize the separator so the two match.
function normalizePackageName(name: string): string {
  return name.trim().toLowerCase().replaceAll(":", "/");
}

// OSV.dev `/v1/vulns/{id}` body → highest published fixed version for the given
// package, or "" when no usable fix exists. Only `affected` entries whose
// package matches `packageName` are considered — a CVE can carry fixes for
// unrelated packages, and applying the wrong one would recommend a bogus bump.
// Git-SHA "fixed" events are rejected (not installable).
const VERSION_RE = /^v?\d+(?:\.\w+)*(?:[-+][\w.\-+]+)?$/;
export function parseOsvFixed(body: unknown, packageName: string): string {
  const affected = (body as { affected?: unknown })?.affected;
  if (!Array.isArray(affected)) return "";
  const target = normalizePackageName(packageName);
  let best = "";
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
        if (!best || compareSemver(fixed, best) > 0) best = fixed;
      }
    }
  }
  return best;
}
