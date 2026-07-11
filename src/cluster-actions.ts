import type { RibExec } from "@keelson/shared";
import { errText } from "@keelson/shared";
import { parseCimplInfoJson } from "./cluster.ts";
import { type ClusterCreateInput, DEFAULT_CLUSTER_PROVIDER } from "./cluster-create.ts";
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
// use-context is a local kubeconfig edit; bound it like the other config reads
// so a stalled kubeconfig can't hold the action open for the provisioning span.
const CONTEXT_SWITCH_TIMEOUT_MS = 5_000;

export type ClusterVerb = keyof typeof CLUSTER_LIFECYCLE_ARGS;

export interface ClusterCreateCommand {
  args: string[];
  // Per-op env overrides merged into the spawn env; only the azure
  // private-subnet path populates it.
  env?: Record<string, string>;
}

// `cimpl up` argv, mirroring cimpl-agent _maps/lifecycle.ts TEMPLATES.create:
// --provider is required (defaulting to kind); --profile/--env/--partition/
// --instance/--location drop when empty so cimpl's per-provider defaults apply;
// there is no --name flag (cimpl derives the name from --env). Args are spawned
// as an argv array (no shell), so free-text values need no quoting.
export function CLUSTER_CREATE_ARGS(input: ClusterCreateInput): ClusterCreateCommand {
  const provider = input.provider || DEFAULT_CLUSTER_PROVIDER;
  const args: string[] = ["up"];
  const profile = input.profile?.trim();
  if (profile) args.push("--profile", profile);
  args.push("--provider", provider);
  const env = input.env?.trim();
  if (env) args.push("--env", env);
  const partition = input.partition?.trim();
  if (partition) args.push("--partition", partition);
  const instance = input.instance?.trim();
  if (instance) args.push("--instance", instance);
  if (provider === "azure") {
    const location = input.location?.trim();
    if (location) args.push("--location", location);
  }
  const command: ClusterCreateCommand = { args };
  if (provider === "azure" && input.privateNetwork) {
    command.env = { CIMPL_AZURE_PRIVATE_NETWORK: "1" };
  }
  return command;
}

// Render the create command for the provision preview board, prefixing the
// private-network env var the way cimpl-agent buildCreatePreviewCommand does.
export function clusterCreatePreview(input: ClusterCreateInput): string {
  const { args, env } = CLUSTER_CREATE_ARGS(input);
  const head = env?.CIMPL_AZURE_PRIVATE_NETWORK ? "CIMPL_AZURE_PRIVATE_NETWORK=1 cimpl" : "cimpl";
  return [head, ...args].join(" ");
}

// Tri-state result of probing whether the live current-context hosts a CIMPL
// deployment. `unknown` is deliberately distinct from `absent` so callers can
// fail closed on an indeterminate probe rather than treat it as "no cluster".
export type CimplContextState = "live" | "absent" | "unknown";
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

// Confirm there is NO live CIMPL deployment to clobber before provisioning.
// Fails closed: only a confirmed-`absent` probe proceeds; a `live` deployment
// and an indeterminate `unknown` both refuse, so a transient probe failure can
// never provision over an existing cluster.
export async function refuseProvisionOverCimpl(exec: RibExec): Promise<string | null> {
  const probe = await probeCimplContext(exec);
  if (probe.state === "absent") return null;
  if (probe.state === "live") return "refusing Provision: a live CIMPL deployment is active";
  return `refusing Provision: could not confirm the current context is free of a CIMPL deployment (${probe.detail})`;
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
  const { args, env } = CLUSTER_CREATE_ARGS(input);
  const res = await exec.runText("cimpl", args, {
    timeoutMs: CLUSTER_CREATE_TIMEOUT_MS,
    ...(env ? { env } : {}),
  });
  return res.ok ? { ok: true, ran: clusterCreatePreview(input) } : { ok: false, error: res.error };
}

export async function runContextSwitch(
  exec: RibExec,
  { target }: { target: string },
): Promise<{ ok: true; ran: string } | { ok: false; error: string }> {
  const args = ["config", "use-context", target];
  const res = await exec.runText("kubectl", args, { timeoutMs: CONTEXT_SWITCH_TIMEOUT_MS });
  return res.ok ? { ok: true, ran: `kubectl ${args.join(" ")}` } : { ok: false, error: res.error };
}
