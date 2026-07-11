import type { RibExec } from "@keelson/shared";
import { errText } from "@keelson/shared";
import { parseCimplInfoJson } from "./cluster.ts";
import type { ClusterCreateInput } from "./cluster-create.ts";
import { getCurrentContext } from "./kubectl.ts";

// cimpl lifecycle verbs the ICC actions (onAction) and the chat tools dispatch
// to. Reconcile/Suspend/Resume are reversible; Delete tears down the current
// context's cluster and is gated separately (UI destructive-confirm; not a tool).
export const CLUSTER_LIFECYCLE_ARGS = {
  reconcile: ["reconcile"],
  suspend: ["reconcile", "--suspend"],
  resume: ["reconcile", "--resume"],
  delete: ["down", "--provider", "current-context"],
} as const;

const CLUSTER_CREATE_TIMEOUT_MS = 600_000;
const CONTEXT_SWITCH_TIMEOUT_MS = 600_000;

export type ClusterVerb = keyof typeof CLUSTER_LIFECYCLE_ARGS;

export function CLUSTER_CREATE_ARGS({ provider, profile, name }: ClusterCreateInput): string[] {
  return ["up", "--provider", provider, "--profile", profile, "--name", name];
}

// Confirm the live current-context is a CIMPL deployment before a mutation.
// `cimpl info` runs cimpl's own authoritative fingerprint and exits non-zero on
// a non-CIMPL context. Returns an error string to refuse with, or null to
// proceed. The chat mutation tools have no board stamp to guard against, so this
// fresh probe is their identity check.
export async function verifyCimplContext(exec: RibExec): Promise<string | null> {
  const res = await exec.runText("cimpl", ["info", "--json"], { timeoutMs: 60_000 });
  if (!res.ok) {
    // Read the context through the injected exec (async) — the sync currentContext()
    // would spawn kubectl on the server loop and, with no reachable cluster, block
    // to its timeout (and isn't stubbable, so it hung this path's CI test).
    const ctx = await getCurrentContext(exec);
    return `the current context (${ctx ?? "none"}) is not a confirmed CIMPL deployment — switch context and retry`;
  }
  try {
    parseCimplInfoJson(res.data);
  } catch (e) {
    return `could not parse cimpl info (${errText(e)})`;
  }
  return null;
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

export async function runClusterCreate(
  exec: RibExec,
  input: ClusterCreateInput,
): Promise<{ ok: true; ran: string } | { ok: false; error: string }> {
  const args = CLUSTER_CREATE_ARGS(input);
  const res = await exec.runText("cimpl", args, { timeoutMs: CLUSTER_CREATE_TIMEOUT_MS });
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
