import type { CanvasView, Rib, RibAction, RibActionResult, RibContext } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import { contextActionError, hasRealSecret } from "./cluster.ts";
import { currentContext } from "./kubectl.ts";

const CLUSTER_KEY = "rib:osdu:cluster";
const TOPOLOGY_KEY = "rib:osdu:topology";
const QUALITY_KEY = "rib:osdu:quality";
const FEATURES_KEY = "rib:osdu:features";
const SECURITY_KEY = "rib:osdu:security";

// Absolute paths to the deterministic collectors, resolved at module load so a
// workflow node runs the right file regardless of the run's cwd.
const CLUSTER_COLLECTOR = new URL("../bin/collect-cluster.ts", import.meta.url).pathname;
const TOPOLOGY_COLLECTOR = new URL("../bin/collect-topology.ts", import.meta.url).pathname;
const QUALITY_COLLECTOR = new URL("../bin/collect-quality.ts", import.meta.url).pathname;
const FEATURES_COLLECTOR = new URL("../bin/collect-features.ts", import.meta.url).pathname;
const SECURITY_COLLECTOR = new URL("../bin/collect-security.ts", import.meta.url).pathname;

// cimpl lifecycle verbs the ICC actions dispatch to (POST /api/ribs/osdu/action
// → onAction). Reconcile/Suspend/Resume are reversible; Delete tears down the
// active context's cluster and is guarded behind the SPA's destructive confirm.
// `reveal-credential` is handled separately (it reads, not mutates).
const CLUSTER_ACTION_ARGS: Record<string, string[]> = {
  reconcile: ["reconcile"],
  suspend: ["reconcile", "--suspend"],
  resume: ["reconcile", "--resume"],
  delete: ["down", "--provider", "current-context"],
};

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

interface CimplCredentialSecret {
  service?: string;
  password?: string;
}

// Re-fetch one credential's password on demand for a clipboard copy. The secret
// is returned straight to the caller (loopback) and is never written to a
// snapshot or persisted. Uses runText + loose parse because `cimpl info` can
// print a preamble before its JSON.
async function revealCredential(action: RibAction, ctx: RibContext): Promise<RibActionResult> {
  const payload = (action.payload ?? {}) as { service?: unknown };
  const service = typeof payload.service === "string" ? payload.service : "";
  if (!service) return { ok: false, error: "reveal-credential requires payload.service" };

  const res = await ctx
    .getExec()
    .runText("cimpl", ["info", "--json", "--show-secrets"], { timeoutMs: 60_000 });
  if (!res.ok) return { ok: false, error: res.error };

  let creds: CimplCredentialSecret[];
  try {
    const text = res.data;
    const start = text.search(/[{[]/);
    const parsed = JSON.parse(start > 0 ? text.slice(start) : text) as {
      credentials?: CimplCredentialSecret[];
    };
    creds = parsed.credentials ?? [];
  } catch (e) {
    return { ok: false, error: `failed to parse cimpl output: ${asMessage(e)}` };
  }

  const cred = creds.find((c) => c.service === service);
  if (!cred || !hasRealSecret(cred.password)) {
    return { ok: false, error: `no credential for '${service}'` };
  }
  return { ok: true, data: cred.password };
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const rib: Rib = {
  id: "osdu",
  displayName: "OSDU",

  // Each view binds a rib-namespaced snapshot key to a canvas renderer. The
  // buttons appear on the Ribs page; data arrives when the workflows run.
  views: [
    { key: CLUSTER_KEY, canvasKind: "view", title: "Cluster ICC" },
    { key: TOPOLOGY_KEY, canvasKind: "view", title: "Cluster Topology" },
    { key: QUALITY_KEY, canvasKind: "view", title: "Quality" },
    { key: FEATURES_KEY, canvasKind: "view", title: "Features" },
    { key: SECURITY_KEY, canvasKind: "view", title: "Security" },
  ],

  // Composes the lane boards into one CIMPL nav tab (the G4 surface); regions
  // bind the same snapshot keys the views publish. The Cluster ICC is the
  // collapsible header (the cluster's health + access + actions strip).
  surfaces: [
    {
      id: "cimpl",
      title: "CIMPL",
      layout: {
        header: { key: CLUSTER_KEY, collapsible: true, collapsed: true },
        rows: [{ columns: [{ key: QUALITY_KEY }, { key: FEATURES_KEY }, { key: SECURITY_KEY }] }],
      },
    },
  ],

  // The producers: deterministic workflows whose node prints a view payload,
  // which the executor promotes to structured output and the rib binding
  // publishes (fail-closed via `validate`). No React, no hand-coded route —
  // the UI data comes from a workflow.
  contributeWorkflows: () => [
    {
      definition: {
        name: "osdu-cluster",
        description:
          'Use when: checking the deployment\'s health + access. Triggers: "show the cluster", "is the cluster up", "where is Airflow / the portal", "reconcile the cluster". Does: shells `cimpl info --json` plus kubectl Flux/HelmRelease readiness and publishes a Cluster ICC board — lifecycle rows (context / reachable / Flux reconciled / services ready), Reconcile · Suspend/Resume actions, and endpoint + internal-service access cards — to the Cluster ICC canvas. NOT for: deleting or creating clusters.',
        nodes: [
          {
            id: "collect",
            bash: `bun ${CLUSTER_COLLECTOR}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: CLUSTER_KEY,
      validate: expectView(CLUSTER_KEY, "board"),
    },
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

  // Cluster ICC actions: dispatch a lifecycle verb to the `cimpl` CLI via the
  // async exec surface, so a slow/unreachable cluster can't block the server
  // event loop. The board reflects the new state on the next osdu-cluster run.
  // `reveal-credential` is a read that returns one password to the caller for an
  // on-demand clipboard copy — the secret never enters a snapshot.
  onAction: async (action, ctx) => {
    // Context guard: cimpl acts on the live kubectl current-context, so every
    // cluster action must name the context it was built against and still match
    // it — otherwise a stale board could reveal/mutate the wrong cluster
    // (especially Delete). A missing captured context is rejected too.
    const expected = (action.payload as { context?: unknown } | undefined)?.context;
    const guard = contextActionError(expected, currentContext());
    if (guard) return { ok: false, error: guard };
    if (action.type === "reveal-credential") return revealCredential(action, ctx);
    const args = CLUSTER_ACTION_ARGS[action.type];
    if (!args) return { ok: false, error: `unknown action '${action.type}'` };
    // Teardown waits on Flux pruning + namespace termination — minutes, not the
    // ~2 min a reconcile/suspend needs. A too-short timeout would abort a delete
    // mid-flight and leave the cluster half-removed.
    const timeoutMs = action.type === "delete" ? 600_000 : 120_000;
    const res = await ctx.getExec().runText("cimpl", args, { timeoutMs });
    return res.ok
      ? { ok: true, data: { ran: `cimpl ${args.join(" ")}` } }
      : { ok: false, error: res.error };
  },

  authStatus: () => {
    const ctx = currentContext();
    return ctx
      ? { authenticated: true, statusMessage: `kubectl context: ${ctx}` }
      : { authenticated: false, statusMessage: "no kubectl context" };
  },
};

export default rib;
