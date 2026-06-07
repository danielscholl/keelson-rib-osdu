import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, canvasViewSchema } from "@keelson/shared";
import type { MyMr } from "../src/activity.ts";
import type { JobRow } from "../src/events.ts";
import type { FluxKustomization } from "../src/topology.ts";
import { buildWaitingBoard, composeQueue, type QueueItem } from "../src/waiting.ts";

const NOW = new Date("2026-06-06T12:00:00Z");

function mr(over: Partial<MyMr> = {}): MyMr {
  return {
    iid: 1,
    title: "t",
    webUrl: "https://u",
    projectPath: "osdu/platform/deployment-and-operations/cimpl-stack",
    role: "author",
    draft: false,
    pipeline: "success",
    mergeStatus: "MERGEABLE",
    updatedAt: "2026-06-04T00:00:00Z",
    ...over,
  };
}

function flux(
  name: string,
  ready: boolean,
  opts: { namespace?: string; suspend?: boolean } = {},
): FluxKustomization {
  return {
    metadata: { name, namespace: opts.namespace ?? "flux-system" },
    spec: opts.suspend ? { suspend: true } : {},
    status: { conditions: [{ type: "Ready", status: ready ? "True" : "False" }] },
  };
}

function rowsItems(board: CanvasBoardView) {
  const section = board.sections[0];
  if (section?.kind !== "rows") throw new Error("expected a rows section");
  return section.items;
}

const only = (m: MyMr) => composeQueue({ mrs: [m], now: NOW });

describe("composeQueue — merge requests", () => {
  test("your MR: failed pipeline → P0", () => {
    expect(only(mr({ role: "author", pipeline: "failed" }))[0]?.priority).toBe("P0");
  });

  test("your MR: changes requested → P0", () => {
    expect(only(mr({ role: "author", mergeStatus: "REQUESTED_CHANGES" }))[0]?.priority).toBe("P0");
  });

  test("your MR: ready to merge (mergeable + green) → P2", () => {
    expect(
      only(mr({ role: "author", mergeStatus: "MERGEABLE", pipeline: "success" }))[0]?.priority,
    ).toBe("P2");
  });

  test("review requested → P1 regardless of pipeline/merge status", () => {
    expect(
      only(mr({ role: "reviewer", mergeStatus: "REQUESTED_CHANGES", pipeline: "failed" }))[0]
        ?.priority,
    ).toBe("P1");
  });

  test("drafts and in-flight authored MRs are skipped", () => {
    expect(only(mr({ role: "author", draft: true, pipeline: "failed" }))).toHaveLength(0);
    expect(
      only(mr({ role: "author", mergeStatus: "CI_STILL_RUNNING", pipeline: "running" })),
    ).toHaveLength(0);
  });

  test("id namespaces by project slug to avoid cross-project iid collisions", () => {
    expect(only(mr({ iid: 120 }))[0]?.id).toBe("queue-mr-cimpl-stack-120");
  });

  test("title and age ride iid + updatedAt", () => {
    const item = only(
      mr({ iid: 120, title: "docs proposal", updatedAt: "2026-06-03T12:00:00Z" }),
    )[0];
    expect(item?.title).toBe("!120 — docs proposal");
    expect(item?.ageDays).toBe(3);
  });

  test("orders P0 < P1 < P2, mirroring the dashboard scenario", () => {
    const items = composeQueue({
      mrs: [
        mr({ iid: 120, role: "author", mergeStatus: "MERGEABLE", pipeline: "success" }),
        mr({ iid: 125, role: "author", mergeStatus: "MERGEABLE", pipeline: "success" }),
        mr({ iid: 1302, role: "author", draft: true }),
        mr({ iid: 124, role: "reviewer" }),
        mr({ iid: 1287, role: "reviewer", mergeStatus: "REQUESTED_CHANGES" }),
      ],
      now: NOW,
    });
    expect(items.map((i) => [i.priority, i.id])).toEqual([
      ["P1", "queue-mr-cimpl-stack-124"],
      ["P1", "queue-mr-cimpl-stack-1287"],
      ["P2", "queue-mr-cimpl-stack-120"],
      ["P2", "queue-mr-cimpl-stack-125"],
    ]);
  });
});

describe("composeQueue — cluster", () => {
  test("not-ready kustomizations/helmreleases (P0) and failed jobs (P1); ready/suspended/ok skipped", () => {
    const jobs: JobRow[] = [
      { name: "loader", namespace: "data", status: "Failed", failed: 3 },
      { name: "fine", namespace: "data", status: "Complete", failed: 0 },
    ];
    const items = composeQueue({
      kustomizations: [
        flux("kbad", false),
        flux("kgood", true),
        flux("ksusp", false, { suspend: true }),
      ],
      helmreleases: [flux("hbad", false, { namespace: "apps" })],
      jobs,
      now: NOW,
    });
    expect(items.map((i) => [i.priority, i.id, i.title])).toEqual([
      ["P0", "queue-helmrelease-apps-hbad", "HelmRelease apps/hbad not ready"],
      ["P0", "queue-kustomization-kbad", "Kustomization kbad not ready"],
      ["P1", "queue-job-data-loader", "Job loader failed"],
    ]);
  });
});

describe("composeQueue — sort and cap", () => {
  test("breaks ties by id and caps at six", () => {
    const kustomizations = Array.from({ length: 8 }, (_, i) => flux(`k${i}`, false));
    const items = composeQueue({ kustomizations, now: NOW });
    expect(items).toHaveLength(6);
    expect(items[0]?.id).toBe("queue-kustomization-k0");
    expect(new Set(items.map((i) => i.id)).size).toBe(6);
  });
});

describe("buildWaitingBoard", () => {
  test("empty queue renders a valid board with the reassuring row", () => {
    const board = buildWaitingBoard([]);
    expect(canvasViewSchema.parse(board).view).toBe("board");
    expect(board.title).toBe("Waiting on You");
    expect(rowsItems(board)).toEqual([{ text: "Nothing needs your attention right now." }]);
  });

  test("each item renders a priority chip, link, and age trailing", () => {
    const items: QueueItem[] = [
      { id: "x", priority: "P0", title: "t", url: "https://u", ageDays: 3 },
    ];
    const board = buildWaitingBoard(items);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(rowsItems(board)[0]).toEqual({
      chip: { label: "P0", tone: "error" },
      text: "t",
      href: "https://u",
      trailing: "3d",
    });
  });
});
