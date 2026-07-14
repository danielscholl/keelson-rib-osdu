import { describe, expect, test } from "bun:test";
import { type CanvasBoardView, canvasViewSchema } from "@keelson/shared";
import type { FeedRelatedMr } from "../src/events.ts";
import {
  buildReleaseBoard,
  extractMilestoneFilter,
  extractReleaseMrs,
  milestoneToken,
  projectTone,
  type ReleaseMr,
  releaseTrain,
  resolveReleaseTrain,
} from "../src/release.ts";

const DECORATIVE_TONES = ["info", "brand", "accent", "caution", "ok"];

const NOW = new Date("2026-06-06T12:00:00Z");
const PMC_LINKS = [
  { text: "Status Summary", href: "https://pmc.example.test/" },
  { text: "Analytics", href: "https://pmc.example.test/analytics/index.html" },
];

// A core service so the MR counts as a platform win.
const url = (service: string, iid: number) =>
  `https://gitlab/osdu/${service}/-/merge_requests/${iid}`;

function rowsIn(board: CanvasBoardView, col: number) {
  const section = board.sections[0];
  if (section?.kind !== "columns") throw new Error("expected a columns section");
  const leaf = section.columns[col]?.sections[0];
  if (leaf?.kind !== "rows") throw new Error("expected a rows section");
  return leaf.items;
}
const newMrItems = (board: CanvasBoardView) => rowsIn(board, 0);
const winItems = (board: CanvasBoardView) => rowsIn(board, 1);

describe("buildReleaseBoard", () => {
  test("emits a valid Release Train board with two titled columns", () => {
    const board = buildReleaseBoard({
      openMrs: [
        { iid: 1, title: "t", state: "opened", milestone: "M26", web_url: url("storage", 1) },
      ],
      mergedMrs: [
        {
          iid: 2,
          title: "m",
          state: "merged",
          merged_at: "2026-06-05T12:00:00Z",
          web_url: url("legal", 2),
        },
      ],
      now: NOW,
    });
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.title).toBe("Release Train");
    const section = board.sections[0];
    if (section?.kind !== "columns") throw new Error("expected columns");
    expect(section.columns).toHaveLength(2);
    expect(section.columns[0]?.sections[0]?.title).toBe("New Merge Requests");
    expect(section.columns[1]?.sections[0]?.title).toBe("Platform Wins");
  });

  test("the active milestone (most-common) becomes the header chip", () => {
    const board = buildReleaseBoard({
      openMrs: [
        { iid: 1, title: "a", state: "opened", milestone: "M26 - Release 0.29" },
        { iid: 2, title: "b", state: "opened", milestone: "M26 - Release 0.29" },
        { iid: 3, title: "c", state: "opened", milestone: "M25 - Release 0.28" },
      ],
      now: NOW,
    });
    expect(board.header?.chip).toBe("M26 - Release 0.29");
  });

  test("no milestone anywhere → no header", () => {
    const board = buildReleaseBoard({
      openMrs: [{ iid: 1, title: "a", state: "opened" }],
      now: NOW,
    });
    expect(board.header).toBeUndefined();
  });

  test("the CLI-resolved release wins over the MR mode", () => {
    const board = buildReleaseBoard({
      release: "M26 - Release 0.29 (Venus - Preview 1)",
      openMrs: [{ iid: 1, title: "a", state: "opened", milestone: "M99 - stray" }],
      now: NOW,
    });
    expect(board.header?.chip).toBe("M26 - Release 0.29 (Venus - Preview 1)");
  });

  test("an empty open-MR queue still shows the resolved release", () => {
    const board = buildReleaseBoard({ release: "M26 - Release 0.29", openMrs: [], now: NOW });
    expect(board.header?.chip).toBe("M26 - Release 0.29");
    expect(newMrItems(board)).toEqual([{ text: "No open merge requests." }]);
  });

  test("falls back to the MR mode when no release is resolved", () => {
    const board = buildReleaseBoard({
      release: "  ",
      openMrs: [{ iid: 1, title: "a", state: "opened", milestone: "M26 (mode)" }],
      now: NOW,
    });
    expect(board.header?.chip).toBe("M26 (mode)");
  });

  test("trails a badge-less PMC Report grid after the columns when links are present", () => {
    const board = buildReleaseBoard({
      pmcLinks: PMC_LINKS,
      openMrs: [{ iid: 1, title: "a", state: "opened", milestone: "M26 - Release 0.30" }],
      now: NOW,
    });
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.sections).toHaveLength(2);

    // The queue leads; the constant links trail it.
    const columns = board.sections[0];
    if (columns?.kind !== "columns") throw new Error("expected columns first");
    expect(columns.columns).toHaveLength(2);

    const report = board.sections[1];
    if (report?.kind !== "grid") throw new Error("expected report grid after columns");
    expect(report.title).toBe("PMC Report");
    expect(report.cells).toEqual(PMC_LINKS.map((l) => ({ label: l.text, href: l.href })));
    // No badge: there is no per-link signal to grade, so none is invented.
    expect(report.cells.every((cell) => cell.badge === undefined)).toBe(true);
  });

  test("omits the PMC Report section when no links are present", () => {
    for (const pmcLinks of [undefined, [], [{ text: "Status Summary", href: "  " }]]) {
      const board = buildReleaseBoard({ pmcLinks, now: NOW });
      expect(board.sections).toHaveLength(1);
      expect(board.sections[0]?.kind).toBe("columns");
      expect(
        board.sections.some((section) => section.kind === "grid" && section.title === "PMC Report"),
      ).toBe(false);
    }
  });

  test("a New MR row carries branch icon, service chip, !iid — title, age, href", () => {
    const board = buildReleaseBoard({
      openMrs: [
        {
          iid: 931,
          title: "add schemathesis tests",
          state: "opened",
          web_url: url("storage", 931),
          created_at: "2026-06-04T12:00:00Z",
        },
      ],
      now: NOW,
    });
    expect(newMrItems(board)).toEqual([
      {
        icon: "⎇",
        chip: { label: "storage", tone: projectTone("storage") },
        text: "!931 — add schemathesis tests",
        href: url("storage", 931),
        trailing: "2d",
      },
    ]);
  });

  test("New MRs drop drafts and non-open, sort newest-first, tiebreak iid desc", () => {
    const board = buildReleaseBoard({
      openMrs: [
        {
          iid: 1,
          title: "draft",
          state: "opened",
          draft: true,
          created_at: "2026-06-06T11:00:00Z",
        },
        { iid: 2, title: "closed", state: "closed", created_at: "2026-06-06T11:00:00Z" },
        { iid: 3, title: "older", state: "opened", created_at: "2026-06-05T12:00:00Z" },
        { iid: 4, title: "newer-a", state: "opened", created_at: "2026-06-06T10:00:00Z" },
        { iid: 5, title: "newer-b", state: "opened", created_at: "2026-06-06T10:00:00Z" },
      ],
      now: NOW,
    });
    expect(newMrItems(board).map((r) => r.text)).toEqual([
      "!5 — newer-b",
      "!4 — newer-a",
      "!3 — older",
    ]);
  });

  test("New MRs cap at 6", () => {
    const openMrs: ReleaseMr[] = Array.from({ length: 9 }, (_, i) => ({
      iid: i + 1,
      title: `mr ${i + 1}`,
      state: "opened",
      created_at: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString(),
    }));
    expect(newMrItems(buildReleaseBoard({ openMrs, now: NOW }))).toHaveLength(6);
  });

  test("no open MRs → New Merge Requests shows an empty-state row", () => {
    expect(newMrItems(buildReleaseBoard({ now: NOW }))).toEqual([
      { text: "No open merge requests." },
    ]);
  });

  test("Platform Wins lead with the count, then the merged MRs as check rows", () => {
    const mergedMrs: FeedRelatedMr[] = [
      {
        iid: 744,
        title: "Acceptance tests hardening",
        state: "merged",
        merged_at: "2026-06-05T12:00:00Z",
        web_url: url("storage", 744),
      },
    ];
    expect(winItems(buildReleaseBoard({ mergedMrs, now: NOW }))).toEqual([
      { icon: "✓", text: "1 MR merged to main this week" },
      {
        icon: "✓",
        text: "!744 — Acceptance tests hardening",
        href: url("storage", 744),
        trailing: "1d",
      },
    ]);
  });

  test("Wins count is pluralized", () => {
    const mergedMrs: FeedRelatedMr[] = [
      {
        iid: 1,
        title: "a",
        state: "merged",
        merged_at: "2026-06-05T12:00:00Z",
        web_url: url("legal", 1),
      },
      {
        iid: 2,
        title: "b",
        state: "merged",
        merged_at: "2026-06-05T12:00:00Z",
        web_url: url("policy", 2),
      },
    ];
    expect(winItems(buildReleaseBoard({ mergedMrs, now: NOW }))[0]?.text).toBe(
      "2 MRs merged to main this week",
    );
  });

  test("Wins exclude non-core services, out-of-window merges, and dedupe by web_url", () => {
    const mergedMrs: FeedRelatedMr[] = [
      {
        iid: 1,
        title: "core",
        state: "merged",
        merged_at: "2026-06-05T12:00:00Z",
        web_url: url("storage", 1),
      },
      {
        iid: 2,
        title: "non-core",
        state: "merged",
        merged_at: "2026-06-05T12:00:00Z",
        web_url: url("infra-helm", 2),
      },
      {
        iid: 3,
        title: "stale",
        state: "merged",
        merged_at: "2026-05-28T12:00:00Z",
        web_url: url("legal", 3),
      },
      {
        iid: 1,
        title: "core-dup",
        state: "merged",
        merged_at: "2026-06-05T12:00:00Z",
        web_url: url("storage", 1),
      },
    ];
    expect(winItems(buildReleaseBoard({ mergedMrs, now: NOW }))[0]?.text).toBe(
      "1 MR merged to main this week",
    );
  });

  test("Wins list caps at 6 MRs while the count reflects the true total", () => {
    const mergedMrs: FeedRelatedMr[] = Array.from({ length: 8 }, (_, i) => ({
      iid: i + 1,
      title: `m ${i + 1}`,
      state: "merged" as const,
      merged_at: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
      web_url: url("storage", i + 1),
    }));
    const items = winItems(buildReleaseBoard({ mergedMrs, now: NOW }));
    expect(items[0]?.text).toBe("8 MRs merged to main this week");
    expect(items).toHaveLength(7); // 1 count line + 6 capped MR rows
  });

  test("no core merges → Platform Wins shows an empty-state row", () => {
    expect(winItems(buildReleaseBoard({ now: NOW }))).toEqual([{ text: "No wins this week." }]);
  });
});

describe("releaseTrain", () => {
  test("returns the most-common milestone token", () => {
    expect(releaseTrain([{ milestone: "A" }, { milestone: "A" }, { milestone: "B" }])).toBe("A");
  });

  test("ties resolve to the first-seen token", () => {
    expect(
      releaseTrain([
        { milestone: "B" },
        { milestone: "A" },
        { milestone: "A" },
        { milestone: "B" },
      ]),
    ).toBe("B");
  });

  test("no milestones → null", () => {
    expect(releaseTrain([])).toBeNull();
    expect(releaseTrain([{ iid: 1 }, { milestone: null }])).toBeNull();
  });

  // The banner regression guard: with --milestone dropped, the all-core fetch
  // mixes the current release, a few stragglers on the prior one, and many
  // milestone-less MRs. The plurality (current release) must win and nulls must
  // not dilute it.
  test("current-release plurality wins over stragglers and null-milestone MRs", () => {
    const current = "M27 - Release 0.30 (Venus - Preview 2)";
    const prior = "M26 - Release 0.29 (Venus - Preview 1)";
    expect(
      releaseTrain([
        { milestone: current },
        { milestone: current },
        { milestone: current },
        { milestone: prior },
        { milestone: null },
        { milestone: null },
      ]),
    ).toBe(current);
  });

  test("drafts are excluded from the milestone tally", () => {
    // Two drafts on a future milestone must not outvote the single real MR.
    expect(
      releaseTrain([
        { milestone: "Real", draft: false },
        { milestone: "Future", draft: true },
        { milestone: "Future", draft: true },
      ]),
    ).toBe("Real");
  });
});

describe("resolveReleaseTrain", () => {
  test("prefers a non-empty resolved release before falling back to the MR mode", () => {
    expect(resolveReleaseTrain(" M26 - Release 0.29 ", [{ milestone: "M99" }])).toBe(
      "M26 - Release 0.29",
    );
    expect(resolveReleaseTrain("  ", [{ milestone: "M26" }])).toBe("M26");
  });
});

describe("milestoneToken", () => {
  test("resolves a string, {title}, or {name}; null otherwise", () => {
    expect(milestoneToken("M26")).toBe("M26");
    expect(milestoneToken({ title: "M26 - Release 0.29" })).toBe("M26 - Release 0.29");
    expect(milestoneToken({ name: "fallback" })).toBe("fallback");
    expect(milestoneToken({ id: 1 })).toBeNull();
    expect(milestoneToken("   ")).toBeNull();
    expect(milestoneToken(null)).toBeNull();
  });
});

describe("extractReleaseMrs", () => {
  test("flattens projects[].merge_requests[] and resolves the milestone token", () => {
    const raw = {
      data: {
        projects: [
          {
            merge_requests: [
              {
                iid: 1,
                title: "t1",
                state: "opened",
                created_at: "2026-06-06T11:00:00Z",
                milestone: {
                  id: 229,
                  title: "M26 - Release 0.29 (Venus - Preview 1)",
                  state: "active",
                },
              },
              {
                iid: 2,
                title: "t2",
                state: "opened",
                milestone: null,
                milestone_title: "M25 fallback",
              },
            ],
          },
          {},
        ],
      },
    };
    const mrs = extractReleaseMrs(raw);
    expect(mrs).toHaveLength(2);
    expect(mrs[0]?.milestone).toBe("M26 - Release 0.29 (Venus - Preview 1)");
    expect(mrs[1]?.milestone).toBe("M25 fallback");
  });

  test("tolerates a missing/degraded envelope", () => {
    expect(extractReleaseMrs(null)).toEqual([]);
    expect(extractReleaseMrs({})).toEqual([]);
    expect(extractReleaseMrs({ data: { projects: "nope" } })).toEqual([]);
  });
});

describe("extractMilestoneFilter", () => {
  test("reads the resolved release from parameters.milestone_filter", () => {
    const raw = { parameters: { milestone_filter: "M26 - Release 0.29 (Venus - Preview 1)" } };
    expect(extractMilestoneFilter(raw)).toBe("M26 - Release 0.29 (Venus - Preview 1)");
  });

  test("returns null when absent, blank, or non-string", () => {
    expect(extractMilestoneFilter(null)).toBeNull();
    expect(extractMilestoneFilter({})).toBeNull();
    expect(extractMilestoneFilter({ parameters: { milestone_filter: "  " } })).toBeNull();
    expect(extractMilestoneFilter({ parameters: { milestone_filter: null } })).toBeNull();
  });
});

describe("projectTone", () => {
  test("is stable per service and always a decorative palette tone", () => {
    expect(projectTone("storage")).toBe(projectTone("storage"));
    for (const svc of ["storage", "legal", "partition", "entitlements", "file", "cimpl-stack"]) {
      expect(DECORATIVE_TONES).toContain(projectTone(svc));
    }
  });

  test("spreads the core services across more than one color", () => {
    const core = ["partition", "legal", "entitlements", "file", "storage", "policy", "secret"];
    expect(new Set(core.map(projectTone)).size).toBeGreaterThan(1);
  });
});
