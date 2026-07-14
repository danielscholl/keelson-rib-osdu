import type { CanvasBoardView, RibExec } from "@keelson/shared";
import {
  buildCreateCommand,
  CLUSTER_PROFILES,
  type ClusterCreateInput,
  DEFAULT_CLUSTER_PROVIDER,
  deriveClusterName,
  PRIVATE_NETWORK_TOKEN,
  PROVIDER_CARDS,
  providerLongName,
} from "./cluster-create.ts";
import { type CreateMarker, formatAge, markerAgeMs, markerInFlight } from "./create-marker.ts";
import { localExec } from "./exec.ts";
import { getCimplPrefixes, isCimplManagedContext } from "./kubectl.ts";

// The subset of `cimpl info --json` the ICC reads. With `--show-secrets` cimpl
// also returns each credential's password; the collector discards it — only the
// service + username reach this builder. The password is fetched on demand by
// the `reveal-credential` action and must never enter the board payload.
export interface CimplEndpoint {
  name: string;
  url?: string;
  note?: string;
}
export interface CimplInternalService {
  name: string;
  address?: string;
  port_forward?: string;
}
export interface CimplCredential {
  service: string;
  username?: string;
}
export interface CimplInfo {
  endpoints?: CimplEndpoint[];
  internal_services?: CimplInternalService[];
  credentials?: CimplCredential[];
  suspended?: boolean;
}

// `stalled` counts resources that won't converge without intervention (a
// kstatus Stalled condition, or suspended). Optional so older callers degrade
// to the stalled-unknown pill behavior rather than a false "Reconciling".
export interface ClusterLifecycle {
  context: string | null;
  // Stable per-cluster id (kube-system UID) captured at collection time, so a
  // destructive action can be refused if the cluster was recreated under the
  // same context name. Optional/null when unreadable.
  fingerprint?: string | null;
  reachable: boolean;
  flux: { ready: number; total: number; stalled?: number };
  services: { ready: number; total: number; stalled?: number };
  contexts?: string[];
}

// The cluster-identity stamp every action carries in its payload, so onAction
// can refuse a stale board (context renamed, or recreated under the same name →
// a new fingerprint). Context is required by the guard; fingerprint is matched
// when present.
export type ClusterStamp = { context?: string; fingerprint?: string };

export interface ClusterInput {
  info?: CimplInfo;
  // cimpl's deployment verdict for the current context. Only a confirmed
  // "absent" unlocks the absence-only surfaces (the foreign-context board, the
  // "No deployment" status, the create tabs); omitted or "unknown" keeps the
  // operating board's lifecycle recourse.
  deployment?: CimplContextState;
  // The create-dispatch record, when one exists and the deployment isn't live
  // yet (the collector clears it on the first live collect). In flight it
  // renders the provisioning board; past its window it renders a caution row.
  createMarker?: CreateMarker;
  // Clock for marker age math; defaults to Date.now(). Tests pin it.
  now?: number;
  lifecycle: ClusterLifecycle;
}

type Tone = "ok" | "warn" | "error" | "neutral";
type BoardSection = CanvasBoardView["sections"][number];
type ColumnsSection = Extract<BoardSection, { kind: "columns" }>;
type LeafSection = ColumnsSection["columns"][number]["sections"][number];
type ActionsSection = Extract<BoardSection, { kind: "actions" }>;
type ActionItem = ActionsSection["items"][number];
type ActionField = NonNullable<ActionItem["fields"]>[number];
type CardsSection = Extract<BoardSection, { kind: "cards" }>;
type CardItem = CardsSection["items"][number];
type FieldItem = NonNullable<CardItem["fields"]>[number];

function countTone(ready: number, total: number): Tone {
  if (total === 0) return "error";
  return ready === total ? "ok" : "warn";
}

// cimpl returns an advisory string rather than a usable secret in two cases: a
// missing value ("n/a", sometimes as `[dim]n/a[/dim]`) and a credential mismatch
// (`[warning]<value> (MISMATCH)[/warning]`). Neither will authenticate, so such
// rows must not produce a copy affordance and the reveal handler must reject
// them — copying them would write a broken value to the clipboard.
export function hasRealSecret(password: unknown): boolean {
  if (typeof password !== "string") return false;
  const trimmed = password.trim();
  if (trimmed.length === 0) return false;
  const lower = trimmed.toLowerCase();
  if (lower.includes("n/a") || lower.includes("(mismatch)")) return false;
  // Any Rich markup tag (`[warning]`, `[dim]`, …) marks an advisory, not a value.
  if (/\[\/?[a-z][a-z0-9 ]*\]/i.test(trimmed)) return false;
  return true;
}

// Parse a `cimpl info --json` document, tolerating a Rich/log preamble before
// the JSON (cimpl can print `[warning]…[/warning]` to stdout). cimpl info
// returns an object, so anchor on the first `{` — anchoring on `[` would start
// at a Rich tag and lose the payload.
export function parseCimplInfoJson(text: string): unknown {
  const start = text.indexOf("{");
  return JSON.parse(start >= 0 ? text.slice(start) : text);
}

// Pick only the fields the board reads; drop every credential's `password` so a
// plaintext secret never crosses into a published snapshot OR a chat tool result.
// Keep only credentials that carry a real secret and a service name (cimpl emits
// "n/a" placeholders during partial deployments).
export function sanitizeCimplInfo(raw: unknown): CimplInfo {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const creds = Array.isArray(obj.credentials) ? obj.credentials : [];
  return {
    endpoints: obj.endpoints as CimplInfo["endpoints"],
    internal_services: obj.internal_services as CimplInfo["internal_services"],
    suspended: obj.suspended === true,
    credentials: creds
      .map((c) => (c ?? {}) as Record<string, unknown>)
      .filter((c) => String(c.service ?? "").trim().length > 0 && hasRealSecret(c.password))
      .map((c) => ({
        service: String(c.service),
        username: typeof c.username === "string" ? c.username : undefined,
      })),
  };
}

// Tri-state deployment verdict for the current context. `unknown` is
// deliberately distinct from `absent` so consumers fail closed on an
// indeterminate probe rather than treat a transient cimpl failure as "no
// cluster". Shared with probeCimplContext (cluster-actions.ts).
export type CimplContextState = "live" | "absent" | "unknown";

// Fetch `cimpl info` (sanitized) for the Cluster ICC collector and the
// `osdu_cluster` chat tool. `--show-secrets` only enumerates which services have
// a credential; sanitizeCimplInfo discards the password before it returns.
// `deployment` mirrors probeCimplContext's classification: a completed non-zero
// exit is cimpl's own verdict that no deployment exists; a call that never
// completed (timeout, cimpl not on PATH) or unparseable output is indeterminate.
export async function fetchClusterInfo(
  exec: RibExec = localExec(),
): Promise<{ info?: CimplInfo; error?: string; deployment: CimplContextState }> {
  const res = await exec.runText("cimpl", ["info", "--json", "--show-secrets"], {
    timeoutMs: 30_000,
  });
  if (!res.ok) return { error: res.error, deployment: res.code === null ? "unknown" : "absent" };
  try {
    return { info: sanitizeCimplInfo(parseCimplInfoJson(res.data)), deployment: "live" };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), deployment: "unknown" };
  }
}

// cimpl always acts on the live kubectl current-context, so every cluster action
// must name the cluster it was built against AND still match it. Returns an
// error string to reject with, or null when it's safe to proceed:
//   - a missing captured context is rejected (a stale board collected with no
//     context must not act on whatever is current now);
//   - a context-name change is rejected (drift);
//   - a fingerprint change is rejected when one was captured — guards the
//     context-name-reuse case (`cimpl down && cimpl up` → same name, new uid).
export function actionGuardError(
  payload: { context?: unknown; fingerprint?: unknown } | undefined,
  liveContext: string | null,
  liveFingerprint: string | null,
): string | null {
  const expectedContext = payload?.context;
  if (typeof expectedContext !== "string" || expectedContext.length === 0) {
    return "no cluster context captured for this action — refresh and retry";
  }
  if (expectedContext !== liveContext) {
    return `cluster context changed since this view loaded (was ${expectedContext}, now ${liveContext ?? "none"}) — refresh and retry`;
  }
  const expectedFingerprint = payload?.fingerprint;
  if (
    typeof expectedFingerprint === "string" &&
    expectedFingerprint.length > 0 &&
    expectedFingerprint !== liveFingerprint
  ) {
    return `this cluster was recreated since the view loaded (context ${expectedContext}) — refresh and retry`;
  }
  return null;
}

// Exact match key: lowercase, strip every non-alphanumeric, so cimpl's casing
// quirks compare cleanly ("MinIO"/"Minio", "RabbitMQ"/"Rabbitmq") while
// parenthetical qualifiers stay distinct ("PostgreSQL" vs "PostgreSQL
// (superuser)" → postgresql vs postgresqlsuperuser).
function matchKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// "Redis (dataset)" → "Redis" — the base used to collapse instance variants.
function baseName(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, "").trim();
}

// The header's overall health pill. Glyph is baked into the label (the base
// renders the label verbatim); tone drives the colour. A reachable cluster
// whose deployment is cimpl-confirmed absent reads "No deployment" — its 0/0
// counts are absence, not degradation. An indeterminate probe falls through to
// the ordinary health labels. A fully reconciled cluster reads "Ready" even
// with the GitRepository suspended — cimpl up pins the source after every
// create (pin_gitops_source), so a suspended source is the normal operating
// mode, not a health state. While the create run is in flight the pill reads
// "Bootstrapping" — incomplete or stalled-unknown reads are expected mid-run,
// and the run itself settles a failure. An incomplete reconcile with stalled
// counts collected and nothing stuck is progress ("Reconciling" — the
// post-create converge, an ordinary drift reconcile), not degradation;
// "Degraded" is reserved for a stalled/suspended resource or a
// stalled-unknown collection.
function clusterStatus(
  lifecycle: ClusterLifecycle,
  noDeployment: boolean,
  bootstrapping: boolean,
): {
  label: string;
  tone: Tone | "info";
} {
  if (!lifecycle.reachable) return { label: "✕ Unreachable", tone: "error" };
  if (noDeployment) return { label: "⚠ No deployment", tone: "warn" };
  const { flux, services } = lifecycle;
  const allReady =
    flux.total > 0 &&
    services.total > 0 &&
    flux.ready === flux.total &&
    services.ready === services.total;
  if (allReady) return { label: "✓ Ready", tone: "ok" };
  // Counts from whichever signal is still converging — flux (kustomizations)
  // leads the post-create converge, services (helmreleases) trail it.
  const lagging =
    flux.ready < flux.total ? flux : services.ready < services.total ? services : null;
  const suffix = lagging ? ` ${lagging.ready}/${lagging.total}` : "";
  if (bootstrapping) return { label: `◌ Bootstrapping${suffix || "…"}`, tone: "info" };
  const stalledKnown = flux.stalled !== undefined && services.stalled !== undefined;
  const converging =
    stalledKnown &&
    (flux.stalled ?? 0) + (services.stalled ?? 0) === 0 &&
    flux.total + services.total > 0;
  return converging
    ? { label: `◌ Reconciling${suffix}`, tone: "info" }
    : { label: "⚠ Degraded", tone: "warn" };
}

function credentialField(cred: CimplCredential, stamp: ClusterStamp): FieldItem {
  const username = cred.username?.trim();
  return {
    // The username is the visible text; the password is never in the payload.
    // The copy button reveals it on demand and writes it to the clipboard.
    value: username && username.length > 0 ? username : "password",
    // The cluster stamp rides along so onAction can refuse to reveal a secret
    // from a different cluster than the board was built against.
    copyAction: { type: "reveal-credential", payload: { service: cred.service, ...stamp } },
  };
}

function portForwardField(
  svc: AccessService,
  base: string,
  internal: CimplInternalService[],
  endpoints: Map<string, CimplEndpoint>,
): FieldItem | undefined {
  if (svc.portal) return undefined;
  const hasRoute = [...endpoints.values()].some(
    (e) => matchKey(e.name).startsWith(base) && Boolean(e.url),
  );
  if (hasRoute) return undefined;
  const match =
    internal.find((s) => matchKey(baseName(s.name)) === base) ??
    internal.find((s) => matchKey(s.name).startsWith(base));
  const fromCimpl =
    typeof match?.port_forward === "string" && match.port_forward.trim().length > 0
      ? match.port_forward.trim()
      : undefined;
  const synth = PORT_FORWARDS[svc.title];
  const command =
    fromCimpl ??
    (synth
      ? `kubectl port-forward svc/${synth.service} ${synth.port}:${synth.port} -n platform`
      : undefined);
  if (!command) return undefined;
  return { label: "Port-forward", value: command, copyable: true };
}

// The operator-facing services the ACCESS grid surfaces, in display order.
// cimpl info enumerates every Kubernetes service (the gateway, API-only
// endpoints like minio-api, the per-namespace Redis variants, an OIDC client
// secret); the ICC curates that down to the services an operator interacts
// with. `portal` → a browser UI (green dot + ↗ from its endpoint URL);
// otherwise a cluster-local service (cyan dot, no link). `creds` lists the
// cimpl credential `service` names to join, in order — Kibana intentionally
// carries the Elasticsearch credential (Kibana fronts Elasticsearch, so there
// is no separate Elasticsearch card).
interface AccessService {
  title: string;
  portal: boolean;
  endpoint?: string;
  creds: string[];
  instances?: boolean;
}

const ACCESS_SERVICES: readonly AccessService[] = [
  { title: "Airflow", portal: true, endpoint: "Airflow", creds: ["Airflow"] },
  { title: "Keycloak", portal: true, endpoint: "Keycloak", creds: ["Keycloak Admin"] },
  { title: "Kibana", portal: true, endpoint: "Kibana", creds: ["Elasticsearch"] },
  { title: "MinIO", portal: true, endpoint: "Minio", creds: ["MinIO"] },
  { title: "RabbitMQ", portal: true, endpoint: "Rabbitmq", creds: ["RabbitMQ"] },
  { title: "SeaweedFS", portal: false, creds: ["SeaweedFS"] },
  { title: "PostgreSQL", portal: false, creds: ["PostgreSQL", "PostgreSQL (superuser)"] },
  { title: "Redis", portal: false, creds: ["Redis"], instances: true },
];

const PORT_FORWARDS: Record<string, { service: string; port: number }> = {
  PostgreSQL: { service: "postgresql-rw", port: 5432 },
  Redis: { service: "redis", port: 6379 },
};

// When a credential drifts from what OSDU is configured with, cimpl emits the
// usable secret under an "(actual)" suffix (e.g. "Elasticsearch (actual)")
// beside a "(OSDU cfg)" MISMATCH row the collector filters out. So a lookup
// falls back to "<name> (actual)" when the bare name isn't present — otherwise
// the only usable secret would be dropped in the drift case.
function findCredential(
  credentials: Map<string, CimplCredential>,
  name: string,
): CimplCredential | undefined {
  return credentials.get(matchKey(name)) ?? credentials.get(matchKey(`${name} (actual)`));
}

// Curated ACCESS grid: one card per known operator-facing service. A portal
// shows a green dot + portal ↗ (from its cimpl endpoint URL); a service shows a
// cyan dot and no link. Credentials join as boxed copy-on-reveal pills. A
// service the cluster doesn't expose at all (no endpoint, no credential, no
// backing internal service) is skipped, so a partial stack shows no phantom
// cards.
function buildAccessCards(info: CimplInfo, stamp: ClusterStamp): CardItem[] {
  const endpoints = new Map<string, CimplEndpoint>();
  for (const e of info.endpoints ?? []) endpoints.set(matchKey(e.name), e);
  const credentials = new Map<string, CimplCredential>();
  for (const c of info.credentials ?? []) credentials.set(matchKey(c.service), c);
  const internal = info.internal_services ?? [];

  const cards: CardItem[] = [];
  for (const svc of ACCESS_SERVICES) {
    const base = matchKey(svc.title);
    const endpoint = svc.portal ? endpoints.get(base) : undefined;

    const fields: FieldItem[] = [];
    for (const name of svc.creds) {
      const cred = findCredential(credentials, name);
      if (cred) fields.push(credentialField(cred, stamp));
    }

    const present =
      Boolean(endpoint) ||
      fields.length > 0 ||
      internal.some((s) => matchKey(s.name).startsWith(base));
    if (!present) continue;

    // A portal is "ok" (green + ↗) only when it has a browser URL; a portal
    // that exists but has no endpoint (gateway/ingress not configured yet) is
    // "warn" — present, with its credential, but not openable — never green.
    // Cluster-local services are always the neutral (cyan) tone.
    const card: CardItem = {
      title: svc.title,
      dot: svc.portal ? (endpoint?.url ? "ok" : "warn") : "neutral",
    };
    if (endpoint?.url) card.href = endpoint.url;
    if (svc.instances) {
      const count = internal.filter((s) => matchKey(baseName(s.name)) === base).length;
      if (count > 1) card.footnote = `${count} instances`;
    }
    const pf = portForwardField(svc, base, internal, endpoints);
    const cardFields = pf ? [pf, ...fields] : fields;
    if (cardFields.length > 0) card.fields = cardFields;
    cards.push(card);
  }
  return cards;
}

function selectOptions(values: readonly string[]): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: value }));
}

function observedContexts(lifecycle: ClusterLifecycle): string[] {
  if (lifecycle.contexts === undefined) return [];
  const seen = new Set<string>();
  const contexts: string[] = [];
  for (const candidate of lifecycle.contexts ?? []) {
    const context = candidate.trim();
    if (!context || seen.has(context)) continue;
    seen.add(context);
    contexts.push(context);
  }
  if (lifecycle.context && !seen.has(lifecycle.context)) contexts.push(lifecycle.context);
  return contexts;
}

// Offer switching only when there's a cimpl-managed target that isn't already
// current — otherwise the picker is a single-option, no-op mutation. Only
// cimpl-managed contexts are valid targets; a non-cimpl context can appear in
// the observed list but must never be offered as a target the guard would
// refuse. Shared by the operating and foreign-context boards.
function switchContextAction(lifecycle: ClusterLifecycle): ActionItem | undefined {
  const { context } = lifecycle;
  const targets = observedContexts(lifecycle).filter((name) => isCimplManagedContext(name));
  if (!targets.some((name) => name !== context)) return undefined;
  return {
    type: "switch-context",
    label: "Switch active context",
    glyph: "⇄",
    // Render the picker always-open so the target select shows directly in the ICC.
    expanded: true,
    payload: {
      observedCurrent: context,
      observedContexts: targets,
      ...(lifecycle.fingerprint ? { fingerprint: lifecycle.fingerprint } : {}),
    },
    fields: [
      {
        name: "target",
        label: "Target context",
        required: true,
        options: selectOptions(targets),
        // Preselect the current only when it's itself a valid target — the
        // canvas rejects a defaultValue outside the option set.
        ...(context && targets.includes(context) ? { defaultValue: context } : {}),
      },
    ],
  };
}

// One provider tab's create-form fields. The provider itself rides the tab's
// static payload (never a field), so azure-only Location/Network exist solely
// on the azure tab. Blank optional fields drop so cimpl's per-provider
// defaults apply.
function createClusterFields(provider: string): ActionField[] {
  const fields: ActionField[] = [
    { name: "env", label: "Environment", placeholder: "dev", half: true },
    {
      // Optional: left blank, cimpl applies its per-provider default — the
      // segmented strip's clear segment carries that as its label.
      name: "profile",
      label: "Profile",
      placeholder: "cimpl default",
      options: selectOptions(CLUSTER_PROFILES),
      segmented: true,
      half: true,
    },
    { name: "partition", label: "Partition", half: true },
    { name: "instance", label: "Instance", half: true },
  ];
  if (provider === "azure") {
    fields.push(
      { name: "location", label: "Location", placeholder: "eastus", half: true },
      {
        // No boolean field kind: a non-required select clears to "" (managed
        // VNet); "private" opts into azure private subnets.
        name: "private",
        label: "Network",
        placeholder: "managed VNet",
        options: [{ value: PRIVATE_NETWORK_TOKEN, label: "private subnets" }],
        half: true,
      },
    );
  }
  return fields;
}

// The provider strip IS the picker: a single-select tabs row (label over
// tagline) where each enabled tab opens its own create form and carries the
// provider as static payload, merged under the collected fields on dispatch.
// aws/gcp stay visible but disabled so the row reads as the real choice set.
// Shared by the empty state and the operating board's no-deployment case so
// the two create surfaces can't drift.
function createClusterTabs(title: string): ActionsSection {
  return {
    kind: "actions",
    title,
    tabs: true,
    items: PROVIDER_CARDS.map((p) =>
      p.enabled
        ? {
            type: "create",
            label: p.label,
            subtitle: p.tagline,
            hint: p.longName,
            payload: { provider: p.id },
            fields: createClusterFields(p.id),
            // The default provider's form opens with the strip, so a bare
            // create is zero clicks away; the submit is the board's one
            // primary (filled) verb without tinting the tab itself.
            defaultOpen: p.id === DEFAULT_CLUSTER_PROVIDER,
            submitLabel: "Create cluster",
            submitTone: "brand",
          }
        : {
            type: "create",
            label: p.label,
            subtitle: p.tagline,
            hint: p.longName,
            disabled: true,
            reason: "coming soon",
          },
    ),
  };
}

/**
 * The "Create cluster" hero frame shared by the empty state and the
 * foreign-context board — the provider tab strip opening per-provider
 * `cimpl up` forms beside a default plan + command preview — so the two create
 * surfaces can't drift. Extra rail sections (a context panel, a switch action)
 * slot in above the plan via `railLead`. Static like every board: the plan and
 * preview reflect the defaults, not live edits (a snapshot can't recompute as
 * the operator types).
 */
function createClusterFrame(railLead: LeafSection[] = []): ColumnsSection {
  const defaults: ClusterCreateInput = { provider: DEFAULT_CLUSTER_PROVIDER };
  const planRows: LeafSection = {
    kind: "rows",
    title: "Cluster plan",
    items: [
      { text: "Name", trailing: deriveClusterName() },
      { text: "Provider", trailing: providerLongName(DEFAULT_CLUSTER_PROVIDER) },
      { text: "Profile", trailing: "cimpl default" },
    ],
  };
  const commandPreview: CardsSection = {
    kind: "cards",
    title: "Command preview",
    items: [
      {
        title: buildCreateCommand(defaults),
        mono: true,
        footnote: "reflects the defaults — edit the form, then Create",
      },
    ],
  };

  return {
    kind: "columns",
    title: "Create cluster",
    columns: [
      { weight: 2.5, sections: [createClusterTabs("Provider")] },
      { weight: 1, sections: [...railLead, planRows, commandPreview] },
    ],
  };
}

/**
 * The create-focused empty state: no cimpl deployment and no current context,
 * so the ICC becomes a provisioning surface — the create frame instead of
 * empty lifecycle rows and inert reconcile/delete.
 */
function buildCreateClusterBoard(): CanvasBoardView {
  return {
    view: "board",
    title: "Cluster ICC",
    header: {
      status: { label: "⚠ No clusters yet", tone: "caution" },
      chip: "no context",
    },
    sections: [createClusterFrame()],
  };
}

/**
 * The foreign-context state: kubectl points at a context that is not
 * cimpl-managed and hosts no cimpl-stack deployment — the case cimpl's own
 * guard refuses. Nothing is broken (the pill is a caution, not an error) and
 * no lifecycle verbs render: cimpl would refuse them, and offering Delete
 * against a foreign cluster misleads. The recourses are the shared create
 * frame and, when a cimpl-managed target exists, switching context; the rail
 * leads with a context panel that carries the guard's explanation.
 */
function buildForeignContextBoard(lifecycle: ClusterLifecycle): CanvasBoardView {
  const context = lifecycle.context ?? "unknown";
  const contextPanel: LeafSection = {
    kind: "rows",
    title: "Current context",
    boxed: true,
    items: [
      {
        glyph: "warn",
        text: context,
        trailing: "not cimpl-managed",
        detail:
          `cimpl manages clusters it provisioned (contexts prefixed ${getCimplPrefixes().join(", ")}) ` +
          "or any cluster running a cimpl-stack deployment. This context is neither, so lifecycle " +
          "verbs are hidden — cimpl would refuse them. Create a new stack, or switch kubectl to a " +
          "cimpl-managed context.",
      },
      {
        glyph: lifecycle.reachable ? "ok" : "error",
        text: "Cluster",
        trailing: lifecycle.reachable ? "reachable" : "unreachable",
      },
    ],
  };
  const railLead: LeafSection[] = [contextPanel];
  const switchAction = switchContextAction(lifecycle);
  if (switchAction) railLead.push({ kind: "actions", items: [switchAction] });

  return {
    view: "board",
    title: "Cluster ICC",
    header: {
      status: { label: "⚠ Not a CIMPL stack", tone: "caution" },
      chip: context,
    },
    sections: [createClusterFrame(railLead)],
  };
}

/**
 * The provisioning state: a create was dispatched and no deployment has
 * appeared yet, so the ICC's whole job is to say so — the plan the operator
 * chose, the elapsed time, the exact command, and where the live output
 * streams. Deliberately verb-free: no create tabs (a second create is refused
 * anyway while the dispatch is in flight), no lifecycle verbs, no
 * switch-context (hopping contexts mid-create is a foot-gun). The first
 * collect that finds the deployment live replaces this board.
 */
function buildProvisioningBoard(marker: CreateMarker, now: number): CanvasBoardView {
  const provisioning: LeafSection = {
    kind: "rows",
    title: "Provisioning",
    boxed: true,
    items: [
      { glyph: "ok", text: "Provider", trailing: providerLongName(marker.provider) },
      { text: "Profile", trailing: marker.profile ?? "cimpl default" },
      ...(marker.env ? [{ text: "Environment", trailing: marker.env }] : []),
      {
        text: "Started",
        trailing: formatAge(markerAgeMs(marker, now)),
        detail:
          "cimpl up provisions the cluster, switches kubectl to its context, and bootstraps " +
          "Flux; services keep converging after it exits. This board flips to the live " +
          "cluster on the first refresh that finds the deployment.",
      },
      { text: "Live output", trailing: "Workflows tab → osdu-cluster-create" },
    ],
  };
  const command: CardsSection = {
    kind: "cards",
    title: "Command",
    items: [{ title: marker.command, mono: true }],
  };
  return {
    view: "board",
    title: "Cluster ICC",
    header: {
      status: { label: "◌ Bootstrapping…", tone: "info" },
      chip: marker.cluster,
    },
    sections: [
      {
        kind: "columns",
        columns: [
          { weight: 1.6, sections: [provisioning] },
          { weight: 1, sections: [command] },
        ],
      },
    ],
  };
}

// The lingering-marker caution: a dispatched create past its provider window
// (or one marked failed) with still no deployment. Prepended to whichever
// markerless board routes, so the operator sees the unresolved attempt before
// the create form invites another.
function createAttentionSection(marker: CreateMarker, now: number): LeafSection {
  const age = formatAge(markerAgeMs(marker, now));
  const failed = marker.status === "failed";
  return {
    kind: "rows",
    boxed: true,
    items: [
      {
        glyph: "warn",
        text: failed
          ? "The last cluster create failed"
          : `A cluster create dispatched ${age} has not produced a deployment`,
        trailing: marker.cluster,
        detail: failed
          ? `\`${marker.command}\` failed${marker.error ? `: ${marker.error}` : ""}. Check the ` +
            "osdu-cluster-create run in the Workflows tab, then create again."
          : `\`${marker.command}\` was dispatched ${age}. The run may still be working or may ` +
            "have failed — check the osdu-cluster-create run in the Workflows tab before " +
            "creating again.",
      },
    ],
  };
}

/**
 * Build the Cluster ICC board from `cimpl info` access data + kubectl-derived
 * lifecycle counts. Pure — no I/O. Routes on the deployment + context signals:
 * a live deployment → the operating board (Bootstrapping while a create
 * marker is still in flight); an in-flight create dispatch with no live
 * deployment → the provisioning board; no info and no context → the create empty state; a
 * cimpl-confirmed-absent deployment on a non-cimpl context → the
 * foreign-context board (create + switch, no cluster verbs); otherwise the
 * operating board (a degraded / unreachable / indeterminately-probed cimpl
 * cluster keeps its lifecycle recourse). A marker past its window prepends a
 * check-the-run caution to whichever board routes. Always emits a valid board.
 */
export function buildClusterBoard(input: ClusterInput): CanvasBoardView {
  if (input.info) return buildOperatingClusterBoard(input);
  const now = input.now ?? Date.now();
  const marker = input.createMarker;
  if (marker && markerInFlight(marker, now)) return buildProvisioningBoard(marker, now);
  const board = routeAbsentDeployment(input);
  if (marker) board.sections = [createAttentionSection(marker, now), ...board.sections];
  return board;
}

function routeAbsentDeployment(input: ClusterInput): CanvasBoardView {
  const { context } = input.lifecycle;
  if (!context) return buildCreateClusterBoard();
  if (input.deployment === "absent" && !isCimplManagedContext(context))
    return buildForeignContextBoard(input.lifecycle);
  return buildOperatingClusterBoard(input);
}

function buildOperatingClusterBoard(input: ClusterInput): CanvasBoardView {
  const { info, lifecycle } = input;
  const { context, reachable, flux, services } = lifecycle;
  const suspended = info?.suspended === true;
  // An in-flight create marker beside a live deployment means the create run
  // is still working — the pill reads Bootstrapping rather than judging health.
  const bootstrapping = Boolean(
    input.createMarker && markerInFlight(input.createMarker, input.now ?? Date.now()),
  );
  const contexts = observedContexts(lifecycle);

  // Cluster-identity stamp carried by every action so onAction can reject a
  // stale board. Context is the guard's required key; fingerprint is added when
  // captured (it catches a recreate under the same context name).
  const stamp: ClusterStamp = {};
  if (context) stamp.context = context;
  if (lifecycle.fingerprint) stamp.fingerprint = lifecycle.fingerprint;

  const lifecycleRows: LeafSection = {
    kind: "rows",
    title: "Lifecycle",
    boxed: true,
    items: [
      { glyph: context ? "ok" : "warn", text: "Context", trailing: context ?? "none" },
      {
        glyph: reachable ? "ok" : "error",
        text: "Cluster",
        trailing: reachable ? (suspended ? "suspended" : "reachable") : "unreachable",
      },
      {
        glyph: reachable ? countTone(flux.ready, flux.total) : "neutral",
        text: "Flux",
        trailing: `${flux.ready}/${flux.total} reconciled`,
      },
      {
        glyph: reachable ? countTone(services.ready, services.total) : "neutral",
        text: "Services",
        trailing: `${services.ready}/${services.total} ready`,
      },
    ],
  };

  const contextRows: LeafSection | undefined =
    contexts.length > 0
      ? {
          kind: "rows",
          title: "Contexts",
          boxed: true,
          items: contexts.map((name) => ({
            glyph: name === context ? ("ok" as const) : ("neutral" as const),
            text: name,
            ...(name === context ? { trailing: "current" } : {}),
          })),
        }
      : undefined;

  // Each action carries the cluster stamp so onAction can refuse to act on a
  // different cluster than the board was built against. Omitted when there's no
  // context to protect (the guard rejects payload-less actions anyway).
  const actionPayload = stamp.context ? stamp : undefined;
  const withPayload = <T extends { type: string }>(item: T) =>
    actionPayload ? { ...item, payload: actionPayload } : item;
  const actionItems: ActionsSection["items"] = [
    withPayload({ type: "reconcile", label: "Reconcile", glyph: "↻" }),
    withPayload(
      suspended
        ? { type: "resume", label: "Resume", glyph: "▶" }
        : { type: "suspend", label: "Suspend", glyph: "⏸" },
    ),
    withPayload({
      type: "delete",
      label: "Delete",
      glyph: "✕",
      tone: "error" as const,
      destructive: true,
    }),
  ];
  const switchAction = switchContextAction(lifecycle);
  if (switchAction) actionItems.push(switchAction);
  const actions: ActionsSection = {
    kind: "actions",
    title: "Actions",
    items: actionItems,
  };

  const sections: BoardSection[] = [
    {
      kind: "columns",
      columns: [
        { weight: 1.4, sections: contextRows ? [lifecycleRows, contextRows] : [lifecycleRows] },
        { weight: 1, sections: [actions] },
      ],
    },
  ];

  // Offer Create only on cimpl's confirmed-absent verdict — never on a merely
  // failed probe, so a transient cimpl failure over a live stack can't surface
  // a bring-up affordance (refuseCreateOverCimpl would refuse it anyway).
  if (!info && input.deployment === "absent") sections.push(createClusterTabs("Create cluster"));

  const access = info ? buildAccessCards(info, stamp) : [];
  if (access.length > 0) {
    sections.push({ kind: "cards", title: "Access", boxed: true, items: access });
  }

  return {
    view: "board",
    title: "Cluster ICC",
    header: {
      status: clusterStatus(lifecycle, !info && input.deployment === "absent", bootstrapping),
      chip: context ?? "no context",
      segments: [
        { label: "Flux", n: flux.ready, tone: countTone(flux.ready, flux.total) },
        { label: "Services", n: services.ready, tone: countTone(services.ready, services.total) },
      ],
    },
    sections,
  };
}
