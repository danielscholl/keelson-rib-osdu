// The "Waiting on You" personal queue — items the operator personally must act
// on. The MR rows mirror the operator's GitLab dashboard (their authored and
// review-requested open MRs, resolved via currentUser — see fetchMyMergeRequests),
// across the whole instance rather than the Venus-core scope; the cluster rows
// surface Flux/Job trouble that needs a human. Render-only (priority pill ·
// title · age).

import type { CanvasBoardView } from "@keelson/shared";
import type { MyMr } from "./activity.ts";
import type { JobRow, Tone } from "./events.ts";
import { isReady } from "./kubectl.ts";
import type { FluxKustomization } from "./topology.ts";

type Priority = "P0" | "P1" | "P2" | "P3";

const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const PRIORITY_TONE: Record<Priority, Tone> = {
  P0: "error",
  P1: "warn",
  P2: "caution",
  P3: "neutral",
};
const QUEUE_CAP = 6;
const DAY_MS = 86_400_000;

export interface QueueItem {
  id: string;
  priority: Priority;
  title: string;
  url?: string | null;
  ageDays?: number | null;
}

export interface ComposeQueueInput {
  mrs?: MyMr[];
  kustomizations?: FluxKustomization[];
  helmreleases?: FluxKustomization[];
  jobs?: JobRow[];
  now: Date;
}

type RowItem = {
  chip?: { label: string; tone?: Tone };
  text: string;
  href?: string;
  trailing?: string;
};

function dayAge(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

// Rank a personal-dashboard MR, or null to drop it. Drafts are WIP, never queued.
// Your MR: failed/manual pipeline or changes-requested needs your action (P0),
// ready-to-merge is a lower nudge (P2). A review request means someone is blocked
// on you (P1).
function mrPriority(mr: MyMr): Priority | null {
  if (mr.draft) return null;
  if (mr.role === "reviewer") return "P1";
  const pipeline = mr.pipeline ?? "";
  if (pipeline === "failed" || pipeline === "manual") return "P0";
  if (mr.mergeStatus === "REQUESTED_CHANGES") return "P0";
  if (mr.mergeStatus === "MERGEABLE" && pipeline === "success") return "P2";
  return null;
}

function queueFromMyMrs(mrs: MyMr[], now: Date): QueueItem[] {
  const items: QueueItem[] = [];
  for (const mr of mrs) {
    if (mr.iid == null) continue;
    const priority = mrPriority(mr);
    if (!priority) continue;
    const slug = mr.projectPath?.split("/").pop() || "mr";
    items.push({
      id: `queue-mr-${slug}-${mr.iid}`,
      priority,
      title: `!${mr.iid} — ${mr.title || "untitled MR"}`,
      url: mr.webUrl ?? null,
      ageDays: dayAge(mr.updatedAt, now),
    });
  }
  return items;
}

// A suspended Flux resource is intentionally paused, not failing — exclude it so
// it never reads as "waiting on you".
function isActionableNotReady(item: FluxKustomization): boolean {
  if (item.spec?.suspend === true) return false;
  return !isReady(item);
}

function queueFromCluster(
  kustomizations: FluxKustomization[],
  helmreleases: FluxKustomization[],
  jobs: JobRow[],
): QueueItem[] {
  const items: QueueItem[] = [];

  for (const k of kustomizations) {
    if (!isActionableNotReady(k)) continue;
    const name = k.metadata?.name || "?";
    items.push({
      id: `queue-kustomization-${name}`,
      priority: "P0",
      title: `Kustomization ${name} not ready`,
    });
  }

  for (const hr of helmreleases) {
    if (!isActionableNotReady(hr)) continue;
    const name = hr.metadata?.name || "?";
    const ns = hr.metadata?.namespace || "?";
    items.push({
      id: `queue-helmrelease-${ns}-${name}`,
      priority: "P0",
      title: `HelmRelease ${ns}/${name} not ready`,
    });
  }

  for (const j of jobs) {
    if (j.status !== "Failed") continue;
    const name = j.name || "?";
    const ns = j.namespace || "?";
    items.push({ id: `queue-job-${ns}-${name}`, priority: "P1", title: `Job ${name} failed` });
  }

  return items;
}

/**
 * Compose the personal queue: your MRs (P0 pipeline failed / changes-requested,
 * P2 ready-to-merge), MRs awaiting your review (P1), not-ready Flux
 * kustomization/helmrelease (P0), failed load job (P1). Sorted by priority then
 * id, capped at 6. `now` is injected so age math is deterministic in tests.
 */
export function composeQueue(input: ComposeQueueInput): QueueItem[] {
  const combined = [
    ...queueFromMyMrs(input.mrs ?? [], input.now),
    ...queueFromCluster(input.kustomizations ?? [], input.helmreleases ?? [], input.jobs ?? []),
  ];
  combined.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 9;
    const pb = PRIORITY_ORDER[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return combined.slice(0, QUEUE_CAP);
}

/**
 * Shape the queue into a Waiting on You board — a single `rows` section, each a
 * priority chip + title + a link and an age trailing. Empty queue → a single
 * reassuring row. Always returns a valid board.
 */
export function buildWaitingBoard(items: QueueItem[]): CanvasBoardView {
  const rows: RowItem[] =
    items.length > 0
      ? items.map((item) => {
          const row: RowItem = {
            chip: { label: item.priority, tone: PRIORITY_TONE[item.priority] },
            text: item.title,
          };
          if (item.url) row.href = item.url;
          if (item.ageDays != null) row.trailing = `${item.ageDays}d`;
          return row;
        })
      : [{ text: "Nothing needs your attention right now." }];
  return { view: "board", title: "Waiting on You", sections: [{ kind: "rows", items: rows }] };
}
