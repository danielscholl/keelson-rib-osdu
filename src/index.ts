import type { CanvasView, Rib } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import { currentContext } from "./kubectl.ts";

const TOPOLOGY_KEY = "rib:osdu:topology";

// Absolute path to the deterministic collector, resolved at module load so the
// workflow's bash node runs the right file regardless of the run's cwd.
const COLLECTOR = new URL("../bin/collect-topology.ts", import.meta.url).pathname;

const rib: Rib = {
  id: "osdu",
  displayName: "OSDU",

  // Binds the rib-namespaced snapshot key to the canvas graph view. The button
  // appears on the Ribs page; the data arrives when the workflow below runs.
  views: [{ key: TOPOLOGY_KEY, canvasKind: "view", title: "Cluster Topology" }],

  // The producer: a deterministic workflow whose bash node prints a graph
  // payload, which the executor promotes to structured output and the rib
  // binding publishes to TOPOLOGY_KEY (fail-closed via `validate`). No React,
  // no hand-coded server route — the UI data comes from a workflow.
  contributeWorkflows: () => [
    {
      definition: {
        name: "osdu-topology",
        description:
          'Use when: checking cluster reconciliation health. Triggers: "show the topology", "is the cluster healthy". Does: reads Flux Kustomizations via kubectl and publishes a live node-link graph to the Cluster Topology canvas. NOT for: changing cluster state.',
        nodes: [
          {
            id: "collect",
            bash: `bun ${COLLECTOR}`,
            output_schema: { type: "object", required: ["view", "nodes", "edges"] },
          },
        ],
      },
      bindSnapshotKey: TOPOLOGY_KEY,
      // Validate through the canvas view union (not the bare graph schema) so the
      // producer-side guard enforces node-id uniqueness — the same check the
      // SPA's render gate runs — before a frame is ever broadcast.
      validate: (data: unknown): CanvasView => {
        const view = canvasViewSchema.parse(data);
        if (view.view !== "graph") throw new Error(`${TOPOLOGY_KEY} expects a graph view`);
        return view;
      },
    },
  ],

  authStatus: () => {
    const ctx = currentContext();
    return ctx
      ? { authenticated: true, statusMessage: `kubectl context: ${ctx}` }
      : { authenticated: false, statusMessage: "no kubectl context" };
  },
};

export default rib;
