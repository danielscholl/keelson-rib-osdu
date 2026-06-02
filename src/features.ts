import type { CanvasBoardView } from "@keelson/shared";

// Shape of `osdu-activity epic list --output json` and `osdu-activity mr
// --output json`. Only the fields the board reads are modeled; both CLIs emit
// much more (pipelines, issues, reviewers, …).
export type Liveness = "active" | "quiet" | "stale" | "dead";

export interface RelatedMr {
  state?: string | null;
  merged_at?: string | null;
}
export interface EpicRow {
  title?: string | null;
  web_url?: string | null;
  liveness?: Liveness | string | null;
  last_motion?: string | null;
  total_issue_count?: number | null;
  open_issue_count?: number | null;
  assignees?: string[];
  related_mrs?: RelatedMr[];
}
export interface MrRow {
  state?: string | null;
  draft?: boolean;
  created_at?: string | null;
  latest_pipeline_status?: string | null;
  detailed_merge_status?: string | null;
}

export type Tone = "ok" | "warn" | "error" | "neutral";

// Thresholds mirror cimpl-agent's Features composer: a merge request is stale
// after 7 days, the velocity window is the trailing 7 days, and the lane shows
// at most 7 movers / 3 stalled epics.
const STALE_MR_DAYS = 7;
const MOVERS_CAP = 7;
const STALLED_CAP = 3;
const DAY_MS = 86_400_000;
const SEVEN_DAYS_MS = 7 * DAY_MS;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function ageDays(iso: string | null | undefined, now: Date): number | null {
  const t = parseMs(iso);
  return t === null ? null : Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

function ownerOf(epic: EpicRow): string {
  const first = (epic.assignees ?? []).find((a) => typeof a === "string" && a.trim() !== "");
  return first ? first.trim() : "unowned";
}

// Completion reads tasks first (closed/total issues), falls back to merged/total
// related MRs, and is "no scope yet" when an epic carries neither signal.
function scopeOf(epic: EpicRow): { pct: number | null; label: string } {
  const total = num(epic.total_issue_count) ?? 0;
  if (total > 0) {
    const closed = Math.max(0, total - (num(epic.open_issue_count) ?? 0));
    return {
      pct: Math.round((closed / total) * 100),
      label: `${closed} of ${total} ${total === 1 ? "task" : "tasks"}`,
    };
  }
  const related = epic.related_mrs ?? [];
  if (related.length > 0) {
    const merged = related.filter((m) => m.state === "merged").length;
    return {
      pct: Math.round((merged / related.length) * 100),
      label: `${merged} of ${related.length} ${related.length === 1 ? "MR" : "MRs"}`,
    };
  }
  return { pct: null, label: "no scope yet" };
}

function velocityLabel(epic: EpicRow, now: Date): string {
  const cutoff = now.getTime() - SEVEN_DAYS_MS;
  let n = 0;
  for (const m of epic.related_mrs ?? []) {
    if (m.state !== "merged") continue;
    const at = parseMs(m.merged_at);
    if (at !== null && at >= cutoff) n += 1;
  }
  return `${n} ${n === 1 ? "MR" : "MRs"}/7d`;
}

function pulse(epics: EpicRow[]): { label: string; n: number; tone: Tone }[] {
  let active = 0;
  let quiet = 0;
  let stalled = 0;
  for (const e of epics) {
    if (e.liveness === "active") active += 1;
    else if (e.liveness === "quiet") quiet += 1;
    else stalled += 1; // stale + dead
  }
  return [
    { label: "active", n: active, tone: "ok" },
    { label: "quiet", n: quiet, tone: "neutral" },
    { label: "stalled", n: stalled, tone: "warn" },
  ];
}

function staleTone(n: number): Tone {
  if (n >= 10) return "error";
  if (n >= 3) return "warn";
  return "ok";
}

type StatItem = { label: string; value: string | number; sub?: string; tone?: Tone };
function buildKpis(mrs: MrRow[], now: Date): StatItem[] {
  const open = mrs.filter((m) => (m.state ?? "opened") === "opened" && !m.draft);
  const drafts = mrs.filter((m) => m.draft);
  const stale = open.filter((m) => (ageDays(m.created_at, now) ?? 0) > STALE_MR_DAYS);
  const blocked = open.filter((m) => (m.latest_pipeline_status ?? "").toLowerCase() === "failed");
  const ready = open.filter(
    (m) =>
      m.detailed_merge_status === "mergeable" &&
      (m.latest_pipeline_status ?? "").toLowerCase() !== "failed",
  );
  return [
    {
      label: "Open MR",
      value: open.length,
      sub: `${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}`,
    },
    { label: "Stale MR", value: stale.length, sub: "> 7 days", tone: staleTone(stale.length) },
    {
      label: "Blocked MR",
      value: blocked.length,
      sub: "CI failed",
      tone: blocked.length > 0 ? "error" : "ok",
    },
    {
      label: "Ready MR",
      value: ready.length,
      sub: "waiting",
      tone: ready.length > 0 ? "ok" : "neutral",
    },
  ];
}

type CardItem = {
  title: string;
  pill: { label: string; tone: Tone };
  href?: string;
  bar?: { value: number; total: number };
  fields: { value: string }[];
};
function buildMovers(epics: EpicRow[], now: Date): CardItem[] {
  return epics
    .filter((e) => e.liveness === "active")
    .map((e) => ({ epic: e, scope: scopeOf(e), motion: parseMs(e.last_motion) ?? 0 }))
    .sort((a, b) => (b.scope.pct ?? -1) - (a.scope.pct ?? -1) || b.motion - a.motion)
    .slice(0, MOVERS_CAP)
    .map(({ epic, scope }) => {
      const total = num(epic.total_issue_count) ?? 0;
      const closed = Math.max(0, total - (num(epic.open_issue_count) ?? 0));
      return {
        title: epic.title || "—",
        pill: { label: "ACTIVE", tone: "ok" as Tone },
        ...(epic.web_url ? { href: epic.web_url } : {}),
        ...(total > 0 ? { bar: { value: closed, total } } : {}),
        fields: [
          { value: scope.pct === null ? "—" : `${scope.pct}%` },
          { value: scope.label },
          { value: velocityLabel(epic, now) },
          { value: ownerOf(epic) },
        ],
      };
    });
}

type RowItem = {
  glyph: Tone;
  chip: { label: string };
  text: string;
  href?: string;
  trailing: string;
};
function buildStalled(epics: EpicRow[], now: Date): RowItem[] {
  return (
    epics
      // Anything not "active" (including a missing liveness) is non-active, so the
      // rows stay consistent with the pulse, which counts the same set as stalled.
      .filter((e) => e.liveness !== "active")
      .map((e) => ({ epic: e, age: ageDays(e.last_motion, now) }))
      // Unknown age (no motion ever) sorts oldest-first.
      .sort((a, b) => (b.age ?? Number.POSITIVE_INFINITY) - (a.age ?? Number.POSITIVE_INFINITY))
      .slice(0, STALLED_CAP)
      .map(({ epic, age }) => {
        const tags = [age === null ? "no motion" : `stale-${age}d`];
        if (ownerOf(epic) === "unowned") tags.push("unowned");
        const liveness = (typeof epic.liveness === "string" && epic.liveness) || "quiet";
        return {
          glyph: (liveness === "quiet" ? "neutral" : "warn") as Tone,
          chip: { label: liveness.toUpperCase() },
          text: epic.title || "—",
          ...(epic.web_url ? { href: epic.web_url } : {}),
          trailing: tags.join(", "),
        };
      })
  );
}

/**
 * Shape `osdu-activity` epic + merge-request JSON into a Features board — a
 * VENUS active/quiet pulse, four MR KPI tiles, "Movers" cards (active epics
 * with a progress bar), and "Stalled" rows (quiet/stale epics with a why-flagged
 * footnote). `now` is injected so age math is deterministic in tests.
 */
export function buildFeaturesBoard(epics: EpicRow[], mrs: MrRow[], now: Date): CanvasBoardView {
  const movers = buildMovers(epics, now);
  const stalled = buildStalled(epics, now);
  const sections: CanvasBoardView["sections"] = [{ kind: "stats", items: buildKpis(mrs, now) }];
  if (movers.length > 0) sections.push({ kind: "cards", title: "Movers · active", items: movers });
  if (stalled.length > 0) sections.push({ kind: "rows", title: "Stalled · quiet", items: stalled });
  return {
    view: "board",
    title: "Features · Venus",
    header: { chip: "VENUS", segments: pulse(epics) },
    sections,
  };
}

// Envelope extraction — the epic CLI nests rows under `data.epics`; the mr CLI
// nests them under `data.projects[].merge_requests`. Tolerant of any missing
// level so a degraded/partial payload yields an empty list, never a throw.
export function extractEpics(raw: unknown): EpicRow[] {
  const epics = (raw as { data?: { epics?: unknown } } | null)?.data?.epics;
  return Array.isArray(epics) ? (epics as EpicRow[]) : [];
}
export function extractMrs(raw: unknown): MrRow[] {
  const projects = (raw as { data?: { projects?: unknown } } | null)?.data?.projects;
  if (!Array.isArray(projects)) return [];
  return projects.flatMap((p) =>
    Array.isArray((p as { merge_requests?: unknown })?.merge_requests)
      ? (p as { merge_requests: MrRow[] }).merge_requests
      : [],
  );
}
