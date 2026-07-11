import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  buildTopologyGraph,
  type FluxKustomization,
  kustomizationHealth,
} from "../src/topology.ts";
import fixture from "./fixtures/kustomizations.json";

const items = fixture.items as FluxKustomization[];

type Graph = ReturnType<typeof buildTopologyGraph>;
const nodeById = (g: Graph, id: string) => g.nodes.find((n) => n.id === id);
const hasEdge = (g: Graph, source: string, target: string) =>
  g.edges.some((e) => e.source === source && e.target === target);

describe("kustomizationHealth", () => {
  test("Ready/True -> ready", () => {
    expect(
      kustomizationHealth({ status: { conditions: [{ type: "Ready", status: "True" }] } }),
    ).toBe("ready");
  });
  test("suspend wins over conditions", () => {
    expect(
      kustomizationHealth({
        spec: { suspend: true },
        status: { conditions: [{ type: "Ready", status: "True" }] },
      }),
    ).toBe("suspended");
  });
  test("DependencyNotReady -> blocked", () => {
    expect(
      kustomizationHealth({
        status: { conditions: [{ type: "Ready", status: "False", reason: "DependencyNotReady" }] },
      }),
    ).toBe("blocked");
  });
  test("Ready/False -> failed", () => {
    expect(
      kustomizationHealth({
        status: { conditions: [{ type: "Ready", status: "False", reason: "HealthCheckFailed" }] },
      }),
    ).toBe("failed");
  });
  test("Ready/Unknown -> unknown", () => {
    expect(
      kustomizationHealth({ status: { conditions: [{ type: "Ready", status: "Unknown" }] } }),
    ).toBe("unknown");
  });
  test("no condition -> unknown", () => {
    expect(kustomizationHealth({})).toBe("unknown");
  });
});

describe("buildTopologyGraph", () => {
  const graph = buildTopologyGraph({ context: "kind-cimpl", kustomizations: items });

  test("emits a valid canvas graph view", () => {
    expect(canvasViewSchema.safeParse(graph).success).toBe(true);
  });

  test("one cluster root plus one node per named kustomization", () => {
    expect(graph.nodes).toHaveLength(7);
    expect(nodeById(graph, "cluster:kind-cimpl")?.kind).toBe("cluster");
  });

  test("node ids are unique", () => {
    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("health rides the node kind", () => {
    expect(nodeById(graph, "ks:cimpl-stack")?.kind).toBe("ready");
    expect(nodeById(graph, "ks:osdu-foundation")?.kind).toBe("ready");
    expect(nodeById(graph, "ks:osdu-platform")?.kind).toBe("failed");
    expect(nodeById(graph, "ks:osdu-services")?.kind).toBe("blocked");
    expect(nodeById(graph, "ks:experimental")?.kind).toBe("suspended");
    expect(nodeById(graph, "ks:orphan")?.kind).toBe("unknown");
  });

  test("layer label is folded into the node label", () => {
    expect(nodeById(graph, "ks:cimpl-stack")?.label).toBe("cimpl-stack · L0");
    expect(nodeById(graph, "ks:experimental")?.label).toBe("experimental");
  });

  test("edges follow dependsOn; dependency-free and dangling-dep nodes root under the cluster", () => {
    expect(hasEdge(graph, "ks:cimpl-stack", "ks:osdu-foundation")).toBe(true);
    expect(hasEdge(graph, "ks:osdu-foundation", "ks:osdu-platform")).toBe(true);
    expect(hasEdge(graph, "ks:osdu-platform", "ks:osdu-services")).toBe(true);
    expect(hasEdge(graph, "cluster:kind-cimpl", "ks:cimpl-stack")).toBe(true);
    expect(hasEdge(graph, "cluster:kind-cimpl", "ks:experimental")).toBe(true);
    expect(hasEdge(graph, "cluster:kind-cimpl", "ks:orphan")).toBe(true);
    expect(graph.edges).toHaveLength(6);
  });

  test("every edge references an existing node", () => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });
});

describe("buildTopologyGraph HelmReleases", () => {
  const ownerLabel = "kustomize.toolkit.fluxcd.io/name";

  test("adds non-ready HelmRelease leaves under the owning Kustomization", () => {
    const graph = buildTopologyGraph({
      context: "kind-cimpl",
      kustomizations: [
        {
          metadata: { name: "osdu-platform" },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        },
      ],
      helmreleases: [
        {
          metadata: {
            name: "partition",
            namespace: "osdu",
            labels: { [ownerLabel]: "osdu-platform" },
          },
          status: { conditions: [{ type: "Ready", status: "False", reason: "InstallFailed" }] },
        },
      ],
    });

    const hrId = "hr:osdu/partition";
    expect(nodeById(graph, "ks:osdu-platform")).toBeDefined();
    expect(nodeById(graph, hrId)?.label).toBe("osdu/partition");
    expect(nodeById(graph, hrId)?.kind).not.toBe("ready");
    expect(nodeById(graph, hrId)?.kind).toBe("failed");
    expect(hasEdge(graph, "ks:osdu-platform", hrId)).toBe(true);
  });

  test("roots HelmReleases with absent or unresolved owners under the cluster", () => {
    const graph = buildTopologyGraph({
      context: "kind-cimpl",
      kustomizations: [],
      helmreleases: [
        {
          metadata: { name: "orphan-chart", namespace: "apps" },
          status: { conditions: [{ type: "Ready", status: "Unknown" }] },
        },
      ],
    });

    expect(hasEdge(graph, "cluster:kind-cimpl", "hr:apps/orphan-chart")).toBe(true);
  });

  test("empty cluster with empty HelmRelease list stays a valid single-node graph", () => {
    const graph = buildTopologyGraph({
      context: "empty",
      kustomizations: [],
      helmreleases: [],
    });

    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
    expect(canvasViewSchema.safeParse(graph).success).toBe(true);
  });

  test("keeps HelmRelease ids unique and every edge attached to an existing node", () => {
    const graph = buildTopologyGraph({
      context: "kind-cimpl",
      kustomizations: [
        {
          metadata: { name: "owner" },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        },
      ],
      helmreleases: [
        {
          metadata: { name: "search", namespace: "osdu", labels: { [ownerLabel]: "owner" } },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        },
        {
          metadata: { name: "search", namespace: "osdu", labels: { [ownerLabel]: "owner" } },
          status: { conditions: [{ type: "Ready", status: "False" }] },
        },
        {
          metadata: { name: "search", namespace: "other", labels: { [ownerLabel]: "owner" } },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        },
        {
          metadata: { name: "no-owner", namespace: "apps", labels: { [ownerLabel]: "missing" } },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        },
      ],
    });

    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(graph.nodes.filter((n) => n.id === "hr:osdu/search")).toHaveLength(1);
    expect(nodeById(graph, "hr:osdu/search")?.label).toBe("osdu/search");
    expect(nodeById(graph, "hr:other/search")?.label).toBe("other/search");

    const nodeIds = new Set(ids);
    for (const e of graph.edges) {
      expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }
  });
});

describe("buildTopologyGraph edge cases", () => {
  test("empty cluster still yields a valid single-node graph", () => {
    const graph = buildTopologyGraph({ context: "empty", kustomizations: [] });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
    expect(canvasViewSchema.safeParse(graph).success).toBe(true);
  });

  test("missing context falls back to a generic root label", () => {
    const graph = buildTopologyGraph({ kustomizations: [] });
    expect(graph.nodes[0]?.id).toBe("cluster:current context");
  });

  test("unnamed items are skipped and self-deps ignored", () => {
    const graph = buildTopologyGraph({
      context: "c",
      kustomizations: [
        { metadata: { name: "" }, status: {} },
        {
          metadata: { name: "solo" },
          spec: { dependsOn: [{ name: "solo" }] },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        },
      ],
    });
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([{ source: "cluster:c", target: "ks:solo" }]);
  });
});
