import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  buildEventsBoard,
  extractFeedMrs,
  extractMergedRelatedMrs,
  type FeedMr,
  type FeedRelatedMr,
  type JobRow,
} from "../src/events.ts";

const NOW = new Date("2026-06-06T12:00:00Z");

function rowsOf(board: ReturnType<typeof buildEventsBoard>) {
  const section = board.sections[0];
  if (section?.kind !== "rows") throw new Error("expected a rows section");
  return section.items;
}

describe("buildEventsBoard", () => {
  test("emits a valid Current Events board from all sources", () => {
    const board = buildEventsBoard({
      openMrs: [
        {
          iid: 1,
          title: "t",
          author: "a",
          created_at: "2026-06-06T11:00:00Z",
          state: "opened",
          web_url: "https://x/1",
        },
      ],
      jobs: [{ name: "boot-1", namespace: "p", created_at: "2026-06-06T11:00:00Z" }],
      now: NOW,
    });
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.title).toBe("Current Events");
  });

  test("an open MR becomes a PLATFORM row: branch icon, neutral chip, !iid title — author", () => {
    const openMrs: FeedMr[] = [
      {
        iid: 931,
        title: "add schemathesis tests",
        author: "achahan",
        web_url: "https://x/mr/931",
        created_at: "2026-06-06T09:00:00Z",
        state: "opened",
      },
    ];
    const items = rowsOf(buildEventsBoard({ openMrs, now: NOW }));
    expect(items).toEqual([
      {
        icon: "⎇",
        chip: { label: "PLATFORM", tone: "neutral" },
        text: "!931 add schemathesis tests — achahan",
        href: "https://x/mr/931",
        trailing: "3h",
      },
    ]);
  });

  test("a merged MR (from epic related_mrs) reads !iid merged — title, timed by merged_at", () => {
    const mergedMrs: FeedRelatedMr[] = [
      {
        iid: 744,
        title: "Acceptance tests hardening",
        web_url: "https://x/mr/744",
        state: "merged",
        merged_at: "2026-06-05T13:00:00Z",
      },
    ];
    const items = rowsOf(buildEventsBoard({ mergedMrs, now: NOW }));
    expect(items).toEqual([
      {
        icon: "⎇",
        chip: { label: "PLATFORM", tone: "neutral" },
        text: "!744 merged — Acceptance tests hardening",
        href: "https://x/mr/744",
        trailing: "23h",
      },
    ]);
  });

  test("a job becomes a CLUSTER row: helm icon, info chip, Job <basename> started (<ns>)", () => {
    const jobs: JobRow[] = [
      { name: "minio-bootstrap-1234", namespace: "platform", created_at: "2026-06-06T11:39:00Z" },
    ];
    const items = rowsOf(buildEventsBoard({ jobs, now: NOW }));
    expect(items).toEqual([
      {
        icon: "⎈",
        chip: { label: "CLUSTER", tone: "info" },
        text: "Job minio-bootstrap started (platform)",
        trailing: "21m",
      },
    ]);
  });

  test("CronJob fan-outs collapse by basename + namespace with a count", () => {
    const jobs: JobRow[] = [
      { name: "backup-100", namespace: "db", created_at: "2026-06-06T11:00:00Z" },
      { name: "backup-200", namespace: "db", created_at: "2026-06-06T11:30:00Z" },
      { name: "backup-300", namespace: "db", created_at: "2026-06-06T10:30:00Z" },
    ];
    const items = rowsOf(buildEventsBoard({ jobs, now: NOW }));
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe("3 backup jobs started (db)");
    // The earliest-still-recent timestamp drives the stamp (10:30 → 90m → 1h).
    expect(items[0]?.trailing).toBe("1h");
  });

  test("rows are newest-first across all three sources", () => {
    const board = buildEventsBoard({
      openMrs: [
        {
          iid: 1,
          title: "old open",
          author: "a",
          created_at: "2026-06-06T06:00:00Z",
          state: "opened",
        },
      ],
      mergedMrs: [
        { iid: 2, title: "recent merge", state: "merged", merged_at: "2026-06-06T11:50:00Z" },
      ],
      jobs: [{ name: "boot-1", namespace: "p", created_at: "2026-06-06T09:00:00Z" }],
      now: NOW,
    });
    expect(rowsOf(board).map((i) => i.text)).toEqual([
      "!2 merged — recent merge", // 10m
      "Job boot started (p)", // 3h
      "!1 old open — a", // 6h
    ]);
  });

  test("merged MRs dedupe by web_url", () => {
    const mergedMrs: FeedRelatedMr[] = [
      {
        iid: 5,
        title: "dup",
        state: "merged",
        merged_at: "2026-06-06T11:00:00Z",
        web_url: "https://x/5",
      },
      {
        iid: 5,
        title: "dup",
        state: "merged",
        merged_at: "2026-06-06T11:00:00Z",
        web_url: "https://x/5",
      },
    ];
    expect(rowsOf(buildEventsBoard({ mergedMrs, now: NOW }))).toHaveLength(1);
  });

  test("drafts, non-open MRs, and out-of-window motion are dropped", () => {
    const board = buildEventsBoard({
      openMrs: [
        {
          iid: 1,
          title: "draft",
          author: "a",
          created_at: "2026-06-06T11:00:00Z",
          state: "opened",
          draft: true,
        },
        {
          iid: 2,
          title: "closed",
          author: "a",
          created_at: "2026-06-06T11:00:00Z",
          state: "closed",
        },
        {
          iid: 3,
          title: "stale",
          author: "a",
          created_at: "2026-06-04T11:00:00Z",
          state: "opened",
        },
      ],
      jobs: [{ name: "old-1", namespace: "p", created_at: "2026-06-06T04:00:00Z" }],
      now: NOW,
    });
    expect(rowsOf(board)).toEqual([{ text: "No motion. Quiet right now." }]);
  });

  test("caps the feed at 12 newest rows", () => {
    const openMrs: FeedMr[] = Array.from({ length: 20 }, (_, i) => ({
      iid: i + 1,
      title: `mr ${i + 1}`,
      author: "a",
      created_at: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString(),
      state: "opened",
    }));
    expect(rowsOf(buildEventsBoard({ openMrs, now: NOW }))).toHaveLength(12);
  });

  test("an empty feed renders a single quiet row", () => {
    expect(rowsOf(buildEventsBoard({ now: NOW }))).toEqual([
      { text: "No motion. Quiet right now." },
    ]);
  });
});

describe("extractFeedMrs", () => {
  test("flattens data.projects[].merge_requests[] and normalizes author", () => {
    const raw = {
      data: {
        projects: [
          {
            merge_requests: [
              {
                iid: 1,
                title: "t1",
                author: "stringauthor",
                created_at: "2026-06-06T11:00:00Z",
                state: "opened",
              },
              {
                iid: 2,
                title: "t2",
                author: { username: "objauthor" },
                created_at: "2026-06-06T11:00:00Z",
              },
            ],
          },
          { merge_requests: [] },
          {},
        ],
      },
    };
    const mrs = extractFeedMrs(raw);
    expect(mrs).toHaveLength(2);
    expect(mrs[0]?.author).toBe("stringauthor");
    expect(mrs[1]?.author).toBe("objauthor");
  });

  test("tolerates a missing/degraded envelope", () => {
    expect(extractFeedMrs(null)).toEqual([]);
    expect(extractFeedMrs({})).toEqual([]);
    expect(extractFeedMrs({ data: { projects: "nope" } })).toEqual([]);
  });
});

describe("extractMergedRelatedMrs", () => {
  test("keeps only merged related_mrs across epics, carrying merged_at", () => {
    const raw = {
      data: {
        epics: [
          {
            related_mrs: [
              {
                iid: 10,
                title: "m",
                state: "merged",
                merged_at: "2026-06-05T13:00:00Z",
                web_url: "u",
              },
              { iid: 11, title: "o", state: "opened", merged_at: null },
            ],
          },
          {
            related_mrs: [
              { iid: 12, title: "m2", state: "merged", merged_at: "2026-06-06T01:00:00Z" },
            ],
          },
        ],
      },
    };
    const merged = extractMergedRelatedMrs(raw);
    expect(merged.map((m) => m.iid)).toEqual([10, 12]);
    expect(merged[0]?.merged_at).toBe("2026-06-05T13:00:00Z");
  });

  test("tolerates a missing envelope", () => {
    expect(extractMergedRelatedMrs(null)).toEqual([]);
    expect(extractMergedRelatedMrs({ data: {} })).toEqual([]);
  });
});
