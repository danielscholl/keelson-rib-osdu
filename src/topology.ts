import type { CanvasGraphView } from "@keelson/shared";

export interface FluxCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface FluxDependsOn {
  name?: string;
  namespace?: string;
}

/** The subset of a Flux Kustomization (kustomize.toolkit.fluxcd.io) we read from `kubectl ... -o json`. */
export interface FluxKustomization {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    suspend?: boolean;
    dependsOn?: FluxDependsOn[];
  };
  status?: {
    conditions?: FluxCondition[];
  };
}

export type NodeHealth = "ready" | "blocked" | "suspended" | "failed" | "unknown";

const LAYER_LABEL = "cimpl-stack.layer";

/**
 * Reconciliation health from the Flux `Ready` condition. `DependencyNotReady` is
 * its own state (blocked) so the graph distinguishes "waiting on an upstream
 * kustomization" from an outright failure.
 */
export function kustomizationHealth(k: FluxKustomization): NodeHealth {
  if (k.spec?.suspend === true) return "suspended";
  const ready = k.status?.conditions?.find((c) => c.type === "Ready");
  if (!ready) return "unknown";
  if (ready.status === "True") return "ready";
  if (ready.reason === "DependencyNotReady") return "blocked";
  if (ready.status === "False") return "failed";
  return "unknown";
}

export interface TopologyInput {
  context?: string | null;
  kustomizations: readonly FluxKustomization[];
}

/**
 * Build a node-link graph of the Flux reconciliation tree from raw
 * `kubectl get kustomizations -o json` items. Pure — no I/O.
 *
 * Node `kind` carries health so the canvas graph view renders it as a badge;
 * edges follow Flux `spec.dependsOn` (upstream → dependent), and any
 * dependency-free kustomization is rooted under the cluster node so the graph
 * is always connected and rooted. Always emits at least the cluster node, so
 * the result satisfies the canvas graph contract even with no kustomizations.
 */
export function buildTopologyGraph(input: TopologyInput): CanvasGraphView {
  const contextName = input.context?.trim() || "current context";
  const rootId = `cluster:${contextName}`;

  const seen = new Set<string>();
  const named: { k: FluxKustomization; name: string }[] = [];
  for (const k of input.kustomizations) {
    const name = k.metadata?.name?.trim() ?? "";
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    named.push({ k, name });
  }

  const nodes: CanvasGraphView["nodes"] = [{ id: rootId, label: contextName, kind: "cluster" }];
  const edges: CanvasGraphView["edges"] = [];

  for (const { k, name } of named) {
    const layer = k.metadata?.labels?.[LAYER_LABEL];
    nodes.push({
      id: `ks:${name}`,
      label: layer ? `${name} · L${layer}` : name,
      kind: kustomizationHealth(k),
    });

    const deps = (k.spec?.dependsOn ?? [])
      .map((d) => d.name?.trim() ?? "")
      .filter((dep) => dep.length > 0 && dep !== name && seen.has(dep));

    if (deps.length === 0) {
      edges.push({ source: rootId, target: `ks:${name}` });
    } else {
      for (const dep of deps) {
        edges.push({ source: `ks:${dep}`, target: `ks:${name}` });
      }
    }
  }

  return { view: "graph", nodes, edges };
}
