import type { RibExec } from "@keelson/shared";
import type { JobRow } from "./events.ts";
import { localExec } from "./exec.ts";
import type { FluxKustomization } from "./topology.ts";

type RunResult = { ok: true; stdout: string } | { ok: false; error: string };

// Synchronous kubectl, used only for the two fast local config reads below
// (`current-context`, the kube-system UID). The cluster-state getters are async
// (RibExec) so they never block the server event loop when a tool calls them.
function runKubectl(args: string[], timeoutMs = 30_000): RunResult {
  try {
    const proc = Bun.spawnSync(["kubectl", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim();
      return { ok: false, error: stderr.length > 0 ? stderr : `kubectl exited ${proc.exitCode}` };
    }
    return { ok: true, stdout: proc.stdout.toString() };
  } catch (e) {
    // kubectl missing, not on PATH, or timed out — degrade rather than throw.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const KUBE_TIMEOUT_MS = 30_000;

export function currentContext(): string | null {
  const res = runKubectl(["config", "current-context"], 5_000);
  if (!res.ok) return null;
  const ctx = res.stdout.trim();
  return ctx.length > 0 ? ctx : null;
}

// Async variant for the in-server tool/fetch path, so a chat tool reads the
// active context through RibExec instead of a synchronous spawn on the loop.
export async function getCurrentContext(exec: RibExec = localExec()): Promise<string | null> {
  const res = await exec.runText("kubectl", ["config", "current-context"], { timeoutMs: 5_000 });
  if (!res.ok) return null;
  const ctx = res.data.trim();
  return ctx.length > 0 ? ctx : null;
}

export async function getClusterFingerprint(exec: RibExec = localExec()): Promise<string | null> {
  const res = await exec.runText(
    "kubectl",
    ["get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"],
    { timeoutMs: 5_000 },
  );
  if (!res.ok) return null;
  const uid = res.data.trim();
  return uid.length > 0 ? uid : null;
}

// kubectl context prefixes cimpl provisions its clusters with. Anything else is
// a real (non-managed) cluster and is refused for write actions. A non-empty
// CIMPL_CONTEXT_PREFIXES (comma-separated) REPLACES this default set, mirroring
// cimpl-agent's _maps/context.ts.
const DEFAULT_CIMPL_PREFIXES = ["cimpl-", "kind-cimpl", "k3d-cimpl", "cimpl_"] as const;

export function getCimplPrefixes(): string[] {
  const raw = process.env.CIMPL_CONTEXT_PREFIXES;
  if (!raw) return [...DEFAULT_CIMPL_PREFIXES];
  const parsed = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_CIMPL_PREFIXES];
}

export function isCimplManagedContext(name: string | null | undefined): boolean {
  if (!name) return false;
  return getCimplPrefixes().some((prefix) => name.startsWith(prefix));
}

// List only the cimpl-managed kube-contexts, so the Cluster board picker (and the
// switch-context guard) never offer to hop onto an arbitrary non-cimpl cluster.
// Degrades to [] when kubectl is absent.
export async function listContexts(exec: RibExec = localExec()): Promise<string[]> {
  const res = await exec.runText("kubectl", ["config", "get-contexts", "-o", "name"], {
    timeoutMs: 5_000,
  });
  if (!res.ok) return [];
  return res.data
    .split(/\r?\n/)
    .map((ctx) => ctx.trim())
    .filter((ctx) => ctx.length > 0 && isCimplManagedContext(ctx));
}

// A stable per-cluster identity that survives nothing but the cluster's own
// lifetime: the kube-system namespace UID is created with the cluster and is
// reassigned when it's recreated. Used to bind a board's destructive actions to
// the exact cluster they were built against — a context name can be reused
// (`cimpl down && cimpl up`), a UID cannot. Null when unreadable.
export function clusterFingerprint(): string | null {
  const res = runKubectl(
    ["get", "namespace", "kube-system", "-o", "jsonpath={.metadata.uid}"],
    5_000,
  );
  if (!res.ok) return null;
  const uid = res.stdout.trim();
  return uid.length > 0 ? uid : null;
}

export interface KustomizationsResult {
  context: string | null;
  kustomizations: FluxKustomization[];
  /** Present when collection degraded (no cluster, no kubectl, parse failure). */
  error?: string;
}

/**
 * Read Flux Kustomizations from the active kubectl context. Never throws: any
 * failure degrades to an empty list with `error` set, so the collector can
 * still emit a valid (single-node) graph.
 */
export async function getKustomizations(
  namespace = "flux-system",
  exec: RibExec = localExec(),
): Promise<KustomizationsResult> {
  const context = await getCurrentContext(exec);
  const res = await exec.runJSON<{ items?: FluxKustomization[] }>(
    "kubectl",
    ["get", "kustomizations", "-n", namespace, "-o", "json"],
    { timeoutMs: KUBE_TIMEOUT_MS },
  );
  if (!res.ok) return { context, kustomizations: [], error: res.error };
  return { context, kustomizations: res.data.items ?? [] };
}

export interface HelmReleasesResult {
  helmreleases: FluxKustomization[];
  /** Present when collection degraded (no cluster, no kubectl, parse failure). */
  error?: string;
}

/**
 * Read Flux HelmReleases across all namespaces. Shares the Kustomization item
 * shape (metadata + status.conditions) so `isReady` applies unchanged. Never
 * throws: degrades to an empty list with `error` set.
 */
export async function getHelmReleases(exec: RibExec = localExec()): Promise<HelmReleasesResult> {
  const res = await exec.runJSON<{ items?: FluxKustomization[] }>(
    "kubectl",
    ["get", "helmreleases", "-A", "-o", "json"],
    { timeoutMs: KUBE_TIMEOUT_MS },
  );
  if (!res.ok) return { helmreleases: [], error: res.error };
  return { helmreleases: res.data.items ?? [] };
}

interface ReadyLike {
  spec?: { suspend?: boolean };
  status?: { conditions?: { type?: string; status?: string }[] };
}

// A Flux resource is ready when not suspended and its `Ready` condition is True
// — the same rule for Kustomizations and HelmReleases.
export function isReady(item: ReadyLike): boolean {
  if (item.spec?.suspend === true) return false;
  return item.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
}

// A resource that won't converge without intervention: the kstatus `Stalled`
// condition both Flux controllers set (retries exhausted, bad source), or
// suspended — equally stuck from the board's point of view. A not-ready
// resource that is neither is just reconciling.
export function isStalled(item: ReadyLike): boolean {
  if (item.spec?.suspend === true) return true;
  return item.status?.conditions?.some((c) => c.type === "Stalled" && c.status === "True") ?? false;
}

export interface ReadinessResult {
  ready: number;
  total: number;
  stalled: number;
  /** Present when collection degraded (no cluster, no kubectl, parse failure). */
  error?: string;
}

/**
 * Count ready/stalled/total for a Flux resource (e.g. kustomizations,
 * helmreleases) on the active context. Never throws: degrades to
 * `{ ready: 0, total: 0, stalled: 0, error }`.
 */
export async function getReadiness(
  resource: string,
  scopeArgs: string[] = ["-A"],
  exec: RibExec = localExec(),
): Promise<ReadinessResult> {
  const res = await exec.runJSON<{ items?: ReadyLike[] }>(
    "kubectl",
    ["get", resource, ...scopeArgs, "-o", "json"],
    { timeoutMs: KUBE_TIMEOUT_MS },
  );
  if (!res.ok) return { ready: 0, total: 0, stalled: 0, error: res.error };
  const items = res.data.items ?? [];
  return {
    ready: items.filter(isReady).length,
    total: items.length,
    stalled: items.filter((i) => !isReady(i) && isStalled(i)).length,
  };
}

interface KubeJob {
  metadata?: { name?: string; namespace?: string; creationTimestamp?: string };
  status?: {
    failed?: number;
    active?: number;
    conditions?: { type?: string; status?: string }[];
  };
}

// Collapse a Job's `.status` to a single token: a True `Failed`/`Complete`
// condition wins, else an active pod reads as Running, else Pending.
function jobStatus(status: KubeJob["status"]): string {
  const conds = status?.conditions ?? [];
  if (conds.some((c) => c.type === "Failed" && c.status === "True")) return "Failed";
  if (conds.some((c) => c.type === "Complete" && c.status === "True")) return "Complete";
  return (status?.active ?? 0) > 0 ? "Running" : "Pending";
}

export interface JobsResult {
  jobs: JobRow[];
  /** Present when collection degraded (no cluster, no kubectl, parse failure). */
  error?: string;
}

/**
 * List Kubernetes Jobs across all namespaces on the active context, flattened to
 * `{ name, namespace, created_at, status, failed }`. Never throws: degrades to an
 * empty list with `error` set so the events feed can still render its other sources.
 */
export async function getJobs(exec: RibExec = localExec()): Promise<JobsResult> {
  const res = await exec.runJSON<{ items?: KubeJob[] }>(
    "kubectl",
    ["get", "jobs", "-A", "-o", "json"],
    { timeoutMs: KUBE_TIMEOUT_MS },
  );
  if (!res.ok) return { jobs: [], error: res.error };
  const items = res.data.items ?? [];
  return {
    jobs: items.map((i) => ({
      name: i.metadata?.name ?? null,
      namespace: i.metadata?.namespace ?? null,
      created_at: i.metadata?.creationTimestamp ?? null,
      status: jobStatus(i.status),
      failed: i.status?.failed ?? 0,
    })),
  };
}
