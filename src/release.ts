import type { CanvasBoardView } from "@keelson/shared";
import { VENUS_CORE } from "./activity.ts";
import type { FeedRelatedMr } from "./events.ts";

export type Tone = "ok" | "warn" | "error" | "neutral" | "info" | "caution" | "brand" | "accent";

// An open merge request from `osdu-activity mr` (data.projects[].merge_requests[]).
// `milestone` is the resolved token the Release Train identity is derived from.
export interface ReleaseMr {
  iid?: number | null;
  title?: string | null;
  web_url?: string | null;
  created_at?: string | null;
  state?: string | null;
  draft?: boolean;
  milestone?: string | null;
}

export interface ReleaseInput {
  openMrs?: ReleaseMr[];
  mergedMrs?: FeedRelatedMr[];
  // The CLI's resolved release identity; preferred over the MR mode and present
  // even when the open-MR queue is empty.
  release?: string | null;
  now: Date;
}

const NEW_MR_CAP = 6;
const WIN_MR_CAP = 6;
const WIN_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

// New MRs ride the branch glyph (matching the feed's PLATFORM rows); a merged
// win reads as a check.
const ICON_BRANCH = "⎇";
const ICON_CHECK = "✓";

type RowItem = {
  icon?: string;
  chip?: { label: string; tone?: Tone };
  text: string;
  href?: string;
  trailing?: string;
};

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// Floor of (now - iso) in whole days, clamped to >= 0; null when unparseable.
function dayAge(iso: string | null | undefined, now: Date): number | null {
  const ms = parseMs(iso);
  if (ms === null) return null;
  return Math.max(0, Math.floor((now.getTime() - ms) / DAY_MS));
}

// The project segment of a GitLab MR web_url (`/<service>/-/merge_requests/`),
// or null when the URL is missing or doesn't match.
function serviceFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.match(/\/([^/]+)\/-\/merge_requests\//)?.[1] ?? null;
}

// Stable decorative pill color per service — the same repo always renders the
// same hue (djb2 hash → palette slot), mirroring cimpl-agent's New-MRs chips so
// color disambiguates repos at a glance. A curated subset of the canvas tones:
// distinct hues with no status-loaded red/yellow, so a repo name never reads as a
// failure.
const PROJECT_TONES: Tone[] = ["info", "brand", "accent", "caution", "ok"];

export function projectTone(name: string): Tone {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h) ^ name.charCodeAt(i);
  return PROJECT_TONES[Math.abs(h) % PROJECT_TONES.length] as Tone;
}

// Resolve a milestone field (a string, or GitLab's {title|name} object) to a
// token; null when absent. Exported for the extractor.
export function milestoneToken(m: unknown): string | null {
  if (typeof m === "string") return m.trim() || null;
  if (m && typeof m === "object") {
    const o = m as { title?: unknown; name?: unknown };
    if (typeof o.title === "string" && o.title.trim()) return o.title;
    if (typeof o.name === "string" && o.name.trim()) return o.name;
  }
  return null;
}

// The active release: the most-common milestone token across open non-draft MRs,
// with the first-seen token winning ties. null when no MR carries a milestone.
// Drafts are excluded so a batch of draft work on a future/prior milestone can't
// swing the banner away from the real queue (the shared bundle includes drafts).
export function releaseTrain(mrs: ReleaseMr[]): string | null {
  const counts = new Map<string, number>();
  for (const mr of mrs) {
    if (mr.draft) continue;
    if (mr.milestone) counts.set(mr.milestone, (counts.get(mr.milestone) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [token, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = token;
    }
  }
  return best;
}

// Most-recent open non-draft MRs (created_at desc, iid desc tiebreak), capped.
function newMrRows(mrs: ReleaseMr[], now: Date): RowItem[] {
  const ranked = mrs
    .filter((mr) => !mr.draft && (mr.state ?? "opened") === "opened" && mr.iid != null)
    .map((mr) => ({ mr, ts: parseMs(mr.created_at) ?? 0 }));
  ranked.sort((a, b) => b.ts - a.ts || (b.mr.iid as number) - (a.mr.iid as number));
  const rows: RowItem[] = [];
  for (const { mr } of ranked.slice(0, NEW_MR_CAP)) {
    const service = serviceFromUrl(mr.web_url);
    const age = dayAge(mr.created_at, now);
    const row: RowItem = { icon: ICON_BRANCH, text: `!${mr.iid} — ${mr.title || "untitled MR"}` };
    if (service) row.chip = { label: service, tone: projectTone(service) };
    if (mr.web_url) row.href = mr.web_url;
    if (age != null) row.trailing = `${age}d`;
    rows.push(row);
  }
  return rows.length > 0 ? rows : [{ text: "No open merge requests." }];
}

// Core merges in the 7d window (dedup web_url): a lead count line, then the
// individual MRs as check rows.
function winRows(mergedMrs: FeedRelatedMr[], now: Date): RowItem[] {
  const cutoff = now.getTime() - WIN_WINDOW_DAYS * DAY_MS;
  const seen = new Set<string>();
  const core: { mr: FeedRelatedMr; ts: number }[] = [];
  for (const mr of mergedMrs) {
    if (mr.state !== "merged") continue;
    const ts = parseMs(mr.merged_at);
    if (ts === null || ts < cutoff) continue;
    const service = serviceFromUrl(mr.web_url);
    if (!service || !VENUS_CORE.has(service)) continue;
    const key = mr.web_url ?? "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    core.push({ mr, ts });
  }
  if (core.length === 0) return [{ text: "No wins this week." }];
  core.sort((a, b) => b.ts - a.ts);
  const n = core.length;
  const rows: RowItem[] = [
    { icon: ICON_CHECK, text: `${n} MR${n === 1 ? "" : "s"} merged to main this week` },
  ];
  for (const { mr } of core.slice(0, WIN_MR_CAP)) {
    const age = dayAge(mr.merged_at, now);
    const row: RowItem = { icon: ICON_CHECK, text: `!${mr.iid} — ${mr.title || "untitled MR"}` };
    if (mr.web_url) row.href = mr.web_url;
    if (age != null) row.trailing = `${age}d`;
    rows.push(row);
  }
  return rows;
}

/**
 * Shape the Release Train banner: the active milestone as the board's header
 * chip, beside a two-column body — recent open MRs (New Merge Requests) and the
 * week's core merges (Platform Wins). `now` is injected so age math is
 * deterministic in tests. Always returns a valid board.
 */
export function buildReleaseBoard(input: ReleaseInput): CanvasBoardView {
  const { now } = input;
  const openMrs = input.openMrs ?? [];
  const resolved = input.release?.trim();
  const train = resolved && resolved.length > 0 ? resolved : releaseTrain(openMrs);
  const sections: CanvasBoardView["sections"] = [
    {
      kind: "columns",
      columns: [
        {
          sections: [{ kind: "rows", title: "New Merge Requests", items: newMrRows(openMrs, now) }],
        },
        {
          sections: [
            { kind: "rows", title: "Platform Wins", items: winRows(input.mergedMrs ?? [], now) },
          ],
        },
      ],
    },
  ];
  return {
    view: "board",
    title: "Release Train",
    ...(train ? { header: { chip: train } } : {}),
    sections,
  };
}

// The CLI's resolved release (`parameters.milestone_filter`) — the `--milestone
// Venus` family filter comes back resolved to the active release title, which is
// a more authoritative banner label than the MR mode and survives an empty queue.
export function extractMilestoneFilter(raw: unknown): string | null {
  const filter = (raw as { parameters?: { milestone_filter?: unknown } } | null)?.parameters
    ?.milestone_filter;
  return typeof filter === "string" && filter.trim().length > 0 ? filter : null;
}

// Envelope extraction — the mr CLI nests rows under data.projects[].merge_requests.
// Captures the milestone token (the events extractor omits it). Tolerant of any
// missing level so a degraded payload yields an empty list.
export function extractReleaseMrs(raw: unknown): ReleaseMr[] {
  const projects = (raw as { data?: { projects?: unknown } } | null)?.data?.projects;
  if (!Array.isArray(projects)) return [];
  const out: ReleaseMr[] = [];
  for (const p of projects) {
    const mrs = (p as { merge_requests?: unknown })?.merge_requests;
    if (!Array.isArray(mrs)) continue;
    for (const mr of mrs) {
      if (!mr || typeof mr !== "object") continue;
      const m = mr as Record<string, unknown>;
      out.push({
        iid: typeof m.iid === "number" ? m.iid : null,
        title: typeof m.title === "string" ? m.title : null,
        web_url: typeof m.web_url === "string" ? m.web_url : null,
        created_at: typeof m.created_at === "string" ? m.created_at : null,
        state: typeof m.state === "string" ? m.state : null,
        draft: m.draft === true,
        milestone: milestoneToken(m.milestone) ?? milestoneToken(m.milestone_title),
      });
    }
  }
  return out;
}
