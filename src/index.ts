import type { CanvasView, Rib } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import { currentContext } from "./kubectl.ts";

const TOPOLOGY_KEY = "rib:osdu:topology";
const QUALITY_KEY = "rib:osdu:quality";

// Absolute paths to the deterministic collectors, resolved at module load so a
// workflow node runs the right file regardless of the run's cwd.
const TOPOLOGY_COLLECTOR = new URL("../bin/collect-topology.ts", import.meta.url).pathname;
const QUALITY_COLLECTOR = new URL("../bin/collect-quality.ts", import.meta.url).pathname;

// Validate through the canvas view union (not a bare member schema) so the
// producer-side guard enforces node-id / column-key uniqueness — the same
// checks the SPA render gate runs — before a frame is ever broadcast.
function expectView(key: string, kind: CanvasView["view"]) {
  return (data: unknown): CanvasView => {
    const view = canvasViewSchema.parse(data);
    if (view.view !== kind) throw new Error(`${key} expects a ${kind} view`);
    return view;
  };
}

const rib: Rib = {
  id: "osdu",
  displayName: "OSDU",

  // Each view binds a rib-namespaced snapshot key to a canvas renderer. The
  // buttons appear on the Ribs page; data arrives when the workflows run.
  views: [
    { key: TOPOLOGY_KEY, canvasKind: "view", title: "Cluster Topology" },
    { key: QUALITY_KEY, canvasKind: "view", title: "Quality" },
  ],

  // The producers: deterministic workflows whose node prints a view payload,
  // which the executor promotes to structured output and the rib binding
  // publishes (fail-closed via `validate`). No React, no hand-coded route —
  // the UI data comes from a workflow.
  contributeWorkflows: () => [
    {
      definition: {
        name: "osdu-topology",
        description:
          'Use when: checking cluster reconciliation health. Triggers: "show the topology", "is the cluster healthy". Does: reads Flux Kustomizations via kubectl and publishes a live node-link graph to the Cluster Topology canvas. NOT for: changing cluster state.',
        nodes: [
          {
            id: "collect",
            bash: `bun ${TOPOLOGY_COLLECTOR}`,
            output_schema: { type: "object", required: ["view", "nodes", "edges"] },
          },
        ],
      },
      bindSnapshotKey: TOPOLOGY_KEY,
      validate: expectView(TOPOLOGY_KEY, "graph"),
    },
    {
      definition: {
        name: "osdu-quality",
        description:
          'Use when: reviewing platform release quality. Triggers: "show quality", "how are the services", "sonar / test pass rates / CVEs". Does: runs the osdu-quality release CLI and publishes a quality board — a good/poor/fail pulse, KPI tiles, and a per-service table (acceptance/unit pass rates, coverage, Sonar R·S·M ratings, CVE counts) — to the Quality canvas. NOT for: changing pipelines or merging.',
        nodes: [
          {
            id: "collect",
            bash: `bun ${QUALITY_COLLECTOR}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: QUALITY_KEY,
      validate: expectView(QUALITY_KEY, "board"),
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
