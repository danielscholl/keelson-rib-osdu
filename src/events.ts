import type { CanvasBoardView } from "@keelson/shared";

export type Tone = "ok" | "warn" | "error" | "neutral" | "info" | "caution" | "brand" | "accent";

// An open merge request from `osdu-activity mr` (data.projects[].merge_requests[]).
// Only the fields the feed reads are modeled.
export interface FeedMr {
  iid?: number | null;
  title?: string | null;
  author?: string | null;
  web_url?: string | null;
  created_at?: string | null;
  state?: string | null;
  draft?: boolean;
}

// A merged MR carried on an epic's `related_mrs` (`osdu-activity epic list`) —
// the only source that dates the merge (the `mr` report omits merged_at).
export interface FeedRelatedMr {
  iid?: number | null;
  title?: string | null;
  web_url?: string | null;
  state?: string | null;
  merged_at?: string | null;
}

// A Kubernetes Job, flattened from `kubectl get jobs -A -o json`.
export interface JobRow {
  name?: string | null;
  namespace?: string | null;
  created_at?: string | null;
}

export interface EventsInput {
  openMrs?: FeedMr[];
  mergedMrs?: FeedRelatedMr[];
  jobs?: JobRow[];
  now: Date;
}

const EVENT_WINDOW_HOURS = 24;
// Cluster jobs fan out (CronJobs spawn many per hour); a shorter window keeps the
// feed from drowning in bootstrap noise, mirroring the cimpl-agent feed.
const JOB_WINDOW_HOURS = 6;
const FEED_CAP = 12;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

// Thematic leading icons: kube/cluster motion reads as the helm wheel, MR motion
// as the branch glyph. CLUSTER chips ride the info (cyan) tone; PLATFORM stays
// neutral (the muted category).
const ICON_HELM = "⎈";
const ICON_BRANCH = "⎇";
const CLUSTER = "CLUSTER";
const PLATFORM = "PLATFORM";

type RowItem = {
  icon?: string;
  chip?: { label: string; tone?: Tone };
  text: string;
  href?: string;
  trailing?: string;
};
type FeedEvent = { ts: number; item: RowItem };

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function withinHours(ms: number | null, now: Date, hours: number): boolean {
  if (ms === null) return false;
  const delta = now.getTime() - ms;
  return delta >= 0 && delta <= hours * HOUR_MS;
}

// Compact relative age ("now" / "21m" / "3h" / "yesterday" / "2d"), baked at
// collection time. keelson rows carry a static trailing string, so the age is a
// snapshot — it refreshes when the panel re-runs its workflow.
function relativeTime(ms: number, now: Date): string {
  const delta = now.getTime() - ms;
  if (delta < MINUTE_MS) return "now";
  const minutes = Math.floor(delta / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d`;
}

function openedText(mr: FeedMr): string {
  const parts: string[] = [];
  if (mr.iid != null) parts.push(`!${mr.iid}`);
  if (mr.title) parts.push(mr.title);
  const head = parts.join(" ");
  if (mr.author) return head ? `${head} — ${mr.author}` : mr.author;
  return head;
}

function platformRow(
  text: string,
  href: string | null | undefined,
  ts: number,
  now: Date,
): RowItem {
  return {
    icon: ICON_BRANCH,
    chip: { label: PLATFORM, tone: "neutral" },
    text,
    ...(href ? { href } : {}),
    trailing: relativeTime(ts, now),
  };
}

function openMrEvents(mrs: FeedMr[], now: Date): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const mr of mrs) {
    if (mr.draft) continue;
    if ((mr.state ?? "opened") !== "opened") continue;
    const ts = parseMs(mr.created_at);
    if (!withinHours(ts, now, EVENT_WINDOW_HOURS)) continue;
    const text = openedText(mr);
    if (!text) continue;
    out.push({ ts: ts as number, item: platformRow(text, mr.web_url, ts as number, now) });
  }
  return out;
}

function mergedMrEvents(mrs: FeedRelatedMr[], now: Date): FeedEvent[] {
  const out: FeedEvent[] = [];
  const seen = new Set<string>();
  for (const mr of mrs) {
    if (mr.state !== "merged") continue;
    const ts = parseMs(mr.merged_at);
    if (!withinHours(ts, now, EVENT_WINDOW_HOURS)) continue;
    const key = mr.web_url ?? `${mr.iid}-${mr.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = mr.iid != null ? `!${mr.iid} ` : "";
    const text = `${id}merged${mr.title ? ` — ${mr.title}` : ""}`;
    out.push({ ts: ts as number, item: platformRow(text, mr.web_url, ts as number, now) });
  }
  return out;
}

// Collapse CronJob fan-outs: jobs sharing a basename (everything before a
// trailing `-<epoch>` tag) and namespace fold into one row carrying the count
// and the earliest-still-recent timestamp.
function jobEvents(jobs: JobRow[], now: Date): FeedEvent[] {
  const groups = new Map<string, { ts: number; ns: string; basename: string; count: number }>();
  for (const job of jobs) {
    const ts = parseMs(job.created_at);
    if (!withinHours(ts, now, JOB_WINDOW_HOURS)) continue;
    const name = job.name ?? "";
    const ns = job.namespace ?? "";
    if (!name || !ns) continue;
    const basename = name.replace(/-\d+$/, "");
    const groupKey = `${ns}/${basename}`;
    const existing = groups.get(groupKey);
    if (!existing || (ts as number) < existing.ts) {
      groups.set(groupKey, { ts: ts as number, ns, basename, count: (existing?.count ?? 0) + 1 });
    } else {
      existing.count += 1;
    }
  }
  const out: FeedEvent[] = [];
  for (const g of groups.values()) {
    out.push({
      ts: g.ts,
      item: {
        icon: ICON_HELM,
        chip: { label: CLUSTER, tone: "info" },
        text:
          g.count > 1
            ? `${g.count} ${g.basename} jobs started (${g.ns})`
            : `Job ${g.basename} started (${g.ns})`,
        trailing: relativeTime(g.ts, now),
      },
    });
  }
  return out;
}

/**
 * Shape recent platform MRs (opened + merged) and cluster Jobs into a Current
 * Events board — a single newest-first feed of `rows`, each an icon +
 * CLUSTER/PLATFORM category chip + text + a relative-time trailing. `now` is
 * injected so age math is deterministic in tests. Always returns a valid board;
 * with nothing recent it shows a single "quiet" row.
 */
export function buildEventsBoard(input: EventsInput): CanvasBoardView {
  const { now } = input;
  const events: FeedEvent[] = [
    ...openMrEvents(input.openMrs ?? [], now),
    ...mergedMrEvents(input.mergedMrs ?? [], now),
    ...jobEvents(input.jobs ?? [], now),
  ];
  events.sort((a, b) => b.ts - a.ts);
  const items = events.slice(0, FEED_CAP).map((e) => e.item);
  const sections: CanvasBoardView["sections"] =
    items.length > 0
      ? [{ kind: "rows", items }]
      : [{ kind: "rows", items: [{ text: "No motion. Quiet right now." }] }];
  return { view: "board", title: "Current Events", sections };
}

// osdu-activity renders author as a username string; tolerate a {username|name}
// object too, since GitLab's raw author is an object.
function authorOf(a: unknown): string | null {
  if (typeof a === "string") return a;
  if (a && typeof a === "object") {
    const o = a as { username?: unknown; name?: unknown };
    if (typeof o.username === "string") return o.username;
    if (typeof o.name === "string") return o.name;
  }
  return null;
}

// Envelope extraction — the mr CLI nests rows under `data.projects[].merge_requests`.
// Tolerant of any missing level so a degraded payload yields an empty list.
export function extractFeedMrs(raw: unknown): FeedMr[] {
  const projects = (raw as { data?: { projects?: unknown } } | null)?.data?.projects;
  if (!Array.isArray(projects)) return [];
  const out: FeedMr[] = [];
  for (const p of projects) {
    const mrs = (p as { merge_requests?: unknown })?.merge_requests;
    if (!Array.isArray(mrs)) continue;
    for (const mr of mrs) {
      if (!mr || typeof mr !== "object") continue;
      const m = mr as Record<string, unknown>;
      out.push({
        iid: typeof m.iid === "number" ? m.iid : null,
        title: typeof m.title === "string" ? m.title : null,
        author: authorOf(m.author),
        web_url: typeof m.web_url === "string" ? m.web_url : null,
        created_at: typeof m.created_at === "string" ? m.created_at : null,
        state: typeof m.state === "string" ? m.state : null,
        draft: m.draft === true,
      });
    }
  }
  return out;
}

// The merged-MR source: an epic's `related_mrs` (the only place merged_at rides).
// Keeps merged rows only; the loader filters/dedupes downstream.
export function extractMergedRelatedMrs(raw: unknown): FeedRelatedMr[] {
  const epics = (raw as { data?: { epics?: unknown } } | null)?.data?.epics;
  if (!Array.isArray(epics)) return [];
  const out: FeedRelatedMr[] = [];
  for (const epic of epics) {
    const related = (epic as { related_mrs?: unknown })?.related_mrs;
    if (!Array.isArray(related)) continue;
    for (const mr of related) {
      if (!mr || typeof mr !== "object") continue;
      const m = mr as Record<string, unknown>;
      if (m.state !== "merged") continue;
      out.push({
        iid: typeof m.iid === "number" ? m.iid : null,
        title: typeof m.title === "string" ? m.title : null,
        web_url: typeof m.web_url === "string" ? m.web_url : null,
        state: "merged",
        merged_at: typeof m.merged_at === "string" ? m.merged_at : null,
      });
    }
  }
  return out;
}
