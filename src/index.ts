import type { Rib, RibAction, RibActionResult, RibContext, RibRunEvent } from "@keelson/shared";
import { errText, expectView } from "@keelson/shared";
import { actionGuardError, hasRealSecret, parseCimplInfoJson } from "./cluster.ts";
import {
  CLUSTER_LIFECYCLE_ARGS,
  type ClusterVerb,
  refuseCreateOverCimpl,
  runClusterLifecycle,
  switchCimplContext,
  verifyCimplContext,
} from "./cluster-actions.ts";
import {
  buildCreateCommand,
  CLUSTER_CREATE_BASH,
  clusterCreateArgs,
  clusterCreateSelection,
  deriveClusterName,
  selectionFromRunInputs,
} from "./cluster-create.ts";
import {
  type CreateMarker,
  clearCreateMarker,
  formatAge,
  markerAgeMs,
  markerInFlight,
  readCreateMarker,
  writeCreateMarker,
} from "./create-marker.ts";
import { currentContext, getClusterFingerprint, getCurrentContext } from "./kubectl.ts";
import { registerOsduTools } from "./tools.ts";

const CLUSTER_KEY = "rib:osdu:cluster";
const DOCTOR_KEY = "rib:osdu:doctor";
const TOPOLOGY_KEY = "rib:osdu:topology";
const QUALITY_KEY = "rib:osdu:quality";
const FEATURES_KEY = "rib:osdu:features";
const SECURITY_KEY = "rib:osdu:security";
const EVENTS_KEY = "rib:osdu:events";
const RELEASE_KEY = "rib:osdu:release";
const WAITING_KEY = "rib:osdu:waiting";

// Absolute paths to deterministic bin scripts, resolved at module load so a
// workflow node runs the right file regardless of the run's cwd.
const CLUSTER_COLLECTOR = new URL("../bin/collect-cluster.ts", import.meta.url).pathname;

// `RIB_OSDU_DATA_DIR='<path>' ` (trailing space) or "" — the env prefix handing
// the rib's data dir to the cluster collector's bash node.
function clusterCollectorEnv(ctx: RibContext): string {
  const dataDir = ctx.getDataDir?.();
  return dataDir ? `RIB_OSDU_DATA_DIR='${dataDir.replace(/'/g, "'\\''")}' ` : "";
}
const DOCTOR_COLLECTOR = new URL("../bin/collect-doctor.ts", import.meta.url).pathname;
const TOPOLOGY_COLLECTOR = new URL("../bin/collect-topology.ts", import.meta.url).pathname;
const QUALITY_COLLECTOR = new URL("../bin/collect-quality.ts", import.meta.url).pathname;
const FEATURES_COLLECTOR = new URL("../bin/collect-features.ts", import.meta.url).pathname;
const SECURITY_COLLECTOR = new URL("../bin/collect-security.ts", import.meta.url).pathname;
const EVENTS_COLLECTOR = new URL("../bin/collect-events.ts", import.meta.url).pathname;
const RELEASE_COLLECTOR = new URL("../bin/collect-release.ts", import.meta.url).pathname;
const WAITING_COLLECTOR = new URL("../bin/collect-waiting.ts", import.meta.url).pathname;
const VERIFY_CIMPL_CONTEXT = new URL("../bin/verify-cimpl-context.ts", import.meta.url).pathname;

interface CimplCredentialSecret {
  service?: string;
  password?: string;
}

// Handed to a workflow rather than run inline so the long `cimpl up` streams its
// node trace; it runs with no current cluster, so it carries no identity guard.
// A bounded preflight probe still refuses to fire the workflow over a live (or
// indeterminate) CIMPL deployment — the distinct "don't clobber" safety check —
// and an in-flight dispatch marker refuses a double-create. The marker is what
// flips the Cluster board to its provisioning state (the collector reads it);
// the refreshWorkflow nudge republishes the board without waiting on the cadence.
async function launchClusterCreate(action: RibAction, ctx: RibContext): Promise<RibActionResult> {
  const selected = clusterCreateSelection((action.payload ?? {}) as Record<string, unknown>);
  if (!selected.ok) return { ok: false, error: selected.error };
  const dataDir = ctx.getDataDir?.();
  const inFlightError = (): string | undefined => {
    if (!dataDir) return undefined;
    const existing = readCreateMarker(dataDir);
    if (!existing || !markerInFlight(existing, Date.now())) return undefined;
    return (
      `a cluster create is already in flight (dispatched ${formatAge(markerAgeMs(existing, Date.now()))}) ` +
      "— watch the osdu-cluster-create run in the Workflows tab"
    );
  };
  const early = inFlightError();
  if (early) return { ok: false, error: early };
  const denial = await refuseCreateOverCimpl(ctx.getExec());
  if (denial) return { ok: false, error: denial };
  const selection = selected.selection;
  if (dataDir) {
    // Recheck after the awaited preflight, then write with no await between:
    // two concurrent dispatches interleave only at awaits, so the second one
    // sees the first's marker here and refuses instead of double-creating.
    const raced = inFlightError();
    if (raced) return { ok: false, error: raced };
    writeCreateMarker(dataDir, {
      status: "dispatched",
      provider: selection.provider,
      ...(selection.profile ? { profile: selection.profile } : {}),
      ...(selection.env ? { env: selection.env } : {}),
      cluster: deriveClusterName(selection.env),
      command: buildCreateCommand(selection),
      startedAt: new Date().toISOString(),
    });
    await ctx.refreshWorkflow?.("osdu-cluster");
  }
  return {
    ok: true,
    data: {
      effect: "run-workflow",
      workflow: "osdu-cluster-create",
      args: clusterCreateArgs(selection),
      // The Cluster board flips to its provisioning state in place; don't yank
      // focus to the Workflows tab.
      stay: true,
    },
  };
}

// Null when inputs name an unknown provider/profile — the workflow rejects
// those itself, so no honest command exists to describe.
function markerFromRun(event: RibRunEvent): CreateMarker | null {
  const selection = selectionFromRunInputs(event.inputs);
  if (!selection) return null;
  return {
    status: "dispatched",
    provider: selection.provider,
    ...(selection.profile ? { profile: selection.profile } : {}),
    ...(selection.env ? { env: selection.env } : {}),
    cluster: deriveClusterName(selection.env),
    command: buildCreateCommand(selection),
    // Observation time, not event.startedAt: a resume keeps the run's original
    // timestamp, which can put a fresh attempt outside the in-flight window.
    startedAt: new Date().toISOString(),
    runId: event.runId,
  };
}

// Cancellation clears the marker (a settled attempt, not a warning); every
// transition republishes the board ahead of its cadence.
async function handleRunEvent(event: RibRunEvent, ctx: RibContext): Promise<void> {
  if (event.workflowName === "osdu-cluster-delete") {
    if (event.status !== "running") await ctx.refreshWorkflow?.("osdu-cluster");
    return;
  }
  if (event.workflowName !== "osdu-cluster-create") return;
  const dataDir = ctx.getDataDir?.();
  if (!dataDir) return;
  const existing = readCreateMarker(dataDir);
  // The harness serializes events per RUN only — concurrent creates interleave
  // freely, so an in-flight marker claimed by another run is never this
  // event's to touch (cluster truth settles any residue on the next collect).
  if (
    existing &&
    markerInFlight(existing, Date.now()) &&
    existing.runId !== undefined &&
    existing.runId !== event.runId
  ) {
    return;
  }
  if (event.status === "running") {
    if (existing && markerInFlight(existing, Date.now())) {
      // A board dispatch wrote its marker (validated selection, no runId)
      // just before launching: the first running event adopts it.
      if (existing.runId === undefined) {
        writeCreateMarker(dataDir, { ...existing, runId: event.runId });
      }
    } else {
      const marker = markerFromRun(event);
      if (!marker) return;
      writeCreateMarker(dataDir, marker);
    }
  } else if (event.status === "failed") {
    const base =
      existing?.status === "dispatched" &&
      (existing.runId === undefined || existing.runId === event.runId)
        ? existing
        : markerFromRun(event);
    if (!base) return;
    writeCreateMarker(dataDir, {
      ...base,
      status: "failed",
      runId: event.runId,
      ...(event.error ? { error: event.error } : {}),
    });
  } else {
    clearCreateMarker(dataDir);
  }
  await ctx.refreshWorkflow?.("osdu-cluster");
}

async function switchContext(action: RibAction, ctx: RibContext): Promise<RibActionResult> {
  const res = await switchCimplContext(
    ctx.getExec(),
    (action.payload ?? {}) as {
      target?: unknown;
      observedCurrent?: unknown;
      fingerprint?: unknown;
    },
  );
  if (!res.ok) return { ok: false, error: res.error };
  await ctx.refreshWorkflow?.("osdu-cluster");
  return { ok: true, data: { ran: res.ran, current: res.current } };
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
    return { ok: false, error: `failed to parse cimpl output: ${errText(e)}` };
  }

  const cred = creds.find((c) => c.service === service);
  if (!cred || !hasRealSecret(cred.password)) {
    return { ok: false, error: `no credential for '${service}'` };
  }
  return { ok: true, data: cred.password };
}

const rib: Rib = {
  id: "osdu",
  displayName: "OSDU",

  contributeDocs: () => [
    {
      title: "OSDU",
      summary:
        "The OSDU rib for Keelson: cluster health and topology, quality, security, releases, features, and events. Covers the collector pipeline, guardrails, install and local-dev guides, and the rib's design.",
      llmsFullUrl: "https://danielscholl.github.io/keelson-rib-osdu/llms-full.txt",
    },
  ],

  // Each view binds a rib-namespaced snapshot key to a canvas renderer. The
  // buttons appear on the Ribs page; data arrives when the workflows run.
  views: [
    { key: CLUSTER_KEY, canvasKind: "view", title: "Cluster" },
    { key: DOCTOR_KEY, canvasKind: "view", title: "Cluster Doctor" },
    { key: TOPOLOGY_KEY, canvasKind: "view", title: "Cluster Topology" },
    { key: QUALITY_KEY, canvasKind: "view", title: "Quality" },
    { key: FEATURES_KEY, canvasKind: "view", title: "Features" },
    { key: SECURITY_KEY, canvasKind: "view", title: "Security" },
    { key: EVENTS_KEY, canvasKind: "view", title: "Current Events" },
    { key: RELEASE_KEY, canvasKind: "view", title: "Release Train" },
    { key: WAITING_KEY, canvasKind: "view", title: "Waiting on You" },
  ],

  // Composes the lane boards into one CIMPL nav tab (the G4 surface); regions
  // bind the same snapshot keys the views publish. The Cluster board is the
  // collapsible header (the cluster's health + access + actions strip).
  surfaces: [
    {
      id: "cimpl",
      title: "CIMPL",
      heading: "OSDU Community Implementation",
      layout: {
        header: {
          key: CLUSTER_KEY,
          collapsible: true,
          collapsed: true,
          workflow: "osdu-cluster",
          // Fast enough that a provisioning/reconciling board tracks the
          // cluster while the surface is open (a create settles in minutes);
          // the refresh only runs while the surface is open.
          cadenceMs: 60_000,
          title: "Cluster",
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
  contributeWorkflows: (ctx) => [
    {
      definition: {
        name: "osdu-cluster",
        description:
          'Use when: checking the deployment\'s health + access or choosing a kube-context. Triggers: "show the cluster", "is the cluster up", "where is Airflow / the portal", "reconcile the cluster", "switch context". Does: shells `cimpl info --json` plus kubectl Flux/HelmRelease readiness and publishes a Cluster board — lifecycle rows (context / reachable / Flux reconciled / services ready), Reconcile · Suspend/Resume · Delete · Create cluster · Switch active context actions, and endpoint + internal-service access cards — to the Cluster canvas. NOT for: bypassing typed confirmations or identity guards.',
        nodes: [
          {
            id: "collect",
            // The rib's data dir rides in as env so the out-of-process collector
            // can read the create-dispatch marker; the path is single-quoted for
            // the bash body. Absent on an older harness — the marker states
            // degrade away, the board still collects.
            bash: `${clusterCollectorEnv(ctx)}bun ${CLUSTER_COLLECTOR}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: CLUSTER_KEY,
      validate: expectView(CLUSTER_KEY, "board"),
    },
    {
      // One bash node runs `cimpl up` from the form fields (passed as run
      // inputs). No bindSnapshotKey/validate — it acts, it doesn't publish a view.
      definition: {
        name: "osdu-cluster-create",
        description:
          'Use when: bringing up a new CIMPL dev cluster from an empty or unreachable Cluster board. Triggers: "create the cluster", "bring up cimpl", "provision a new cluster". Does: runs `cimpl up` with the chosen provider/profile/env/partition/instance (+ azure location/private) as a streaming node in the Workflows surface. NOT for: reconciling, deleting, or switching an existing cluster.',
        nodes: [
          {
            id: "provision",
            bash: CLUSTER_CREATE_BASH,
            // A cloud create (AKS provision + Flux converge) can run most of an
            // hour; 10 minutes killed legitimate azure runs. The create-marker
            // windows in create-marker.ts stay within this ceiling.
            timeout: 3_000_000,
          },
        ],
      },
    },
    {
      definition: {
        name: "osdu-doctor",
        description:
          'Use when: checking whether the local cluster-CLI toolchain is ready to deploy. Triggers: "check my environment", "what tools are missing", "is AWS ready". Does: runs `cimpl check --json` and publishes a Cluster Doctor board with installed versus missing cluster CLI tools. NOT for: installing tools or changing cluster state.',
        nodes: [
          {
            id: "collect",
            bash: `bun ${DOCTOR_COLLECTOR}`,
            output_schema: { type: "object", required: ["view", "sections"] },
          },
        ],
      },
      bindSnapshotKey: DOCTOR_KEY,
      validate: expectView(DOCTOR_KEY, "board"),
    },
    {
      definition: {
        name: "osdu-cluster-delete",
        description:
          "Use when: tearing down the current CIMPL dev cluster after the Cluster board's typed-confirm Delete. Triggers: Delete from the Cluster board after the identity guard and destructive confirm pass. Does: re-verifies the live CIMPL context, then runs `cimpl down --provider current-context` as a streaming node in the Workflows surface. NOT for: bypassing the Cluster board's identity guard or destructive confirm.",
        nodes: [
          {
            id: "verify",
            bash: `bun ${VERIFY_CIMPL_CONTEXT}`,
            timeout: 60_000,
          },
          {
            id: "down",
            bash: `cimpl ${CLUSTER_LIFECYCLE_ARGS.delete.join(" ")}`,
            depends_on: ["verify"],
            timeout: 600_000,
          },
        ],
      },
    },
    {
      definition: {
        name: "osdu-topology",
        description:
          'Use when: checking cluster reconciliation health. Triggers: "show the topology", "is the cluster healthy". Does: reads Flux Kustomizations and HelmReleases via kubectl and publishes a live node-link graph to the Cluster Topology canvas. NOT for: changing cluster state.',
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
          'Use when: reviewing platform security posture. Triggers: "show security", "how are vulnerabilities", "critical CVEs", "aged criticals", "quick wins". Does: runs the osdu-quality release CLI plus GitLab/OSV CVE lookups and publishes a security board — a crit/high/med service pulse, KPI tiles (Critical / High / Medium / Vuln MRs), low-security-rating cards, top-offender severity bars, aged-critical CVE rows, and dependency-bump quick-win rows (each disclosing the packages and services it clears) — to the Security canvas. NOT for: patching or merging dependency MRs.',
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

  // Cluster board actions: dispatch lifecycle/context verbs via the async exec
  // surface, so a slow/unreachable cluster can't block the server event loop.
  // `create` and `switch-context` are handled BEFORE the stale-context guard —
  // create runs with no current cluster and a switch deliberately changes the
  // context. `reveal-credential` is a read that returns one password to the
  // caller for an on-demand clipboard copy — the secret never enters a snapshot.
  onAction: async (action, ctx) => {
    if (action.type === "create") return launchClusterCreate(action, ctx);
    if (action.type === "switch-context") return switchContext(action, ctx);

    // Identity guard: cimpl acts on the live kubectl current-context, so every
    // cluster action must match the cluster it was built against (context name
    // and, when captured, the stable fingerprint) — otherwise a stale board
    // could reveal/mutate the wrong cluster (especially Delete).
    const exec = ctx.getExec();
    const payload = action.payload as { context?: unknown; fingerprint?: unknown } | undefined;
    const liveContext = await getCurrentContext(exec);
    const guard = actionGuardError(
      payload,
      liveContext,
      liveContext ? await getClusterFingerprint(exec) : null,
    );
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
      const denial = await verifyCimplContext(exec);
      if (denial) return { ok: false, error: `refusing Delete: ${denial}` };
      const args: { context: string; fingerprint?: string } = {
        context: typeof payload?.context === "string" ? payload.context : "",
      };
      if (typeof payload?.fingerprint === "string" && payload.fingerprint.length > 0) {
        args.fingerprint = payload.fingerprint;
      }
      return { ok: true, data: { effect: "run-workflow", workflow: "osdu-cluster-delete", args } };
    }
    const timeoutMs = 120_000;
    const res = await runClusterLifecycle(exec, verb, timeoutMs);
    return res.ok ? { ok: true, data: { ran: res.ran } } : { ok: false, error: res.error };
  },

  onRunEvent: handleRunEvent,

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
