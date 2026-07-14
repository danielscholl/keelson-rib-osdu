import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasBoardView, RibContext, RibExec } from "@keelson/shared";
import { buildClusterBoard } from "../src/cluster.ts";
import { CLUSTER_LIFECYCLE_ARGS } from "../src/cluster-actions.ts";
import { CLUSTER_CREATE_BASH } from "../src/cluster-create.ts";
import { readCreateMarker, writeCreateMarker } from "../src/create-marker.ts";
import rib from "../src/index.ts";
import { getCimplPrefixes, isCimplManagedContext, listContexts } from "../src/kubectl.ts";

type BoardAction = Extract<
  CanvasBoardView["sections"][number],
  { kind: "actions" }
>["items"][number];
type Action = Parameters<NonNullable<typeof rib.onAction>>[0];
interface FakeCall {
  cmd: string;
  args: string[];
}

type ExecOpts = {
  json?: (cmd: string, args: string[]) => unknown;
  text?: (cmd: string, args: string[]) => unknown;
};

let liveContext: string | null = null;
let liveFingerprint: string | null = null;

function setLiveKube(context: string | null, fingerprint: string | null = null) {
  liveContext = context;
  liveFingerprint = fingerprint;
}

beforeEach(() => {
  setLiveKube(null);
});

function makeExec(opts: ExecOpts): { exec: RibExec; calls: FakeCall[] } {
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

function kubectlText(args: string[], contexts: string[] = []): unknown {
  const command = args.join(" ");
  if (command === "config current-context") {
    return liveContext
      ? { ok: true, data: `${liveContext}\n` }
      : { ok: false, error: "no current context", code: 1 };
  }
  if (command === "get namespace kube-system -o jsonpath={.metadata.uid}") {
    return liveFingerprint
      ? { ok: true, data: liveFingerprint }
      : { ok: false, error: "no fingerprint", code: 1 };
  }
  if (command === "config get-contexts -o name") {
    return { ok: true, data: contexts.length > 0 ? `${contexts.join("\n")}\n` : "" };
  }
  if (command.startsWith("config use-context ")) {
    return { ok: true, data: "" };
  }
  return { ok: false, error: `unexpected kubectl ${command}`, code: 1 };
}

function ctxWith(exec: RibExec, boards: CanvasBoardView[] = []): RibContext {
  let producer: (() => CanvasBoardView) | undefined;
  const manager = {
    register(_key: string, next: () => CanvasBoardView) {
      producer = next;
      return () => {
        producer = undefined;
      };
    },
    async recompose(key: string) {
      if (!producer) return null;
      boards.push(producer());
      return { key };
    },
  } as unknown as ReturnType<NonNullable<RibContext["getSnapshotManager"]>>;

  return {
    getExec: () => exec,
    getSnapshotManager: () => manager,
    refreshWorkflow: async () => {},
  } as RibContext;
}

async function dispatch(action: Action, exec: RibExec, boards?: CanvasBoardView[]) {
  if (!rib.onAction) throw new Error("rib.onAction missing");
  return rib.onAction(action, ctxWith(exec, boards));
}

function commandCalls(calls: ReturnType<typeof makeExec>["calls"], cmd: string): string[] {
  return calls.filter((call) => call.cmd === cmd).map((call) => call.args.join(" "));
}

function actionsOf(board: CanvasBoardView): BoardAction[] {
  const actions: BoardAction[] = [];
  for (const section of board.sections) {
    if (section.kind === "actions") {
      actions.push(...section.items);
      continue;
    }
    if (section.kind !== "columns") continue;
    for (const column of section.columns) {
      for (const nested of column.sections) {
        if (nested.kind === "actions") actions.push(...nested.items);
      }
    }
  }
  return actions;
}

function actionOf(board: CanvasBoardView, type: string): BoardAction {
  const action = actionsOf(board).find((item) => item.type === type);
  if (!action) throw new Error(`expected ${type} action`);
  return action;
}

function fieldNames(action: BoardAction): string[] {
  return (action.fields ?? []).map((field) => field.name);
}

function payloadKeys(action: BoardAction): string[] {
  const payload = "payload" in action ? action.payload : undefined;
  return payload && typeof payload === "object" ? Object.keys(payload) : [];
}

function expectFieldPayloadDisjoint(action: BoardAction) {
  const payload = new Set(payloadKeys(action));
  expect(fieldNames(action).filter((name) => payload.has(name))).toEqual([]);
}

describe("cluster lifecycle onAction guards", () => {
  test("switch-context refuses a non-cimpl target before any kubectl call", async () => {
    setLiveKube("cimpl-a", "uid-1");
    const { exec, calls } = makeExec({
      text: (cmd, args) =>
        cmd === "kubectl"
          ? kubectlText(args, ["cimpl-a"])
          : { ok: true, data: "unexpected mutation" },
    });

    const result = await dispatch(
      {
        type: "switch-context",
        payload: {
          target: "prod-cluster",
          observedCurrent: "cimpl-a",
          observedContexts: ["cimpl-a"],
        },
      },
      exec,
    );

    if (result.ok) throw new Error("expected non-cimpl target refusal");
    expect(result.error).toBe(
      "context 'prod-cluster' is not a cimpl-managed context — refusing to switch",
    );
    expect(commandCalls(calls, "kubectl")).toEqual([]);
  });

  test("switch-context rejects a vanished target before running use-context", async () => {
    setLiveKube("cimpl-a", "uid-1");
    const { exec, calls } = makeExec({
      text: (cmd, args) =>
        cmd === "kubectl"
          ? kubectlText(args, ["cimpl-a"])
          : { ok: true, data: "unexpected mutation" },
    });

    const result = await dispatch(
      {
        type: "switch-context",
        payload: { target: "cimpl-b", observedCurrent: "cimpl-a", observedContexts: ["cimpl-a"] },
      },
      exec,
    );

    if (result.ok) throw new Error("expected vanished target refusal");
    expect(result.error).toBe("context 'cimpl-b' is no longer available — refresh and retry");
    expect(commandCalls(calls, "kubectl")).toEqual(["config get-contexts -o name"]);
  });

  test("switch-context rejects stale observedCurrent before running use-context", async () => {
    setLiveKube("cimpl-b", "uid-2");
    const { exec, calls } = makeExec({
      text: (cmd, args) =>
        cmd === "kubectl"
          ? kubectlText(args, ["cimpl-a", "cimpl-b"])
          : { ok: true, data: "unexpected mutation" },
    });

    const result = await dispatch(
      {
        type: "switch-context",
        payload: {
          target: "cimpl-b",
          observedCurrent: "cimpl-a",
          observedContexts: ["cimpl-a", "cimpl-b"],
        },
      },
      exec,
    );

    if (result.ok) throw new Error("expected stale observedCurrent refusal");
    expect(result.error).toBe(
      "current context changed since this view loaded (was cimpl-a, now cimpl-b) — refresh and retry",
    );
    expect(commandCalls(calls, "kubectl")).toEqual([
      "config get-contexts -o name",
      "config current-context",
    ]);
  });

  test("switch-context runs kubectl config use-context for an allowed cimpl target", async () => {
    setLiveKube("cimpl-a", "uid-1");
    const { exec, calls } = makeExec({
      text: (cmd, args) =>
        cmd === "kubectl"
          ? kubectlText(args, ["cimpl-a", "cimpl-b"])
          : { ok: false, error: "unexpected cimpl", code: 1 },
    });

    const result = await dispatch(
      {
        type: "switch-context",
        payload: {
          target: "cimpl-b",
          observedCurrent: "cimpl-a",
          observedContexts: ["cimpl-a", "cimpl-b"],
          fingerprint: "uid-1",
        },
      },
      exec,
    );

    if (!result.ok) throw new Error(`expected switch success: ${result.error}`);
    expect(commandCalls(calls, "kubectl")).toContain("config use-context cimpl-b");
  });

  test("switch-context rejects a recreated current cluster (stale fingerprint)", async () => {
    setLiveKube("cimpl-a", "uid-2");
    const { exec, calls } = makeExec({
      text: (cmd, args) =>
        cmd === "kubectl"
          ? kubectlText(args, ["cimpl-a", "cimpl-b"])
          : { ok: true, data: "unexpected mutation" },
    });

    const result = await dispatch(
      {
        type: "switch-context",
        payload: {
          target: "cimpl-b",
          observedCurrent: "cimpl-a",
          observedContexts: ["cimpl-a", "cimpl-b"],
          fingerprint: "uid-1",
        },
      },
      exec,
    );

    if (result.ok) throw new Error("expected stale fingerprint refusal");
    expect(result.error).toMatch(/recreated/);
    expect(commandCalls(calls, "kubectl")).not.toContain("config use-context cimpl-b");
  });

  test("delete refuses when the CIMPL probe is indeterminate (fail-safe)", async () => {
    setLiveKube("cimpl-a", "uid-1");
    const { exec, calls } = makeExec({
      text: (cmd, args) => {
        if (cmd === "kubectl") return kubectlText(args);
        const command = args.join(" ");
        if (command === "info --json") {
          return { ok: false, error: "timed out after 60000ms", code: null };
        }
        return { ok: true, data: "torn down" };
      },
    });

    const result = await dispatch(
      { type: "delete", payload: { context: "cimpl-a", fingerprint: "uid-1" } },
      exec,
    );

    if (result.ok) throw new Error("expected delete refusal on an indeterminate probe");
    expect(result.error).toMatch(/could not confirm/);
    // Refused before `cimpl down` — the probe ran, the teardown never did.
    expect(commandCalls(calls, "cimpl")).toEqual(["info --json"]);
  });
});

describe("cluster delete onAction (run-workflow effect)", () => {
  test("fires the workflow on a matching identity and live CIMPL probe", async () => {
    setLiveKube("cimpl-a", "uid-1");
    const { exec, calls } = makeExec({
      text: (cmd, args) => {
        if (cmd === "kubectl") return kubectlText(args);
        if (cmd === "cimpl" && args.join(" ") === "info --json") return { ok: true, data: "{}" };
        return { ok: false, error: "unexpected command", code: 1 };
      },
    });

    const result = await dispatch(
      { type: "delete", payload: { context: "cimpl-a", fingerprint: "uid-1" } },
      exec,
    );

    if (!result.ok) throw new Error(`expected delete workflow effect: ${result.error}`);
    expect(result.data).toEqual({
      effect: "run-workflow",
      workflow: "osdu-cluster-delete",
      args: { context: "cimpl-a", fingerprint: "uid-1" },
    });
    expect(commandCalls(calls, "cimpl")).toEqual(["info --json"]);
  });

  test("refuses a stale fingerprint before probing or firing the workflow", async () => {
    setLiveKube("cimpl-a", "uid-2");
    const { exec, calls } = makeExec({
      text: (cmd, args) => {
        if (cmd === "kubectl") return kubectlText(args);
        return { ok: true, data: "{}" };
      },
    });

    const result = await dispatch(
      { type: "delete", payload: { context: "cimpl-a", fingerprint: "uid-1" } },
      exec,
    );

    if (result.ok) throw new Error("expected stale-fingerprint delete refusal");
    expect(result.error).toMatch(/recreated/);
    expect(commandCalls(calls, "cimpl")).toEqual([]);
  });
});

describe("cluster create onAction (#61 run-workflow effect)", () => {
  // Preflight probe = `cimpl info --json`; ABSENT (completed non-zero) means no
  // live deployment, so create may fire the workflow.
  const ABSENT = { ok: false, error: "no cimpl deployment", code: 1 };
  const cimplInfoExec = (info: unknown) =>
    makeExec({
      text: (cmd, args) =>
        cmd === "cimpl" && args.join(" ") === "info --json"
          ? info
          : { ok: false, error: "unexpected", code: 1 },
    });

  test("fires the workflow on a confirmed-absent probe and bypasses the identity guard", async () => {
    // No current context — the context-identity guard would refuse; create must not use it.
    setLiveKube(null);
    const { exec, calls } = cimplInfoExec(ABSENT);

    const result = await dispatch({ type: "create", payload: { provider: "kind" } }, exec);

    if (!result.ok) throw new Error(`expected create success: ${JSON.stringify(result)}`);
    expect(result.data).toEqual({
      effect: "run-workflow",
      workflow: "osdu-cluster-create",
      args: { provider: "kind" },
    });
    // Only the preflight probe ran — no identity-guard kubectl reads.
    expect(commandCalls(calls, "cimpl")).toEqual(["info --json"]);
    expect(commandCalls(calls, "kubectl")).toEqual([]);
  });

  test("refuses over a live CIMPL deployment and does not fire the workflow", async () => {
    const { exec } = cimplInfoExec({ ok: true, data: "{}" });
    const result = await dispatch({ type: "create", payload: { provider: "kind" } }, exec);
    if (result.ok) throw new Error("expected create refusal over a live CIMPL deployment");
    expect(result.error).toMatch(/CIMPL deployment is already active/);
  });

  test("refuses when the CIMPL probe is indeterminate (fail-safe)", async () => {
    const { exec } = cimplInfoExec({ ok: false, error: "timed out after 60000ms", code: null });
    const result = await dispatch({ type: "create", payload: { provider: "kind" } }, exec);
    if (result.ok) throw new Error("expected create refusal on an indeterminate probe");
    expect(result.error).toMatch(/could not confirm/);
  });

  test("maps the form fields to workflow args (azure + profile/env + private)", async () => {
    const { exec } = cimplInfoExec(ABSENT);
    const result = await dispatch(
      {
        type: "create",
        payload: {
          provider: "azure",
          profile: "graduated",
          env: "dev",
          partition: "opendes",
          instance: "primary",
          location: "eastus",
          private: "private",
        },
      },
      exec,
    );

    if (!result.ok) throw new Error("expected create success");
    expect((result.data as { args: Record<string, string> }).args).toEqual({
      provider: "azure",
      profile: "graduated",
      env: "dev",
      partition: "opendes",
      instance: "primary",
      location: "eastus",
      private: "1",
    });
  });

  test("drops azure-only fields for a kind provider", async () => {
    const { exec } = cimplInfoExec(ABSENT);
    const result = await dispatch(
      { type: "create", payload: { provider: "kind", location: "eastus", private: "private" } },
      exec,
    );
    if (!result.ok) throw new Error("expected create success");
    expect((result.data as { args: Record<string, string> }).args).toEqual({ provider: "kind" });
  });

  test("rejects an invalid provider before probing", async () => {
    const { exec, calls } = cimplInfoExec(ABSENT);
    const result = await dispatch({ type: "create", payload: { provider: "gcp" } }, exec);
    if (result.ok) throw new Error("expected invalid-provider refusal");
    expect(result.error).toMatch(/provider must be one of/);
    // Validation short-circuits before the preflight probe.
    expect(calls).toEqual([]);
  });

  // With a data dir on the ctx, a create leaves a dispatch marker behind (the
  // provisioning-board signal) and an in-flight marker refuses a double-create.
  function ctxWithDataDir(exec: RibExec, dataDir: string, refreshed: string[]): RibContext {
    return {
      getExec: () => exec,
      getDataDir: () => dataDir,
      refreshWorkflow: async (name: string) => {
        refreshed.push(name);
      },
    } as RibContext;
  }

  function scratchDataDir(): string {
    return join(mkdtempSync(join(tmpdir(), "rib-osdu-create-")), "rib-osdu");
  }

  test("create writes a dispatched marker and nudges the cluster board", async () => {
    const dir = scratchDataDir();
    const refreshed: string[] = [];
    const { exec } = cimplInfoExec(ABSENT);
    if (!rib.onAction) throw new Error("rib.onAction missing");

    const result = await rib.onAction(
      { type: "create", payload: { provider: "kind", env: "lab" } },
      ctxWithDataDir(exec, dir, refreshed),
    );

    if (!result.ok) throw new Error(`expected create success: ${JSON.stringify(result)}`);
    const marker = readCreateMarker(dir);
    expect(marker).toMatchObject({
      status: "dispatched",
      provider: "kind",
      env: "lab",
      cluster: "cimpl-stack-lab",
      command: "cimpl up --provider kind --env lab",
    });
    expect(Number.isFinite(Date.parse(marker?.startedAt ?? ""))).toBe(true);
    expect(refreshed).toEqual(["osdu-cluster"]);
  });

  test("a second create is refused while a dispatch is in flight — before any probe", async () => {
    const dir = scratchDataDir();
    writeCreateMarker(dir, {
      status: "dispatched",
      provider: "kind",
      cluster: "cimpl-stack",
      command: "cimpl up --provider kind",
      startedAt: new Date().toISOString(),
    });
    const { exec, calls } = cimplInfoExec(ABSENT);
    if (!rib.onAction) throw new Error("rib.onAction missing");

    const result = await rib.onAction(
      { type: "create", payload: { provider: "kind" } },
      ctxWithDataDir(exec, dir, []),
    );

    if (result.ok) throw new Error("expected in-flight refusal");
    expect(result.error).toMatch(/already in flight/);
    expect(result.error).toMatch(/osdu-cluster-create/);
    expect(calls).toEqual([]);
  });

  test("a stale dispatch does not block a new create — the marker is replaced", async () => {
    const dir = scratchDataDir();
    writeCreateMarker(dir, {
      status: "dispatched",
      provider: "kind",
      cluster: "cimpl-stack",
      command: "cimpl up --provider kind",
      startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    const { exec } = cimplInfoExec(ABSENT);
    if (!rib.onAction) throw new Error("rib.onAction missing");

    const result = await rib.onAction(
      { type: "create", payload: { provider: "azure" } },
      ctxWithDataDir(exec, dir, []),
    );

    if (!result.ok) throw new Error("expected create success over a stale marker");
    expect(readCreateMarker(dir)).toMatchObject({ status: "dispatched", provider: "azure" });
  });

  test("a refused create leaves no marker behind", async () => {
    const dir = scratchDataDir();
    const { exec } = cimplInfoExec({ ok: true, data: "{}" });
    if (!rib.onAction) throw new Error("rib.onAction missing");

    const result = await rib.onAction(
      { type: "create", payload: { provider: "kind" } },
      ctxWithDataDir(exec, dir, []),
    );

    if (result.ok) throw new Error("expected create refusal over a live CIMPL deployment");
    expect(readCreateMarker(dir)).toBeUndefined();
  });
});

describe("osdu-cluster-delete workflow shape", () => {
  test("is action-only and gates cimpl down behind the preflight node", () => {
    const ctx = {} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0];
    const contribution = (rib.contributeWorkflows?.(ctx) ?? []).find(
      (workflow) => (workflow.definition as { name: string }).name === "osdu-cluster-delete",
    );
    if (!contribution) throw new Error("expected osdu-cluster-delete workflow");

    expect(contribution.bindSnapshotKey).toBeUndefined();
    expect(contribution.validate).toBeUndefined();
    const definition = contribution.definition as {
      description: string;
      nodes: Array<{ id: string; bash?: string; depends_on?: string[]; timeout?: number }>;
    };
    expect(definition.description).toContain("Use when:");
    expect(definition.description).toContain("Triggers:");
    expect(definition.description).toContain("Does:");
    expect(definition.description).toContain("NOT for:");
    expect(definition.nodes.map((node) => node.id)).toEqual(["verify", "down"]);

    const [verify, down] = definition.nodes;
    expect(verify?.bash).toContain("bun ");
    expect(verify?.bash).toContain("verify-cimpl-context.ts");
    expect(verify?.timeout).toBe(60_000);
    expect(down?.depends_on).toEqual(["verify"]);
    expect(down?.bash).toBe(`cimpl ${CLUSTER_LIFECYCLE_ARGS.delete.join(" ")}`);
    expect(down?.timeout).toBe(600_000);
  });
});

describe("verify-cimpl-context preflight gate", () => {
  function runVerifyGate({
    cimplScript,
    expectedContext = "cimpl-a",
    expectedFingerprint = "uid-1",
  }: {
    cimplScript?: string;
    expectedContext?: string;
    expectedFingerprint?: string;
  } = {}): {
    exitCode: number;
    stdout: string;
    stderr: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "osdu-delete-gate-"));
    try {
      writeFileSync(
        join(dir, "kubectl"),
        [
          "#!/bin/sh",
          'if [ "$1" = "config" ] && [ "$2" = "current-context" ]; then',
          '  printf "cimpl-a\\n"',
          "  exit 0",
          "fi",
          'if [ "$1" = "get" ] && [ "$2" = "namespace" ] && [ "$3" = "kube-system" ]; then',
          '  printf "uid-1"',
          "  exit 0",
          "fi",
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      if (cimplScript) writeFileSync(join(dir, "cimpl"), cimplScript, { mode: 0o755 });
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: dir };
      if (expectedContext !== undefined) env.KEELSON_INPUTS_context = expectedContext;
      if (expectedFingerprint !== undefined) {
        env.KEELSON_INPUTS_fingerprint = expectedFingerprint;
      }
      const proc = Bun.spawnSync([process.execPath, "bin/verify-cimpl-context.ts"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: proc.exitCode ?? -1,
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("exits zero without stdout when cimpl info confirms a live deployment", () => {
    const result = runVerifyGate({ cimplScript: '#!/bin/sh\nprintf "{}"\n' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("exits non-zero when cimpl reports no deployment", () => {
    const result = runVerifyGate({ cimplScript: "#!/bin/sh\nexit 1\n" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refusing Delete:");
  });

  test("exits non-zero when the probe is indeterminate", () => {
    const result = runVerifyGate();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refusing Delete:");
  });

  test("exits non-zero when the workflow stamp fingerprint is stale", () => {
    const result = runVerifyGate({
      cimplScript: '#!/bin/sh\nprintf "{}"\n',
      expectedFingerprint: "uid-2",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refusing Delete:");
    expect(result.stderr).toContain("recreated");
  });
});

// The workflow's bash node builds the `cimpl up` argv from the run inputs
// (reached as $KEELSON_INPUTS_*). Execute the actual node body against a fake
// `cimpl` on PATH and assert the argv + private-network env it produces.
describe("osdu-cluster-create workflow bash node argv", () => {
  function runCreateBash(
    inputs: Record<string, string>,
    extraEnv: Record<string, string> = {},
  ): { args: string[]; privateNet: string; exitCode: number } {
    const dir = mkdtempSync(join(tmpdir(), "osdu-create-"));
    try {
      const fake = join(dir, "cimpl");
      const script =
        '#!/usr/bin/env bash\nfor a in "$@"; do printf "ARG:%s\\n" "$a"; done\nprintf "PRIVATE:%s\\n" "$CIMPL_AZURE_PRIVATE_NETWORK"\n';
      writeFileSync(fake, script, { mode: 0o755 });
      const env: Record<string, string> = { PATH: `${dir}:${process.env.PATH ?? ""}`, ...extraEnv };
      for (const [k, v] of Object.entries(inputs)) env[`KEELSON_INPUTS_${k}`] = v;
      const proc = Bun.spawnSync(["bash", "-c", CLUSTER_CREATE_BASH], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = proc.stdout.toString();
      const args = [...out.matchAll(/^ARG:(.*)$/gm)].map((m) => m[1] as string);
      const privateNet = out.match(/^PRIVATE:(.*)$/m)?.[1] ?? "";
      return { args, privateNet, exitCode: proc.exitCode ?? -1 };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("defaults provider to kind and drops every empty optional flag", () => {
    const { args, privateNet } = runCreateBash({});
    expect(args).toEqual(["up", "--provider", "kind"]);
    expect(privateNet).toBe("");
  });

  test("emits profile/env/partition/instance/location and the private-network env for azure", () => {
    const { args, privateNet } = runCreateBash({
      provider: "azure",
      profile: "graduated",
      env: "dev",
      partition: "opendes",
      instance: "primary",
      location: "eastus",
      private: "1",
    });
    expect(args).toEqual([
      "up",
      "--provider",
      "azure",
      "--profile",
      "graduated",
      "--env",
      "dev",
      "--partition",
      "opendes",
      "--instance",
      "primary",
      "--location",
      "eastus",
    ]);
    expect(privateNet).toBe("1");
  });

  test("ignores location and private-network for a kind provider", () => {
    const { args, privateNet } = runCreateBash({
      provider: "kind",
      location: "eastus",
      private: "1",
    });
    expect(args).toEqual(["up", "--provider", "kind"]);
    expect(privateNet).toBe("");
  });

  test("clears an inherited CIMPL_AZURE_PRIVATE_NETWORK when private is not selected", () => {
    // Server env leaks the flag; a managed-VNet (no private input) create must clear it.
    const { args, privateNet } = runCreateBash(
      { provider: "azure" },
      { CIMPL_AZURE_PRIVATE_NETWORK: "1" },
    );
    expect(args).toEqual(["up", "--provider", "azure"]);
    expect(privateNet).toBe("");
  });

  test("re-enforces the provider allowlist at the execution boundary", () => {
    // A workflow run directly with an off-allowlist provider must exit before cimpl.
    const { args, exitCode } = runCreateBash({ provider: "aws" });
    expect(args).toEqual([]);
    expect(exitCode).not.toBe(0);
  });

  test("re-enforces the profile allowlist at the execution boundary", () => {
    const { args, exitCode } = runCreateBash({ provider: "kind", profile: "bogus" });
    expect(args).toEqual([]);
    expect(exitCode).not.toBe(0);
  });

  test("enables private-network only for the exact `1` input at the execution boundary", () => {
    // A workflow run with an arbitrary non-`1` value must not enable it.
    expect(runCreateBash({ provider: "azure", private: "0" }).privateNet).toBe("");
    expect(runCreateBash({ provider: "azure", private: "1" }).privateNet).toBe("1");
  });
});

describe("cimpl context filtering", () => {
  const prevPrefixes = process.env.CIMPL_CONTEXT_PREFIXES;
  afterEach(() => {
    if (prevPrefixes === undefined) delete process.env.CIMPL_CONTEXT_PREFIXES;
    else process.env.CIMPL_CONTEXT_PREFIXES = prevPrefixes;
  });

  test("isCimplManagedContext matches the default prefixes and rejects others", () => {
    delete process.env.CIMPL_CONTEXT_PREFIXES;
    expect(isCimplManagedContext("cimpl-stack-dev")).toBe(true);
    expect(isCimplManagedContext("kind-cimpl-test")).toBe(true);
    expect(isCimplManagedContext("k3d-cimpl-x")).toBe(true);
    expect(isCimplManagedContext("prod-aks")).toBe(false);
    expect(isCimplManagedContext(null)).toBe(false);
  });

  test("CIMPL_CONTEXT_PREFIXES overrides the default prefix set", () => {
    process.env.CIMPL_CONTEXT_PREFIXES = "acme-, team-";
    expect(getCimplPrefixes()).toEqual(["acme-", "team-"]);
    expect(isCimplManagedContext("acme-dev")).toBe(true);
    expect(isCimplManagedContext("cimpl-stack-dev")).toBe(false);
  });

  test("listContexts filters to cimpl-managed and degrades to [] when kubectl fails", async () => {
    delete process.env.CIMPL_CONTEXT_PREFIXES;
    const { exec: okExec } = makeExec({
      text: (cmd, args) =>
        cmd === "kubectl" && args.join(" ") === "config get-contexts -o name"
          ? { ok: true, data: "cimpl-a\nprod-cluster\nkind-cimpl-b\n" }
          : { ok: false, error: "unexpected", code: 1 },
    });
    expect(await listContexts(okExec)).toEqual(["cimpl-a", "kind-cimpl-b"]);

    const { exec: downExec } = makeExec({
      text: () => ({ ok: false, error: "kubectl missing", code: null }),
    });
    expect(await listContexts(downExec)).toEqual([]);
  });
});

describe("cluster action field/payload bindings", () => {
  test("form field names are disjoint from each action's opaque payload keys", () => {
    const createTabs = actionsOf(
      buildClusterBoard({
        lifecycle: {
          context: null,
          reachable: false,
          flux: { ready: 0, total: 0 },
          services: { ready: 0, total: 0 },
        },
      }),
    ).filter((a) => a.type === "create");

    const switchAction = actionOf(
      buildClusterBoard({
        lifecycle: {
          context: "cimpl-a",
          reachable: true,
          flux: { ready: 1, total: 1 },
          services: { ready: 1, total: 1 },
          contexts: ["cimpl-a", "cimpl-b"],
        },
      }),
      "switch-context",
    );

    // The provider rides each tab's static payload; the form must never
    // re-collect it — a field named "provider" would overwrite the tab's
    // identity when the collected values merge over the payload. Create still
    // carries no board-time identity stamp (it launches a workflow).
    const enabledTabs = createTabs.filter((a) => a.fields !== undefined);
    expect(enabledTabs).toHaveLength(2);
    for (const tab of enabledTabs) expect(payloadKeys(tab)).toEqual(["provider"]);
    expect(enabledTabs.map(fieldNames)).toEqual([
      ["env", "profile", "partition", "instance"],
      ["env", "profile", "partition", "instance", "location", "private"],
    ]);
    expect(fieldNames(switchAction)).toEqual(["target"]);
    expect(payloadKeys(switchAction)).toEqual(["observedCurrent", "observedContexts"]);

    for (const action of [...createTabs, switchAction]) {
      expectFieldPayloadDisjoint(action);
    }
  });
});

describe("switch-context picker options", () => {
  function switchActionFor(contexts: string[], context: string | null): BoardAction | undefined {
    const board = buildClusterBoard({
      lifecycle: {
        context,
        reachable: true,
        flux: { ready: 1, total: 1 },
        services: { ready: 1, total: 1 },
        contexts,
      },
    });
    return actionsOf(board).find((a) => a.type === "switch-context");
  }

  test("offers only cimpl-managed targets; no default when current is non-cimpl", () => {
    const action = switchActionFor(["cimpl-a"], "prod-cluster");
    expect(action).toBeDefined();
    const field = action?.fields?.[0];
    expect(field?.options?.map((o) => o.value)).toEqual(["cimpl-a"]);
    // Current (prod-cluster) isn't a valid option, so no defaultValue is set.
    expect(field?.defaultValue).toBeUndefined();
  });

  test("hides the switch when the only cimpl context is already current", () => {
    expect(switchActionFor(["cimpl-a"], "cimpl-a")).toBeUndefined();
  });

  test("preselects the current when it is itself a cimpl-managed target", () => {
    const field = switchActionFor(["cimpl-a", "cimpl-b"], "cimpl-a")?.fields?.[0];
    expect(field?.options?.map((o) => o.value)).toEqual(["cimpl-a", "cimpl-b"]);
    expect(field?.defaultValue).toBe("cimpl-a");
  });
});
