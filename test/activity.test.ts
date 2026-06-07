import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActivityRunner,
  fetchMrUpdatedAt,
  fetchWorkItemAssignees,
  type GraphqlRunner,
  isVenusCore,
  loadVenusBundle,
  parseLenient,
  serviceOf,
  VENUS_CORE,
} from "../src/activity.ts";

// A core service project and an off-core (DDMS) project — scoping must keep the
// former and drop the latter.
function mrEnvelope() {
  return {
    parameters: { milestone_filter: null },
    data: {
      projects: [
        {
          project_path: "osdu/platform/system/storage",
          merge_requests: [
            { iid: 1, state: "opened", draft: false, created_at: "2026-01-01T00:00:00Z" },
          ],
        },
        {
          project_path: "osdu/platform/ddms/well-delivery-ddms",
          merge_requests: [{ iid: 9, state: "opened", draft: false }],
        },
      ],
    },
  };
}

function epicEnvelope() {
  return {
    data: {
      epics: [
        { iid: 10, title: "Has assignee", liveness: "active", assignees: [] },
        { iid: 20, title: "No assignee", liveness: "active", assignees: [] },
      ],
    },
  };
}

function fakeActivity(seen: string[][] = []): ActivityRunner {
  return (args) => {
    seen.push(args);
    if (args[0] === "mr") return { json: mrEnvelope() };
    if (args[0] === "epic") return { json: epicEnvelope() };
    return { error: "unexpected args" };
  };
}

const assigneeBody = {
  data: {
    group: {
      e10: { widgets: [{}, { assignees: { nodes: [{ username: "alice" }] } }] },
      e20: { widgets: [{}] },
    },
  },
};
const updatedBody = {
  data: {
    group: {
      mergeRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            iid: 1,
            updatedAt: "2026-06-01T00:00:00Z",
            project: { fullPath: "osdu/platform/system/storage" },
          },
        ],
      },
    },
  },
};

function fakeGraphql(): GraphqlRunner {
  return (query) => {
    if (query.includes("workItem")) return { json: assigneeBody };
    if (query.includes("mergeRequests")) return { json: updatedBody };
    return { error: "unexpected query" };
  };
}

describe("parseLenient / scope helpers", () => {
  test("parseLenient strips control characters that break JSON.parse", () => {
    expect(parseLenient('{"t":"a\nb"}')).toEqual({ t: "a b" });
  });

  test("serviceOf is the project-path tail; VENUS_CORE membership", () => {
    expect(serviceOf("osdu/platform/system/storage")).toBe("storage");
    expect(serviceOf(null)).toBe("");
    expect(VENUS_CORE.has("storage")).toBe(true);
    expect(isVenusCore("osdu/platform/system/storage")).toBe(true);
    expect(isVenusCore("osdu/platform/ddms/well-delivery-ddms")).toBe(false);
  });
});

describe("fetchWorkItemAssignees", () => {
  test("maps the ASSIGNEES widget per epic iid; misses absent", () => {
    const map = fetchWorkItemAssignees([10, 20], fakeGraphql());
    expect(map.get(10)).toEqual(["alice"]);
    expect(map.has(20)).toBe(false);
  });

  test("fail-closed: graphql error yields an empty map", () => {
    const map = fetchWorkItemAssignees([10], () => ({ error: "boom" }));
    expect(map.size).toBe(0);
  });

  test("no iids → no query", () => {
    let called = 0;
    const map = fetchWorkItemAssignees([], () => {
      called++;
      return { json: assigneeBody };
    });
    expect(called).toBe(0);
    expect(map.size).toBe(0);
  });
});

describe("fetchMrUpdatedAt", () => {
  test("keys last-activity by project-path and iid", () => {
    const map = fetchMrUpdatedAt(fakeGraphql());
    expect(map.get("osdu/platform/system/storage!1")).toBe("2026-06-01T00:00:00Z");
  });

  test("fail-closed: graphql error yields an empty map", () => {
    expect(fetchMrUpdatedAt(() => ({ error: "boom" })).size).toBe(0);
  });
});

describe("loadVenusBundle", () => {
  test("scopes MRs to core, injects project_path, drops --milestone, enriches", () => {
    const seen: string[][] = [];
    const bundle = loadVenusBundle({
      runActivity: fakeActivity(seen),
      runGraphql: fakeGraphql(),
      cacheDir: null,
    });

    const mrArgs = seen.find((a) => a[0] === "mr") ?? [];
    expect(mrArgs).not.toContain("--milestone");

    const projects = (
      bundle.mrsRaw as {
        data: {
          projects: {
            project_path: string;
            merge_requests: { project_path?: string; updated_at?: string }[];
          }[];
        };
      }
    ).data.projects;
    // Off-core DDMS project dropped.
    expect(projects).toHaveLength(1);
    expect(projects[0]?.project_path).toBe("osdu/platform/system/storage");
    // project_path stamped on each MR + updated_at backfilled.
    expect(projects[0]?.merge_requests[0]?.project_path).toBe("osdu/platform/system/storage");
    expect(projects[0]?.merge_requests[0]?.updated_at).toBe("2026-06-01T00:00:00Z");

    const epics = (bundle.epicsRaw as { data: { epics: { iid: number; assignees: string[] }[] } })
      .data.epics;
    expect(epics.find((e) => e.iid === 10)?.assignees).toEqual(["alice"]);
    expect(epics.find((e) => e.iid === 20)?.assignees).toEqual([]);

    expect(bundle.errors).toHaveLength(0);
  });

  test("a degraded source is reported, never thrown", () => {
    const bundle = loadVenusBundle({
      runActivity: (args) => (args[0] === "mr" ? { error: "cli down" } : { json: epicEnvelope() }),
      runGraphql: () => ({ error: "no graphql" }),
      cacheDir: null,
    });
    expect(bundle.errors.some((e) => e.includes("mrs degraded"))).toBe(true);
    // Epics still flow; enrichment degraded to no-op (assignees untouched).
    const epics = (bundle.epicsRaw as { data: { epics: { assignees: string[] }[] } }).data.epics;
    expect(epics[0]?.assignees).toEqual([]);
  });
});

describe("loadVenusBundle cache", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("serves a hit within TTL and refetches after expiry", () => {
    const dir = join(tmpdir(), `rib-osdu-test-${process.pid}-${dirs.length}-${Date.now()}`);
    dirs.push(dir);
    let fetches = 0;
    const runActivity: ActivityRunner = (args) => {
      if (args[0] === "mr") fetches++;
      return args[0] === "mr" ? { json: mrEnvelope() } : { json: epicEnvelope() };
    };
    const runGraphql = fakeGraphql();
    const base = { runActivity, runGraphql, cacheDir: dir, ttlMs: 600_000 };

    loadVenusBundle({ ...base, now: () => 1_000 });
    expect(fetches).toBe(1);
    loadVenusBundle({ ...base, now: () => 200_000 }); // within TTL → cache hit
    expect(fetches).toBe(1);
    loadVenusBundle({ ...base, now: () => 1_000 + 700_000 }); // past TTL → refetch
    expect(fetches).toBe(2);
  });

  test("a degraded fetch is not cached, so the next run retries within TTL", () => {
    const dir = join(tmpdir(), `rib-osdu-test-${process.pid}-deg-${Date.now()}`);
    dirs.push(dir);
    let mode: "fail" | "ok" = "fail";
    let mrFetches = 0;
    const runActivity: ActivityRunner = (args) => {
      if (args[0] === "mr") {
        mrFetches++;
        return mode === "fail" ? { error: "cli down" } : { json: mrEnvelope() };
      }
      return { json: epicEnvelope() };
    };
    const base = { runActivity, runGraphql: fakeGraphql(), cacheDir: dir, ttlMs: 600_000 };

    const degraded = loadVenusBundle({ ...base, now: () => 1_000 });
    expect(degraded.errors.some((e) => e.includes("mrs degraded"))).toBe(true);
    mode = "ok";
    loadVenusBundle({ ...base, now: () => 2_000 }); // within TTL, but nothing cached → refetch
    expect(mrFetches).toBe(2);
  });
});
