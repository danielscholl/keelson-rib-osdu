import type { CanvasView, Rib } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import { currentContext } from "./kubectl.ts";

const TOPOLOGY_KEY = "rib:osdu:topology";
const QUALITY_KEY = "rib:osdu:quality";
const FEATURES_KEY = "rib:osdu:features";
const SECURITY_KEY = "rib:osdu:security";

// Absolute paths to the deterministic collectors, resolved at module load so a
// workflow node runs the right file regardless of the run's cwd.
const TOPOLOGY_COLLECTOR = new URL("../bin/collect-topology.ts", import.meta.url).pathname;
const QUALITY_COLLECTOR = new URL("../bin/collect-quality.ts", import.meta.url).pathname;
const FEATURES_COLLECTOR = new URL("../bin/collect-features.ts", import.meta.url).pathname;
const SECURITY_COLLECTOR = new URL("../bin/collect-security.ts", import.meta.url).pathname;

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
    { key: FEATURES_KEY, canvasKind: "view", title: "Features" },
    { key: SECURITY_KEY, canvasKind: "view", title: "Security" },
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
    {
      definition: {
        name: "osdu-features",
        description:
          'Use when: tracking delivery — what is moving and what is stalled. Triggers: "what\'s moving", "show features", "stalled epics", "open MRs". Does: runs the osdu-activity epic + merge-request CLIs and publishes a features board — an active/quiet pulse, MR KPI tiles (open / stale / blocked / ready), "Movers" cards with progress bars, and "Stalled" rows with a why-flagged note — to the Features canvas. NOT for: merging or editing MRs.',
        nodes: [
          {
            id: "collect",
            bash: `bun ${FEATURES_COLLECTOR}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: FEATURES_KEY,
      validate: expectView(FEATURES_KEY, "board"),
    },
    {
      definition: {
        name: "osdu-security",
        description:
          'Use when: reviewing platform security posture. Triggers: "show security", "how are vulnerabilities", "critical CVEs", "aged criticals", "quick wins". Does: runs the osdu-quality release CLI plus GitLab/OSV CVE lookups and publishes a security board — a crit/high/med service pulse, KPI tiles (Critical / High / Medium / Vuln MRs), low-security-rating cards, top-offender severity bars, aged-critical CVE cards, and dependency-bump quick wins — to the Security canvas. NOT for: patching or merging dependency MRs.',
        nodes: [
          {
            id: "collect",
            bash: `bun ${SECURITY_COLLECTOR}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: SECURITY_KEY,
      validate: expectView(SECURITY_KEY, "board"),
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
