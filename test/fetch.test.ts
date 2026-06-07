import { describe, expect, test } from "bun:test";
import type { RibExec } from "@keelson/shared";
import { fetchClusterInfo } from "../src/cluster.ts";
import { getKustomizations } from "../src/kubectl.ts";
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
export function makeExec(opts: ExecOpts): { exec: RibExec; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const exec = {
    async runJSON(cmd: string, args: string[]) {
      calls.push({ cmd, args });
      return opts.json ? opts.json(cmd, args) : { ok: false, error: "no json handler", code: null };
    },
    async runText(cmd: string, args: string[]) {
      calls.push({ cmd, args });
      return opts.text ? opts.text(cmd, args) : { ok: false, error: "no text handler", code: null };
    },
  } as unknown as RibExec;
  return { exec, calls };
}

describe("fetchReleaseReport", () => {
  test("runs the osdu-quality release CLI and returns the parsed report", async () => {
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: report }) });
    const { report: r, error } = await fetchReleaseReport(exec);
    expect((r.services ?? []).length).toBeGreaterThan(0);
    expect(error).toBeUndefined();
    expect(calls[0]).toEqual({ cmd: "osdu-quality", args: ["release", "--output", "json"] });
  });

  test("degrades to an empty report WITH an error when the CLI fails", async () => {
    const { exec } = makeExec({ json: () => ({ ok: false, error: "boom", code: 1 }) });
    // The error channel distinguishes a real failure from a genuinely empty report.
    expect(await fetchReleaseReport(exec)).toEqual({ report: { services: [] }, error: "boom" });
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
    const { info } = await fetchClusterInfo(exec);
    // Real-secret cred kept (no password field); "n/a" placeholder dropped.
    expect(info?.credentials).toEqual([{ service: "Airflow", username: "admin" }]);
    expect(JSON.stringify(info)).not.toContain("s3cret-value");
  });

  test("degrades to an error when cimpl fails", async () => {
    const { exec } = makeExec({ text: () => ({ ok: false, error: "cimpl missing", code: null }) });
    const { info, error } = await fetchClusterInfo(exec);
    expect(info).toBeUndefined();
    expect(error).toBe("cimpl missing");
  });
});
