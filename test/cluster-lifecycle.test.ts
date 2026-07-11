import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CanvasBoardView, RibContext, RibExec } from "@keelson/shared";
import { buildClusterBoard, provisionGuardError } from "../src/cluster.ts";
import { CLUSTER_CREATE_ARGS } from "../src/cluster-actions.ts";
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

const createPayload = {
  provider: "azure",
  profile: "minimal",
} as const;

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

describe("provisionGuardError", () => {
  test("accepts both-null observed/live context and rejects stale context or fingerprint", () => {
    expect(provisionGuardError({ observedContext: null }, null, null)).toBeNull();
    expect(provisionGuardError({ observedContext: "ctx-a" }, "ctx-b", "uid-1")).toMatch(
      /context changed/,
    );
    expect(
      provisionGuardError({ observedContext: "ctx-a", fingerprint: "uid-1" }, "ctx-a", "uid-2"),
    ).toMatch(/recreated/);
  });
});

describe("cluster lifecycle onAction guards", () => {
  test("cluster-provision refuses over a live CIMPL deployment and runs no create", async () => {
    setLiveKube(null);
    const { exec, calls } = makeExec({
      text: (cmd, args) =>
        cmd === "kubectl"
          ? kubectlText(args)
          : cmd === "cimpl" && args.join(" ") === "info --json"
            ? { ok: true, data: "{}" }
            : { ok: true, data: "unexpected mutation" },
    });

    const result = await dispatch(
      {
        type: "cluster-provision",
        payload: { ...createPayload, observedContext: null },
      },
      exec,
    );

    if (result.ok) throw new Error("expected cluster-provision refusal");
    expect(result.error).toBe("refusing Provision: a live CIMPL deployment is active");
    expect(commandCalls(calls, "cimpl")).toEqual(["info --json"]);
  });

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

  test("cluster-provision runs cimpl up with the expected argv when no live CIMPL cluster", async () => {
    setLiveKube(null);
    const { exec, calls } = makeExec({
      text: (cmd, args) => {
        if (cmd === "kubectl") return kubectlText(args);
        const command = args.join(" ");
        if (command === "info --json") return { ok: false, error: "not a cimpl cluster", code: 1 };
        return { ok: true, data: "" };
      },
    });

    const result = await dispatch(
      {
        type: "cluster-provision",
        payload: {
          provider: "azure",
          profile: "graduated",
          env: "dev",
          private: "private",
          observedContext: null,
        },
      },
      exec,
    );

    if (!result.ok) throw new Error(`expected provision success: ${result.error}`);
    expect(commandCalls(calls, "cimpl")).toEqual([
      "info --json",
      "up --profile graduated --provider azure --env dev",
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

  test("cluster-provision refuses when the CIMPL probe is indeterminate (fail-safe)", async () => {
    setLiveKube(null);
    const { exec, calls } = makeExec({
      text: (cmd, args) => {
        if (cmd === "kubectl") return kubectlText(args);
        const command = args.join(" ");
        if (command === "info --json") {
          return { ok: false, error: "timed out after 60000ms", code: null };
        }
        return { ok: true, data: "" };
      },
    });

    const result = await dispatch(
      { type: "cluster-provision", payload: { provider: "kind", observedContext: null } },
      exec,
    );

    if (result.ok) throw new Error("expected provision refusal on an indeterminate probe");
    expect(result.error).toMatch(/could not confirm/);
    // The probe ran but `cimpl up` never did — fail closed, no create.
    expect(commandCalls(calls, "cimpl")).toEqual(["info --json"]);
  });
});

describe("CLUSTER_CREATE_ARGS argv contract", () => {
  test("defaults provider to kind and drops every empty optional flag", () => {
    expect(CLUSTER_CREATE_ARGS({ provider: "kind" })).toEqual({
      args: ["up", "--provider", "kind"],
    });
  });

  test("emits profile/env/partition/instance + azure location and private-network env", () => {
    expect(
      CLUSTER_CREATE_ARGS({
        provider: "azure",
        profile: "graduated",
        env: "dev",
        partition: "opendes",
        instance: "primary",
        location: "eastus",
        privateNetwork: true,
      }),
    ).toEqual({
      args: [
        "up",
        "--profile",
        "graduated",
        "--provider",
        "azure",
        "--env",
        "dev",
        "--partition",
        "opendes",
        "--instance",
        "primary",
        "--location",
        "eastus",
      ],
      env: { CIMPL_AZURE_PRIVATE_NETWORK: "1" },
    });
  });

  test("ignores location and private-network for non-azure providers", () => {
    expect(
      CLUSTER_CREATE_ARGS({ provider: "kind", location: "eastus", privateNetwork: true }),
    ).toEqual({ args: ["up", "--provider", "kind"] });
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
  test("form field names are disjoint from each action's opaque payload keys", async () => {
    const previewAction = actionOf(
      buildClusterBoard({
        lifecycle: {
          context: null,
          reachable: false,
          flux: { ready: 0, total: 0 },
          services: { ready: 0, total: 0 },
        },
      }),
      "cluster-preview",
    );

    const switchAction = actionOf(
      buildClusterBoard({
        lifecycle: {
          context: "ctx-a",
          reachable: true,
          flux: { ready: 1, total: 1 },
          services: { ready: 1, total: 1 },
          contexts: ["ctx-a", "ctx-b"],
        },
      }),
      "switch-context",
    );

    setLiveKube("ctx-a", "uid-1");
    const boards: CanvasBoardView[] = [];
    const { exec } = makeExec({
      text: (cmd, args) =>
        cmd === "kubectl" ? kubectlText(args) : { ok: false, error: "unexpected cimpl", code: 1 },
    });
    const result = await dispatch(
      { type: "cluster-preview", payload: createPayload },
      exec,
      boards,
    );
    expect(result.ok).toBe(true);
    expect(boards).toHaveLength(1);
    const provisionAction = actionOf(boards[0] as CanvasBoardView, "cluster-provision");

    expect(fieldNames(previewAction)).toEqual([
      "provider",
      "profile",
      "env",
      "partition",
      "instance",
      "location",
      "private",
    ]);
    expect(fieldNames(switchAction)).toEqual(["target"]);
    expect(fieldNames(provisionAction)).toEqual([]);
    expect(payloadKeys(switchAction)).toEqual(["observedCurrent", "observedContexts"]);

    for (const action of [previewAction, provisionAction, switchAction]) {
      expectFieldPayloadDisjoint(action);
    }
  });
});
