import type { JobRow } from "./events.ts";
import type { FluxKustomization } from "./topology.ts";

type RunResult = { ok: true; stdout: string } | { ok: false; error: string };

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

export function currentContext(): string | null {
  const res = runKubectl(["config", "current-context"], 5_000);
  if (!res.ok) return null;
  const ctx = res.stdout.trim();
  return ctx.length > 0 ? ctx : null;
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
export function getKustomizations(namespace = "flux-system"): KustomizationsResult {
  const context = currentContext();
  const res = runKubectl(["get", "kustomizations", "-n", namespace, "-o", "json"]);
  if (!res.ok) return { context, kustomizations: [], error: res.error };
  try {
    const parsed = JSON.parse(res.stdout) as { items?: FluxKustomization[] };
    return { context, kustomizations: parsed.items ?? [] };
  } catch (e) {
    return { context, kustomizations: [], error: e instanceof Error ? e.message : "parse error" };
  }
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
export function getHelmReleases(): HelmReleasesResult {
  const res = runKubectl(["get", "helmreleases", "-A", "-o", "json"]);
  if (!res.ok) return { helmreleases: [], error: res.error };
  try {
    const parsed = JSON.parse(res.stdout) as { items?: FluxKustomization[] };
    return { helmreleases: parsed.items ?? [] };
  } catch (e) {
    return { helmreleases: [], error: e instanceof Error ? e.message : "parse error" };
  }
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

export interface ReadinessResult {
  ready: number;
  total: number;
  /** Present when collection degraded (no cluster, no kubectl, parse failure). */
  error?: string;
}

/**
 * Count ready/total for a Flux resource (e.g. kustomizations, helmreleases) on
 * the active context. Never throws: degrades to `{ ready: 0, total: 0, error }`.
 */
export function getReadiness(resource: string, scopeArgs: string[] = ["-A"]): ReadinessResult {
  const res = runKubectl(["get", resource, ...scopeArgs, "-o", "json"]);
  if (!res.ok) return { ready: 0, total: 0, error: res.error };
  try {
    const items = (JSON.parse(res.stdout) as { items?: ReadyLike[] }).items ?? [];
    return { ready: items.filter(isReady).length, total: items.length };
  } catch (e) {
    return { ready: 0, total: 0, error: e instanceof Error ? e.message : "parse error" };
  }
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
export function getJobs(): JobsResult {
  const res = runKubectl(["get", "jobs", "-A", "-o", "json"]);
  if (!res.ok) return { jobs: [], error: res.error };
  try {
    const items = (JSON.parse(res.stdout) as { items?: KubeJob[] }).items ?? [];
    return {
      jobs: items.map((i) => ({
        name: i.metadata?.name ?? null,
        namespace: i.metadata?.namespace ?? null,
        created_at: i.metadata?.creationTimestamp ?? null,
        status: jobStatus(i.status),
        failed: i.status?.failed ?? 0,
      })),
    };
  } catch (e) {
    return { jobs: [], error: e instanceof Error ? e.message : "parse error" };
  }
}
