import type { RibExec } from "@keelson/shared";
import { errText } from "@keelson/shared";
import { type CimplContextState, parseCimplInfoJson } from "./cluster.ts";

export type { CimplContextState } from "./cluster.ts";

import {
  getClusterFingerprint,
  getCurrentContext,
  isCimplManagedContext,
  listContexts,
} from "./kubectl.ts";

// cimpl lifecycle verbs the ICC actions (onAction) and the chat tools dispatch
// to. Reconcile/Suspend/Resume are reversible; Delete tears down the current
// context's cluster and is gated separately (UI destructive-confirm; not a tool).
// Create is not here — it launches the `osdu-cluster-create` workflow.
export const CLUSTER_LIFECYCLE_ARGS = {
  reconcile: ["reconcile"],
  suspend: ["reconcile", "--suspend"],
  resume: ["reconcile", "--resume"],
  delete: ["down", "--provider", "current-context"],
} as const;

// use-context is a local kubeconfig edit; bound it like the other config reads
// so a stalled kubeconfig can't hold the action open for the provisioning span.
const CONTEXT_SWITCH_TIMEOUT_MS = 5_000;

export type ClusterVerb = keyof typeof CLUSTER_LIFECYCLE_ARGS;

// Tri-state result of probing whether the live current-context hosts a CIMPL
// deployment — the CimplContextState defined beside fetchClusterInfo, which
// applies the same classification.
export interface CimplContextProbe {
  state: CimplContextState;
  detail: string;
}

// `cimpl info` is cimpl's own authoritative fingerprint. It exits zero with a
// parseable document over a CIMPL cluster (live); a completed non-zero exit is
// cimpl reporting the context is not a CIMPL deployment (absent); a probe that
// never completed — timeout, cimpl not on PATH (both `code: null`) — or output
// that won't parse is indeterminate (unknown). Never throws.
export async function probeCimplContext(exec: RibExec): Promise<CimplContextProbe> {
  const res = await exec.runText("cimpl", ["info", "--json"], { timeoutMs: 60_000 });
  if (res.ok) {
    try {
      parseCimplInfoJson(res.data);
      return { state: "live", detail: "a live CIMPL deployment is active" };
    } catch (e) {
      return { state: "unknown", detail: `could not parse cimpl info (${errText(e)})` };
    }
  }
  if (res.code === null) {
    return { state: "unknown", detail: `cimpl info probe did not complete (${res.error})` };
  }
  return { state: "absent", detail: "no CIMPL deployment on the current context" };
}

// Confirm the live current-context IS a CIMPL deployment before mutating it
// (reconcile/suspend/resume/delete). Returns an error string to refuse with, or
// null to proceed. Fails closed: only a confirmed-live probe proceeds; both
// `absent` and an indeterminate `unknown` refuse.
export async function verifyCimplContext(exec: RibExec): Promise<string | null> {
  const probe = await probeCimplContext(exec);
  if (probe.state === "live") return null;
  if (probe.state === "absent") {
    // Read the context through the injected exec (async) — the sync currentContext()
    // would spawn kubectl on the server loop and, with no reachable cluster, block
    // to its timeout (and isn't stubbable, so it hung this path's CI test).
    const ctx = await getCurrentContext(exec);
    return `the current context (${ctx ?? "none"}) is not a confirmed CIMPL deployment — switch context and retry`;
  }
  return `could not confirm the current context is a CIMPL deployment (${probe.detail}) — retry`;
}

// Create bypasses the context-identity guard (it runs with no current cluster),
// but must still not clobber an existing deployment. This distinct preflight
// fires the create workflow only on a confirmed-absent probe; a live CIMPL
// deployment OR an indeterminate probe refuses (fail closed). Bounded by
// probeCimplContext's own timeout — the long `cimpl up` runs in the workflow.
export async function refuseCreateOverCimpl(exec: RibExec): Promise<string | null> {
  const probe = await probeCimplContext(exec);
  if (probe.state === "absent") return null;
  if (probe.state === "live") {
    return "refusing Create: a CIMPL deployment is already active on this context — delete it or switch context first";
  }
  return `refusing Create: could not confirm the current context is free of a CIMPL deployment (${probe.detail})`;
}

// Run a cimpl lifecycle verb through the async exec surface, so a slow or
// unreachable cluster never blocks the server event loop. Shared by onAction and
// the chat tools.
export async function runClusterLifecycle(
  exec: RibExec,
  verb: ClusterVerb,
  timeoutMs: number,
): Promise<{ ok: true; ran: string } | { ok: false; error: string }> {
  const args = CLUSTER_LIFECYCLE_ARGS[verb];
  const res = await exec.runText("cimpl", [...args], { timeoutMs });
  return res.ok ? { ok: true, ran: `cimpl ${args.join(" ")}` } : { ok: false, error: res.error };
}

export async function runContextSwitch(
  exec: RibExec,
  { target }: { target: string },
): Promise<{ ok: true; ran: string } | { ok: false; error: string }> {
  const args = ["config", "use-context", target];
  const res = await exec.runText("kubectl", args, { timeoutMs: CONTEXT_SWITCH_TIMEOUT_MS });
  return res.ok ? { ok: true, ran: `kubectl ${args.join(" ")}` } : { ok: false, error: res.error };
}

// The guarded context-switch verb. Refuses non-cimpl targets, a vanished
// target, a stale observed-current, and a recreated cluster (fingerprint drift)
// before running `kubectl config use-context`. Returns a domain result; the
// caller (onAction) maps it and triggers the board refresh.
export async function switchCimplContext(
  exec: RibExec,
  payload: { target?: unknown; observedCurrent?: unknown; fingerprint?: unknown },
): Promise<{ ok: true; ran: string; current: string | null } | { ok: false; error: string }> {
  const target = typeof payload.target === "string" ? payload.target : "";
  if (!target) return { ok: false, error: "switch-context requires target" };
  // Server-side refusal of non-cimpl targets, independent of the (already
  // filtered) list — the UI only hops between cimpl-managed clusters.
  if (!isCimplManagedContext(target)) {
    return {
      ok: false,
      error: `context '${target}' is not a cimpl-managed context — refusing to switch`,
    };
  }
  const contexts = await listContexts(exec);
  if (!contexts.includes(target)) {
    return { ok: false, error: `context '${target}' is no longer available — refresh and retry` };
  }
  const observedCurrent = payload.observedCurrent;
  if (observedCurrent !== null && typeof observedCurrent !== "string") {
    return { ok: false, error: "switch-context requires observedCurrent" };
  }
  const liveCurrent = await getCurrentContext(exec);
  if (observedCurrent !== liveCurrent) {
    return {
      ok: false,
      error: `current context changed since this view loaded (was ${observedCurrent ?? "none"}, now ${liveCurrent ?? "none"}) — refresh and retry`,
    };
  }
  // Identity guard (parity with reconcile/delete): a context name can be reused
  // (`cimpl down && cimpl up`), the kube-system UID cannot. Refuse if the current
  // cluster was recreated since the board captured its fingerprint.
  const observedFingerprint = payload.fingerprint;
  if (observedFingerprint !== undefined && typeof observedFingerprint !== "string") {
    return { ok: false, error: "switch-context requires a string fingerprint" };
  }
  if (typeof observedFingerprint === "string" && observedFingerprint.length > 0) {
    const liveFingerprint = await getClusterFingerprint(exec);
    if (observedFingerprint !== liveFingerprint) {
      return {
        ok: false,
        error: `the current cluster was recreated since this view loaded (context ${liveCurrent ?? "none"}) — refresh and retry`,
      };
    }
  }
  const res = await runContextSwitch(exec, { target });
  if (!res.ok) return { ok: false, error: res.error };
  const current = await getCurrentContext(exec);
  return { ok: true, ran: res.ran, current };
}
