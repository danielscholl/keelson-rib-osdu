import type { CanvasView, Rib, RibAction, RibActionResult, RibContext } from "@keelson/shared";
import { canvasViewSchema } from "@keelson/shared";
import { actionGuardError, hasRealSecret, parseCimplInfoJson } from "./cluster.ts";
import {
  CLUSTER_LIFECYCLE_ARGS,
  type ClusterVerb,
  runClusterLifecycle,
  verifyCimplContext,
} from "./cluster-actions.ts";
import { clusterFingerprint, currentContext } from "./kubectl.ts";
import { registerOsduTools } from "./tools.ts";

const CLUSTER_KEY = "rib:osdu:cluster";
const TOPOLOGY_KEY = "rib:osdu:topology";
const QUALITY_KEY = "rib:osdu:quality";
const FEATURES_KEY = "rib:osdu:features";
const SECURITY_KEY = "rib:osdu:security";
const EVENTS_KEY = "rib:osdu:events";
const RELEASE_KEY = "rib:osdu:release";
const WAITING_KEY = "rib:osdu:waiting";

// Absolute paths to the deterministic collectors, resolved at module load so a
// workflow node runs the right file regardless of the run's cwd.
const CLUSTER_COLLECTOR = new URL("../bin/collect-cluster.ts", import.meta.url).pathname;
const TOPOLOGY_COLLECTOR = new URL("../bin/collect-topology.ts", import.meta.url).pathname;
const QUALITY_COLLECTOR = new URL("../bin/collect-quality.ts", import.meta.url).pathname;
const FEATURES_COLLECTOR = new URL("../bin/collect-features.ts", import.meta.url).pathname;
const SECURITY_COLLECTOR = new URL("../bin/collect-security.ts", import.meta.url).pathname;
const EVENTS_COLLECTOR = new URL("../bin/collect-events.ts", import.meta.url).pathname;
const RELEASE_COLLECTOR = new URL("../bin/collect-release.ts", import.meta.url).pathname;
const WAITING_COLLECTOR = new URL("../bin/collect-waiting.ts", import.meta.url).pathname;

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
    const parsed = parseCimplInfoJson(res.data) as { credentials?: CimplCredentialSecret[] };
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
    { key: EVENTS_KEY, canvasKind: "view", title: "Current Events" },
    { key: RELEASE_KEY, canvasKind: "view", title: "Release Train" },
    { key: WAITING_KEY, canvasKind: "view", title: "Waiting on You" },
  ],

  // Composes the lane boards into one CIMPL nav tab (the G4 surface); regions
  // bind the same snapshot keys the views publish. The Cluster ICC is the
  // collapsible header (the cluster's health + access + actions strip).
  surfaces: [
    {
      id: "cimpl",
      title: "CIMPL",
      layout: {
        header: {
          key: CLUSTER_KEY,
          collapsible: true,
          collapsed: true,
          workflow: "osdu-cluster",
          cadenceMs: 600_000,
          title: "Cluster ICC",
        },
        banner: {
          key: WAITING_KEY,
          workflow: "osdu-waiting",
          cadenceMs: 600_000,
          title: "Waiting on You",
          glyph: { char: "⌖", tone: "caution" },
        },
        rows: [
          {
            columns: [
              {
                key: RELEASE_KEY,
                workflow: "osdu-release",
                cadenceMs: 1_800_000,
                title: "Release Train",
                glyph: { char: "⚑", tone: "accent" },
              },
            ],
          },
          {
            columns: [
              {
                key: FEATURES_KEY,
                workflow: "osdu-features",
                cadenceMs: 7_200_000,
                title: "Features",
                glyph: { char: "◆", tone: "brand" },
              },
              {
                key: QUALITY_KEY,
                workflow: "osdu-quality",
                cadenceMs: 7_200_000,
                title: "Quality",
                glyph: { char: "⬢", tone: "info" },
              },
              {
                key: SECURITY_KEY,
                workflow: "osdu-security",
                cadenceMs: 7_200_000,
                title: "Security",
                glyph: { char: "▲", tone: "caution" },
              },
            ],
          },
        ],
        footer: {
          key: EVENTS_KEY,
          collapsible: true,
          collapsed: true,
          workflow: "osdu-events",
          cadenceMs: 1_800_000,
          title: "Current Events",
        },
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
          'Use when: reviewing platform release quality. Triggers: "show quality", "how are the services", "sonar / test pass rates". Does: runs the osdu-quality release CLI and publishes a quality board — a good/poor/fail pulse, Pass/Flaky/Fail/Skip KPI tiles, a per-service Sonar table (acceptance/unit pass rates, coverage, R·S·M grades), and a test-performance block (passing/slipping/failing pulse, unit/acceptance bars, worst-acceptance table) — to the Quality canvas. NOT for: changing pipelines or merging.',
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
    {
      definition: {
        name: "osdu-events",
        description:
          'Use when: catching up on recent platform + cluster motion. Triggers: "what just happened", "current events", "recent activity", "what changed". Does: shells the osdu-activity mr + epic CLIs and `kubectl get jobs` and publishes a Current Events feed — newest-first rows tagging each as PLATFORM (an opened or merged MR) or CLUSTER (a bootstrap/cron Job), with a relative-time stamp — to the Current Events canvas. NOT for: changing cluster state or merging MRs.',
        nodes: [
          {
            id: "collect",
            bash: `bun ${EVENTS_COLLECTOR}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: EVENTS_KEY,
      validate: expectView(EVENTS_KEY, "board"),
    },
    {
      definition: {
        name: "osdu-release",
        description:
          'Use when: tracking the active release — what is queued and what shipped. Triggers: "release train", "what is the release", "new MRs", "platform wins", "what merged this week". Does: shells the osdu-activity mr + epic CLIs and publishes a Release Train banner — the active milestone as the header chip, a New Merge Requests queue (recent open MRs), and Platform Wins (core services merged to main this week) — to the Release Train canvas. NOT for: merging MRs or changing the release.',
        nodes: [
          {
            id: "collect",
            bash: `bun ${RELEASE_COLLECTOR}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: RELEASE_KEY,
      validate: expectView(RELEASE_KEY, "board"),
    },
    {
      definition: {
        name: "osdu-waiting",
        description:
          'Use when: checking what needs your personal attention. Triggers: "what needs my attention", "my queue", "waiting on me", "what am I blocking", "what should I review". Does: reads your GitLab dashboard MRs via currentUser plus kubectl Flux/Job readiness and publishes a Waiting on You queue — your MRs with a failed pipeline or requested changes (P0), MRs awaiting your review (P1), your ready-to-merge MRs (P2), not-ready Flux Kustomizations/HelmReleases (P0), and failed load jobs (P1), priority-sorted — to the Waiting on You canvas. NOT for: merging MRs, approving reviews, or reconciling the cluster.',
        nodes: [
          {
            id: "collect",
            bash: `bun ${WAITING_COLLECTOR}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: WAITING_KEY,
      validate: expectView(WAITING_KEY, "board"),
    },
  ],

  // Cluster ICC actions: dispatch a lifecycle verb to the `cimpl` CLI via the
  // async exec surface, so a slow/unreachable cluster can't block the server
  // event loop. The board reflects the new state on the next osdu-cluster run.
  // `reveal-credential` is a read that returns one password to the caller for an
  // on-demand clipboard copy — the secret never enters a snapshot.
  onAction: async (action, ctx) => {
    // Identity guard: cimpl acts on the live kubectl current-context, so every
    // cluster action must match the cluster it was built against (context name
    // and, when captured, the stable fingerprint) — otherwise a stale board
    // could reveal/mutate the wrong cluster (especially Delete).
    const payload = action.payload as { context?: unknown; fingerprint?: unknown } | undefined;
    const guard = actionGuardError(payload, currentContext(), clusterFingerprint());
    if (guard) return { ok: false, error: guard };
    if (action.type === "reveal-credential") return revealCredential(action, ctx);
    if (!(action.type in CLUSTER_LIFECYCLE_ARGS)) {
      return { ok: false, error: `unknown action '${action.type}'` };
    }
    const verb = action.type as ClusterVerb;
    // Re-verify identity before the irreversible teardown: a context can match
    // yet not be a live CIMPL deployment (e.g. cimpl info degraded at collect
    // time over a reachable non-CIMPL cluster). `cimpl down` would otherwise
    // remove fixed namespaces from whatever cluster is current.
    if (verb === "delete") {
      const denial = await verifyCimplContext(ctx.getExec());
      if (denial) return { ok: false, error: `refusing Delete: ${denial}` };
    }
    // Teardown waits on Flux pruning + namespace termination — minutes, not the
    // ~2 min a reconcile/suspend needs. A too-short timeout would abort a delete
    // mid-flight and leave the cluster half-removed.
    const timeoutMs = verb === "delete" ? 600_000 : 120_000;
    const res = await runClusterLifecycle(ctx.getExec(), verb, timeoutMs);
    return res.ok ? { ok: true, data: { ran: res.ran } } : { ok: false, error: res.error };
  },

  // The OSDU domains as chat tools — the same data layer the panels visualize,
  // plus the reversible cluster-lifecycle verbs. The harness registers what this
  // returns into the shared tool registry (chat, /api/tools).
  registerTools: (ctx) => registerOsduTools(ctx),

  authStatus: () => {
    const ctx = currentContext();
    return ctx
      ? { authenticated: true, statusMessage: `kubectl context: ${ctx}` }
      : { authenticated: false, statusMessage: "no kubectl context" };
  },
};

export default rib;
