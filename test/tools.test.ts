import { describe, expect, test } from "bun:test";
import type {
  MessageChunk,
  RibContext,
  RibExec,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import { inferToolFamily } from "@keelson/shared";
import { fitToCap, registerOsduTools } from "../src/tools.ts";
import { makeExec } from "./fetch.test.ts";
import checkFixture from "./fixtures/cimpl-check.json";
import report from "./fixtures/release-report.json";

type ToolResult = Extract<MessageChunk, { type: "tool_result" }>;
function results(emits: MessageChunk[]): ToolResult[] {
  return emits.filter((c): c is ToolResult => c.type === "tool_result");
}

// Mirror the harness-side validator (apps/server/src/ribs.ts isToolDefinition)
// so the rib's own tests catch any drift from the contract before boot.
function isValidTool(t: ToolDefinition): boolean {
  const schema = t.inputSchema as { safeParse?: unknown } | null | undefined;
  return (
    typeof t.name === "string" &&
    t.name.length > 0 &&
    typeof t.description === "string" &&
    typeof t.execute === "function" &&
    schema != null &&
    typeof schema.safeParse === "function" &&
    (t.state_changing === undefined || typeof t.state_changing === "boolean") &&
    (t.requires_confirmation === undefined || typeof t.requires_confirmation === "boolean")
  );
}

function fakeToolCtx(): { tctx: ToolContext; emits: Parameters<ToolContext["emit"]>[0][] } {
  const emits: Parameters<ToolContext["emit"]>[0][] = [];
  const tctx: ToolContext = {
    cwd: ".",
    emit: (chunk) => emits.push(chunk),
    abortSignal: new AbortController().signal,
  };
  return { tctx, emits };
}

const ctxWith = (exec: RibExec): RibContext => ({ getExec: () => exec });

describe("registerOsduTools", () => {
  test("returns the read + lifecycle tools, all valid and uniquely named", () => {
    const { exec } = makeExec({});
    const tools = registerOsduTools(ctxWith(exec));
    const names = tools.map((t) => t.name);

    expect(names).toEqual([
      "osdu_quality",
      "osdu_security",
      "osdu_features",
      "osdu_release",
      "osdu_events",
      "osdu_waiting",
      "osdu_cluster",
      "osdu_topology",
      "osdu_contexts",
      "osdu_setup_check",
      "osdu_cluster_reconcile",
      "osdu_cluster_suspend",
      "osdu_cluster_resume",
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(isValidTool(t)).toBe(true);
      expect(inferToolFamily(t.name)).toBe("osdu");
    }
  });

  test("read tools are read-only; lifecycle tools are state-changing + confirm-gated", () => {
    const { exec } = makeExec({});
    const byName = new Map(registerOsduTools(ctxWith(exec)).map((t) => [t.name, t]));
    expect(byName.get("osdu_quality")?.state_changing).toBe(false);
    expect(byName.get("osdu_setup_check")?.state_changing).toBe(false);
    for (const verb of ["reconcile", "suspend", "resume"]) {
      const t = byName.get(`osdu_cluster_${verb}`);
      expect(t?.state_changing).toBe(true);
      expect(t?.requires_confirmation).toBe(true);
    }
  });
});

describe("osdu_setup_check tool", () => {
  function setupCheck(exec: RibExec) {
    const tool = registerOsduTools(ctxWith(exec)).find((t) => t.name === "osdu_setup_check");
    if (!tool) throw new Error("osdu_setup_check missing");
    return tool;
  }

  test("fetches the full inventory and emits a single tool_result", async () => {
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: checkFixture }) });
    const { tctx, emits } = fakeToolCtx();

    await setupCheck(exec).execute({}, tctx);

    const r = results(emits);
    expect(r).toHaveLength(1);
    expect(r[0]?.isError).toBeUndefined();
    expect(JSON.parse(r[0]?.content ?? "{}").tools).toHaveLength(checkFixture.tools.length);
    expect(calls[0]).toEqual({ cmd: "cimpl", args: ["check", "--json"] });
  });

  test("scopes the inventory to the requested provider", async () => {
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: checkFixture }) });
    const { tctx } = fakeToolCtx();

    await setupCheck(exec).execute({ provider: "aws" }, tctx);

    expect(calls[0]).toEqual({ cmd: "cimpl", args: ["check", "--json", "--provider", "aws"] });
  });

  test("emits isError rather than throwing when the check fails", async () => {
    const { exec } = makeExec({
      json: () => ({ ok: false, error: "cimpl not found", code: null }),
    });
    const { tctx, emits } = fakeToolCtx();

    await setupCheck(exec).execute({}, tctx);

    const r = results(emits);
    expect(r).toHaveLength(1);
    expect(r[0]?.isError).toBe(true);
    expect(r[0]?.content).toContain("cimpl not found");
  });
});

describe("osdu_quality tool", () => {
  test("fetches the report and emits a single tool_result", async () => {
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: report }) });
    const tool = registerOsduTools(ctxWith(exec)).find((t) => t.name === "osdu_quality");
    if (!tool) throw new Error("osdu_quality missing");
    const { tctx, emits } = fakeToolCtx();

    await tool.execute({}, tctx);

    const r = results(emits);
    expect(r).toHaveLength(1);
    expect(r[0]?.isError).toBeUndefined();
    expect(JSON.parse(r[0]?.content ?? "{}").report.services.length).toBeGreaterThan(0);
    expect(calls[0]?.cmd).toBe("osdu-quality");
  });

  test("emits isError (never throws) when the fetch degrades", async () => {
    // An exec that returns malformed data still degrades cleanly to an empty report.
    const { exec } = makeExec({ json: () => ({ ok: false, error: "down", code: 1 }) });
    const tool = registerOsduTools(ctxWith(exec)).find((t) => t.name === "osdu_quality");
    if (!tool) throw new Error("osdu_quality missing");
    const { tctx, emits } = fakeToolCtx();

    await tool.execute({}, tctx);
    // fetchReleaseReport degrades to { services: [] } but the error surfaces in notes,
    // so an osdu-quality outage is distinguishable from a genuinely empty report.
    const r = results(emits);
    expect(r).toHaveLength(1);
    const parsed = JSON.parse(r[0]?.content ?? "{}");
    expect(parsed.report).toEqual({ services: [] });
    expect(parsed.notes).toEqual(["quality degraded: down"]);
  });

  test("passes --service through to the CLI when scoped", async () => {
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: report }) });
    const tool = registerOsduTools(ctxWith(exec)).find((t) => t.name === "osdu_quality");
    if (!tool) throw new Error("osdu_quality missing");
    const { tctx } = fakeToolCtx();

    await tool.execute({ service: "partition" }, tctx);

    expect(calls[0]?.args).toContain("--service");
    expect(calls[0]?.args).toContain("partition");
  });

  // A stripped unknown key would parse as "no scope" and silently run the
  // full-platform sweep the caller was avoiding, so the schema must refuse it.
  test("refuses a misspelled argument instead of falling back to an unscoped sweep", async () => {
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: report }) });
    const tool = registerOsduTools(ctxWith(exec)).find((t) => t.name === "osdu_quality");
    if (!tool) throw new Error("osdu_quality missing");
    const { tctx, emits } = fakeToolCtx();

    await tool.execute({ servicee: "partition" }, tctx);

    const r = results(emits);
    expect(r).toHaveLength(1);
    expect(r[0]?.isError).toBe(true);
    expect(r[0]?.content).toContain("invalid arguments");
    // The decisive assertion: nothing was fetched.
    expect(calls).toHaveLength(0);
  });

  test("refuses an unknown service without fetching", async () => {
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: report }) });
    const tool = registerOsduTools(ctxWith(exec)).find((t) => t.name === "osdu_quality");
    if (!tool) throw new Error("osdu_quality missing");
    const { tctx, emits } = fakeToolCtx();

    await tool.execute({ service: "partitionn" }, tctx);

    const parsed = JSON.parse(results(emits)[0]?.content ?? "{}");
    expect(parsed.error).toContain("unknown service(s): partitionn");
    expect(parsed.validServices).toContain("partition");
    expect(calls).toHaveLength(0);
  });
});

// A result that overflows must still parse. The reader is a model: a document cut
// at a byte boundary costs it everything, not just the tail — and the note saying
// the data is short is the last field, so slicing destroyed the warning first.
// fitToCap is what stands between a large service and an unparseable result, and
// it can fail silently in both directions: returning 0 hides every row, returning
// too many puts the payload back over the cap.
describe("fitToCap", () => {
  // ~200 chars per row, so ~80 rows exceed the 16,000 cap.
  const row = (i: number) => ({ id: i, pad: "x".repeat(180) });
  const rows = Array.from({ length: 200 }, (_, i) => row(i));
  const build = (kept: readonly { id: number }[]) => ({ kept });
  const size = (n: number) => JSON.stringify(build(rows.slice(0, n))).length;

  test("keeps every row when the result already fits", () => {
    const few = rows.slice(0, 3);
    expect(fitToCap(few, build)).toBe(3);
  });

  test("returns the LARGEST prefix that fits, not zero and not too many", () => {
    const n = fitToCap(rows, build);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(rows.length);
    expect(size(n)).toBeLessThanOrEqual(16_000);
    // One more row must not fit, or it stopped short.
    expect(size(n + 1)).toBeGreaterThan(16_000);
  });

  test("returns 0 only when even an empty result is too big", () => {
    const heavy = (kept: readonly unknown[]) => ({ kept, ballast: "y".repeat(20_000) });
    expect(fitToCap(rows, heavy)).toBe(0);
  });

  test("builds from the head, so worst-first ordering survives the trim", () => {
    const n = fitToCap(rows, build);
    const kept = rows.slice(0, n);
    expect(kept[0]?.id).toBe(0);
    expect(kept.at(-1)?.id).toBe(n - 1);
  });
});

describe("result size bounding", () => {
  function bigReport(services: number) {
    return {
      services: Array.from({ length: services }, (_, i) => ({
        name: `svc-${i}`,
        display_name: `Service ${i}`,
        // Padding so the report cannot fit under the cap.
        pipeline_url: `https://example.com/${"x".repeat(400)}/${i}`,
        vulnerabilities: { critical: 1, high: 2, medium: 3, low: 0, info: 0, unknown: 0 },
      })),
    };
  }

  test("an oversized result is valid JSON carrying an error, not a slice", async () => {
    const { exec } = makeExec({ json: () => ({ ok: true, data: bigReport(200) }) });
    const tool = registerOsduTools(ctxWith(exec)).find((t) => t.name === "osdu_quality");
    if (!tool) throw new Error("osdu_quality missing");
    const { tctx, emits } = fakeToolCtx();

    await tool.execute({}, tctx);

    const content = results(emits)[0]?.content ?? "";
    expect(content.length).toBeLessThanOrEqual(16_000);
    // The decisive assertion: it parses at all.
    const parsed = JSON.parse(content);
    expect(parsed.error).toContain("over the 16000 limit");
    expect(parsed.hint).toContain("narrow");
  });

  test("a result that fits is returned whole", async () => {
    const { exec } = makeExec({ json: () => ({ ok: true, data: bigReport(1) }) });
    const tool = registerOsduTools(ctxWith(exec)).find((t) => t.name === "osdu_quality");
    if (!tool) throw new Error("osdu_quality missing");
    const { tctx, emits } = fakeToolCtx();

    await tool.execute({}, tctx);

    const parsed = JSON.parse(results(emits)[0]?.content ?? "{}");
    expect(parsed.report.services).toHaveLength(1);
    expect(parsed.error).toBeUndefined();
  });
});

describe("osdu_cluster + osdu_topology tools (exec-injected)", () => {
  function tool(name: string, exec: RibExec) {
    const t = registerOsduTools(ctxWith(exec)).find((x) => x.name === name);
    if (!t) throw new Error(`${name} missing`);
    return t;
  }

  test("osdu_cluster surfaces every degraded source in notes (not a false all-clear)", async () => {
    // kubectl context ok, but cimpl info + both readiness reads fail.
    const { exec } = makeExec({
      text: (cmd) =>
        cmd === "kubectl"
          ? { ok: true, data: "kind-cimpl-test\n" }
          : { ok: false, error: "cimpl down", code: 1 },
      json: () => ({ ok: false, error: "no cluster", code: 1 }),
    });
    const { tctx, emits } = fakeToolCtx();
    await tool("osdu_cluster", exec).execute({}, tctx);
    const out = JSON.parse(results(emits)[0]?.content ?? "{}");
    expect(out.context).toBe("kind-cimpl-test");
    expect(out.notes).toEqual(["info: cimpl down", "flux: no cluster", "services: no cluster"]);
  });

  test("osdu_topology returns kustomizations with the active context", async () => {
    const { exec } = makeExec({
      text: () => ({ ok: true, data: "kind-cimpl-test\n" }),
      json: () => ({ ok: true, data: { items: [{ metadata: { name: "infra" } }] } }),
    });
    const { tctx, emits } = fakeToolCtx();
    await tool("osdu_topology", exec).execute({}, tctx);
    const out = JSON.parse(results(emits)[0]?.content ?? "{}");
    expect(out.context).toBe("kind-cimpl-test");
    expect(out.kustomizations).toHaveLength(1);
    expect(out.notes).toEqual([]);
  });

  test("osdu_contexts returns the current context + cimpl-managed contexts, filtering others", async () => {
    const { exec } = makeExec({
      text: (_cmd, args) => {
        const command = args.join(" ");
        if (command === "config current-context") return { ok: true, data: "cimpl-a\n" };
        if (command === "config get-contexts -o name")
          return { ok: true, data: "cimpl-a\ncimpl-b\nprod-cluster\n" };
        return { ok: false, error: "unexpected", code: 1 };
      },
    });
    const { tctx, emits } = fakeToolCtx();
    await tool("osdu_contexts", exec).execute({}, tctx);
    const out = JSON.parse(results(emits)[0]?.content ?? "{}");
    expect(out.current).toBe("cimpl-a");
    expect(out.contexts).toEqual(["cimpl-a", "cimpl-b"]);
  });

  test("osdu_contexts degrades to null/[] when kubectl is unavailable (no throw)", async () => {
    const { exec } = makeExec({
      text: () => ({ ok: false, error: "kubectl missing", code: null }),
    });
    const { tctx, emits } = fakeToolCtx();
    await tool("osdu_contexts", exec).execute({}, tctx);
    const r = results(emits);
    expect(r).toHaveLength(1);
    expect(r[0]?.isError).toBeUndefined();
    const out = JSON.parse(r[0]?.content ?? "{}");
    expect(out.current).toBeNull();
    expect(out.contexts).toEqual([]);
  });
});

describe("osdu_cluster_reconcile tool", () => {
  function reconcile(exec: ReturnType<typeof makeExec>["exec"]) {
    const t = registerOsduTools(ctxWith(exec)).find((x) => x.name === "osdu_cluster_reconcile");
    if (!t) throw new Error("osdu_cluster_reconcile missing");
    return t;
  }

  // The fake routes the async context read (kubectl) and the cimpl calls; tests
  // assert on the cimpl calls specifically. `cimpl` returns the given result.
  const execFor = (cimpl: (args: string[]) => unknown) =>
    makeExec({
      text: (cmd, args) =>
        cmd === "kubectl" ? { ok: true, data: "kind-cimpl-test\n" } : cimpl(args),
    });
  const cimplCalls = (calls: { cmd: string; args: string[] }[]) =>
    calls.filter((c) => c.cmd === "cimpl").map((c) => c.args.join(" "));

  test("without confirm: reports the intended command and runs no cimpl", async () => {
    const { exec, calls } = execFor(() => ({ ok: true, data: "{}" }));
    const { tctx, emits } = fakeToolCtx();

    await reconcile(exec).execute({ confirm: false }, tctx);

    const r = results(emits);
    expect(r).toHaveLength(1);
    expect(r[0]?.isError).toBeUndefined();
    expect(r[0]?.content).toContain("Would run");
    expect(r[0]?.content).toContain("cimpl reconcile");
    expect(r[0]?.content).toContain("kind-cimpl-test"); // resolved via the injected exec
    // Nothing was mutated — the confirm gate held (the kubectl context read is not a cimpl call).
    expect(cimplCalls(calls)).toEqual([]);
  });

  test("with confirm on a CIMPL context: verifies then runs reconcile", async () => {
    const { exec, calls } = execFor(() => ({ ok: true, data: "{}" }));
    const { tctx, emits } = fakeToolCtx();

    await reconcile(exec).execute({ confirm: true }, tctx);

    const r = results(emits);
    expect(r[0]?.isError).toBeUndefined();
    expect(r[0]?.content).toContain("Ran");
    expect(cimplCalls(calls)).toEqual(["info --json", "reconcile"]);
  });

  test("with confirm on a non-CIMPL context: refuses, runs no mutation", async () => {
    const { exec, calls } = execFor((args) =>
      args[0] === "info" ? { ok: false, error: "not cimpl", code: 1 } : { ok: true, data: "{}" },
    );
    const { tctx, emits } = fakeToolCtx();

    await reconcile(exec).execute({ confirm: true }, tctx);

    const r = results(emits);
    expect(r[0]?.isError).toBe(true);
    expect(r[0]?.content).toContain("Refused");
    // The context name in the refusal came through the injected exec ("kind-cimpl-test"),
    // not a real kubectl spawn — so the refuse path is hermetic and never blocks on an
    // unreachable cluster (this read used to hang the test to its 5s timeout in CI).
    expect(r[0]?.content).toContain("kind-cimpl-test");
    // Only the identity probe ran; the lifecycle verb did not.
    expect(cimplCalls(calls)).toEqual(["info --json"]);
  });
});
