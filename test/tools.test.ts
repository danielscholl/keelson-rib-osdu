import { describe, expect, test } from "bun:test";
import type {
  MessageChunk,
  RibContext,
  RibExec,
  ToolContext,
  ToolDefinition,
} from "@keelson/shared";
import { inferToolFamily } from "@keelson/shared";
import { registerOsduTools } from "../src/tools.ts";
import { makeExec } from "./fetch.test.ts";
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
    for (const verb of ["reconcile", "suspend", "resume"]) {
      const t = byName.get(`osdu_cluster_${verb}`);
      expect(t?.state_changing).toBe(true);
      expect(t?.requires_confirmation).toBe(true);
    }
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
    // fetchReleaseReport degrades to { services: [] }; the tool still emits a result.
    const r = results(emits);
    expect(r).toHaveLength(1);
    expect(JSON.parse(r[0]?.content ?? "{}").report).toEqual({ services: [] });
  });
});

describe("osdu_cluster_reconcile tool", () => {
  function reconcile(exec: ReturnType<typeof makeExec>["exec"]) {
    const t = registerOsduTools(ctxWith(exec)).find((x) => x.name === "osdu_cluster_reconcile");
    if (!t) throw new Error("osdu_cluster_reconcile missing");
    return t;
  }

  test("without confirm: reports the intended command and runs no exec", async () => {
    const { exec, calls } = makeExec({ text: () => ({ ok: true, data: "{}" }) });
    const { tctx, emits } = fakeToolCtx();

    await reconcile(exec).execute({ confirm: false }, tctx);

    const r = results(emits);
    expect(r).toHaveLength(1);
    expect(r[0]?.isError).toBeUndefined();
    expect(r[0]?.content).toContain("Would run");
    expect(r[0]?.content).toContain("cimpl reconcile");
    // Nothing was executed — the confirm gate held.
    expect(calls).toHaveLength(0);
  });

  test("with confirm on a CIMPL context: verifies then runs reconcile", async () => {
    const { exec, calls } = makeExec({ text: () => ({ ok: true, data: "{}" }) });
    const { tctx, emits } = fakeToolCtx();

    await reconcile(exec).execute({ confirm: true }, tctx);

    const r = results(emits);
    expect(r[0]?.isError).toBeUndefined();
    expect(r[0]?.content).toContain("Ran");
    expect(calls.map((c) => c.args.join(" "))).toEqual(["info --json", "reconcile"]);
  });

  test("with confirm on a non-CIMPL context: refuses, runs no mutation", async () => {
    const { exec, calls } = makeExec({
      text: (_cmd, args) =>
        args[0] === "info" ? { ok: false, error: "not cimpl", code: 1 } : { ok: true, data: "{}" },
    });
    const { tctx, emits } = fakeToolCtx();

    await reconcile(exec).execute({ confirm: true }, tctx);

    const r = results(emits);
    expect(r[0]?.isError).toBe(true);
    expect(r[0]?.content).toContain("Refused");
    // Only the identity probe ran; the lifecycle verb did not.
    expect(calls.map((c) => c.args.join(" "))).toEqual(["info --json"]);
  });
});
