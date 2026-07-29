import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RibExec } from "@keelson/shared";
import { fetchClusterInfo } from "../src/cluster.ts";
import { getKustomizations, getReadiness } from "../src/kubectl.ts";
import { fetchReleaseReport } from "../src/quality.ts";
import report from "./fixtures/release-report.json";

interface FakeCall {
  cmd: string;
  args: string[];
}

type ExecOpts = {
  json?: (cmd: string, args: string[]) => unknown;
  text?: (cmd: string, args: string[]) => unknown;
};

// A RibExec whose runJSON/runText return canned results and record their calls,
// so a fetch's command + degrade paths are testable without a live CLI.
export function makeExec(opts: ExecOpts): {
  exec: RibExec;
  calls: FakeCall[];
  jsonOptions: unknown[];
} {
  const calls: FakeCall[] = [];
  const jsonOptions: unknown[] = [];
  const exec = {
    async runJSON(cmd: string, args: string[], options?: unknown) {
      calls.push({ cmd, args });
      jsonOptions.push(options);
      return opts.json ? opts.json(cmd, args) : { ok: false, error: "no json handler", code: null };
    },
    async runText(cmd: string, args: string[]) {
      calls.push({ cmd, args });
      return opts.text ? opts.text(cmd, args) : { ok: false, error: "no text handler", code: null };
    },
  } as unknown as RibExec;
  return { exec, calls, jsonOptions };
}

describe("fetchReleaseReport", () => {
  test("runs the osdu-quality release CLI and returns the parsed report", async () => {
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: report }) });
    const { report: r, error } = await fetchReleaseReport(exec, [], { cacheDir: null });
    expect((r.services ?? []).length).toBeGreaterThan(0);
    expect(error).toBeUndefined();
    expect(calls[0]).toEqual({ cmd: "osdu-quality", args: ["release", "--output", "json"] });
  });

  test("degrades to an empty report WITH an error when the CLI fails", async () => {
    const { exec } = makeExec({ json: () => ({ ok: false, error: "boom", code: 1 }) });
    // The error channel distinguishes a real failure from a genuinely empty report.
    expect(await fetchReleaseReport(exec, [], { cacheDir: null })).toEqual({
      report: { services: [] },
      error: "boom",
    });
  });
});

describe("fetchReleaseReport cache", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempDir = (tag: string): string => {
    const dir = join(tmpdir(), `rib-osdu-report-${process.pid}-${tag}-${Date.now()}`);
    dirs.push(dir);
    return dir;
  };

  test("serves a hit within TTL and refetches after expiry", async () => {
    const dir = tempDir("ttl");
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: report }) });
    const base = { cacheDir: dir, ttlMs: 600_000 };

    await fetchReleaseReport(exec, [], { ...base, now: () => 1_000 });
    await fetchReleaseReport(exec, [], { ...base, now: () => 200_000 }); // within TTL → cache hit
    expect(calls).toHaveLength(1);
    await fetchReleaseReport(exec, [], { ...base, now: () => 1_000 + 700_000 }); // past TTL → refetch
    expect(calls).toHaveLength(2);
  });

  test("a degraded fetch is not cached, so the next run retries within TTL", async () => {
    const dir = tempDir("deg");
    let mode: "fail" | "ok" = "fail";
    const { exec, calls } = makeExec({
      json: () =>
        mode === "fail" ? { ok: false, error: "down", code: 1 } : { ok: true, data: report },
    });
    const base = { cacheDir: dir, ttlMs: 600_000 };

    const degraded = await fetchReleaseReport(exec, [], { ...base, now: () => 1_000 });
    expect(degraded.error).toBe("down");
    mode = "ok";
    const { report: r } = await fetchReleaseReport(exec, [], { ...base, now: () => 2_000 });
    expect(calls).toHaveLength(2);
    expect((r.services ?? []).length).toBeGreaterThan(0);
  });

  test("a scoped report bypasses the cache without poisoning the unscoped entry", async () => {
    const dir = tempDir("scope");
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: report }) });
    const base = { cacheDir: dir, ttlMs: 600_000, now: () => 1_000 };

    await fetchReleaseReport(exec, [], base); // warms the unscoped cache
    await fetchReleaseReport(exec, ["partition"], base); // scoped → always fetches
    expect(calls).toHaveLength(2);
    await fetchReleaseReport(exec, [], base); // unscoped entry still served
    expect(calls).toHaveLength(2);
  });

  // A broken cache backend must degrade to direct fetches, not read as lock
  // contention (which would stall every call for the full lock-wait window).
  test("an unusable cache dir degrades to direct fetches instead of stalling", async () => {
    const blocker = join(tmpdir(), `rib-osdu-report-notadir-${process.pid}-${Date.now()}`);
    dirs.push(blocker);
    writeFileSync(blocker, "a file where the cache dir should be");
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: report }) });
    const base = { cacheDir: join(blocker, "cache"), ttlMs: 600_000, now: () => 1_000 };

    await fetchReleaseReport(exec, [], base);
    await fetchReleaseReport(exec, [], base);
    expect(calls).toHaveLength(2);
  });

  test("a TTL of 0 disables the cache entirely", async () => {
    const dir = tempDir("off");
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: report }) });
    const base = { cacheDir: dir, ttlMs: 0, now: () => 1_000 };

    await fetchReleaseReport(exec, [], base);
    await fetchReleaseReport(exec, [], base);
    expect(calls).toHaveLength(2);
  });

  // The single-flight guarantee: Quality and Security fire together when a stale
  // surface opens, and the pair must cost ONE sweep, not two.
  test("concurrent unscoped fetches collapse to one CLI run", async () => {
    const dir = tempDir("flight");
    let fetches = 0;
    const slowExec = {
      async runJSON() {
        fetches++;
        await new Promise((r) => setTimeout(r, 100));
        return { ok: true, data: report };
      },
    } as unknown as RibExec;
    const base = { cacheDir: dir, ttlMs: 600_000, lockPollMs: 10 };

    const [a, b] = await Promise.all([
      fetchReleaseReport(slowExec, [], base),
      fetchReleaseReport(slowExec, [], base),
    ]);
    expect(fetches).toBe(1);
    expect(a.report).toEqual(b.report);
    expect((a.report.services ?? []).length).toBeGreaterThan(0);
  });

  test("a waiter takes over when the lock holder fails without caching", async () => {
    const dir = tempDir("takeover");
    let fetches = 0;
    const flakyExec = {
      async runJSON() {
        fetches++;
        const failed = fetches === 1;
        await new Promise((r) => setTimeout(r, 50));
        return failed ? { ok: false, error: "down", code: 1 } : { ok: true, data: report };
      },
    } as unknown as RibExec;
    const base = { cacheDir: dir, ttlMs: 600_000, lockPollMs: 10 };

    const results = await Promise.all([
      fetchReleaseReport(flakyExec, [], base),
      fetchReleaseReport(flakyExec, [], base),
    ]);
    expect(fetches).toBe(2);
    expect(results.filter((r) => r.error).length).toBe(1);
    expect(results.filter((r) => (r.report.services ?? []).length > 0).length).toBe(1);
  });
});

describe("getKustomizations", () => {
  test("returns the parsed items with the active context", async () => {
    const { exec, calls } = makeExec({
      text: () => ({ ok: true, data: "kind-cimpl-test\n" }),
      json: () => ({ ok: true, data: { items: [{ metadata: { name: "infra" } }] } }),
    });
    const r = await getKustomizations(undefined, exec);
    expect(r.kustomizations).toHaveLength(1);
    expect(r.error).toBeUndefined();
    expect(r.context).toBe("kind-cimpl-test");
    expect(calls.some((c) => c.args.includes("kustomizations"))).toBe(true);
  });

  test("degrades to an empty list with an error on failure", async () => {
    const { exec } = makeExec({ json: () => ({ ok: false, error: "no cluster", code: 1 }) });
    const r = await getKustomizations(undefined, exec);
    expect(r.kustomizations).toEqual([]);
    expect(r.error).toBe("no cluster");
  });
});

describe("getReadiness", () => {
  const item = (conditions: { type: string; status: string }[], suspend = false) => ({
    ...(suspend ? { spec: { suspend: true } } : {}),
    status: { conditions },
  });

  test("splits not-ready items into reconciling vs stalled by the kstatus condition", async () => {
    const items = [
      item([{ type: "Ready", status: "True" }]),
      // Converging: not ready, not stalled — just reconciling.
      item([{ type: "Ready", status: "False" }]),
      // Stuck: retries exhausted / bad source.
      item([
        { type: "Ready", status: "False" },
        { type: "Stalled", status: "True" },
      ]),
      // Suspended never converges on its own — counts as stalled.
      item([{ type: "Ready", status: "True" }], true),
    ];
    const { exec } = makeExec({ json: () => ({ ok: true, data: { items } }) });
    expect(await getReadiness("kustomizations", ["-A"], exec)).toEqual({
      ready: 1,
      total: 4,
      stalled: 2,
    });
  });

  test("degrades to zero counts WITH an error when the read fails", async () => {
    const { exec } = makeExec({ json: () => ({ ok: false, error: "no cluster", code: 1 }) });
    expect(await getReadiness("helmreleases", ["-A"], exec)).toEqual({
      ready: 0,
      total: 0,
      stalled: 0,
      error: "no cluster",
    });
  });
});

describe("fetchClusterInfo", () => {
  test("strips credential passwords before returning", async () => {
    const cimplJson = JSON.stringify({
      endpoints: [{ name: "Airflow", url: "http://airflow" }],
      credentials: [
        { service: "Airflow", username: "admin", password: "s3cret-value" },
        { service: "Placeholder", password: "n/a" },
      ],
      suspended: false,
    });
    const { exec } = makeExec({ text: () => ({ ok: true, data: cimplJson }) });
    const { info, deployment } = await fetchClusterInfo(exec);
    // Real-secret cred kept (no password field); "n/a" placeholder dropped.
    expect(info?.credentials).toEqual([{ service: "Airflow", username: "admin" }]);
    expect(JSON.stringify(info)).not.toContain("s3cret-value");
    expect(deployment).toBe("live");
  });

  test("a probe that never completed degrades to an indeterminate deployment", async () => {
    const { exec } = makeExec({ text: () => ({ ok: false, error: "cimpl missing", code: null }) });
    const { info, error, deployment } = await fetchClusterInfo(exec);
    expect(info).toBeUndefined();
    expect(error).toBe("cimpl missing");
    // Timeout / cimpl not on PATH is no verdict — must not read as absence.
    expect(deployment).toBe("unknown");
  });

  test("a completed non-zero exit is cimpl's own verdict of absence", async () => {
    const { exec } = makeExec({ text: () => ({ ok: false, error: "exit 1", code: 1 }) });
    const { deployment } = await fetchClusterInfo(exec);
    expect(deployment).toBe("absent");
  });

  test("unparseable cimpl output degrades to an indeterminate deployment", async () => {
    const { exec } = makeExec({ text: () => ({ ok: true, data: "not json at all" }) });
    const { info, deployment } = await fetchClusterInfo(exec);
    expect(info).toBeUndefined();
    expect(deployment).toBe("unknown");
  });
});
