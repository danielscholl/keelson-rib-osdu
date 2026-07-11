import type { CanvasBoardView, RibExec } from "@keelson/shared";
import {
  CLUSTER_PROFILES,
  CLUSTER_PROVIDERS,
  DEFAULT_CLUSTER_PROVIDER,
  PRIVATE_NETWORK_TOKEN,
} from "./cluster-create.ts";
import { localExec } from "./exec.ts";
import { isCimplManagedContext } from "./kubectl.ts";

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

export interface ClusterLifecycle {
  context: string | null;
  // Stable per-cluster id (kube-system UID) captured at collection time, so a
  // destructive action can be refused if the cluster was recreated under the
  // same context name. Optional/null when unreadable.
  fingerprint?: string | null;
  reachable: boolean;
  flux: { ready: number; total: number };
  services: { ready: number; total: number };
  contexts?: string[];
}

// The cluster-identity stamp every action carries in its payload, so onAction
// can refuse a stale board (context renamed, or recreated under the same name →
// a new fingerprint). Context is required by the guard; fingerprint is matched
// when present.
export type ClusterStamp = { context?: string; fingerprint?: string };

export interface ClusterInput {
  info?: CimplInfo;
  lifecycle: ClusterLifecycle;
}

type Tone = "ok" | "warn" | "error" | "neutral";
type BoardSection = CanvasBoardView["sections"][number];
type ColumnsSection = Extract<BoardSection, { kind: "columns" }>;
type LeafSection = ColumnsSection["columns"][number]["sections"][number];
type ActionsSection = Extract<BoardSection, { kind: "actions" }>;
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

// Fetch `cimpl info` (sanitized) for the Cluster ICC collector and the
// `osdu_cluster` chat tool. `--show-secrets` only enumerates which services have
// a credential; sanitizeCimplInfo discards the password before it returns.
export async function fetchClusterInfo(
  exec: RibExec = localExec(),
): Promise<{ info?: CimplInfo; error?: string }> {
  const res = await exec.runText("cimpl", ["info", "--json", "--show-secrets"], {
    timeoutMs: 30_000,
  });
  if (!res.ok) return { error: res.error };
  try {
    return { info: sanitizeCimplInfo(parseCimplInfoJson(res.data)) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
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
// renders the label verbatim); tone drives the colour.
function clusterStatus(
  lifecycle: ClusterLifecycle,
  suspended: boolean,
): {
  label: string;
  tone: Tone;
} {
  if (!lifecycle.reachable) return { label: "✕ Unreachable", tone: "error" };
  if (suspended) return { label: "⏸ Suspended", tone: "warn" };
  const allReady =
    lifecycle.flux.total > 0 &&
    lifecycle.services.total > 0 &&
    lifecycle.flux.ready === lifecycle.flux.total &&
    lifecycle.services.ready === lifecycle.services.total;
  return allReady ? { label: "✓ Healthy", tone: "ok" } : { label: "⚠ Degraded", tone: "warn" };
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

/**
 * Build the Cluster ICC board from `cimpl info` access data + kubectl-derived
 * lifecycle counts. Pure — no I/O. Always emits a valid board: a degraded
 * (unreachable) cluster still renders the health pill, two-column body, and
 * actions, just with no access cards.
 */
export function buildClusterBoard(input: ClusterInput): CanvasBoardView {
  const { info, lifecycle } = input;
  const { context, reachable, flux, services } = lifecycle;
  const suspended = info?.suspended === true;
  const contexts = observedContexts(lifecycle);
  // Only cimpl-managed contexts are valid switch targets; a non-cimpl current
  // context can appear in `contexts` (for the informational rows) but must never
  // be offered as a target the guard would refuse.
  const switchTargets = contexts.filter((name) => isCimplManagedContext(name));

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
  // Offer Create whenever there is no live CIMPL deployment to manage — keyed on
  // the absence of `cimpl info`, not generic reachability, so a reachable
  // non-CIMPL context still surfaces the only bring-up affordance.
  if (!info) {
    actionItems.push({
      type: "create",
      label: "Create cluster",
      glyph: "+",
      expanded: true,
      fields: [
        {
          name: "provider",
          label: "Provider",
          required: true,
          options: selectOptions(CLUSTER_PROVIDERS),
          defaultValue: DEFAULT_CLUSTER_PROVIDER,
        },
        {
          // Optional: left blank, cimpl applies its per-provider default.
          name: "profile",
          label: "Profile",
          placeholder: "cimpl default",
          options: selectOptions(CLUSTER_PROFILES),
        },
        { name: "env", label: "Environment", placeholder: "dev" },
        { name: "partition", label: "Partition" },
        { name: "instance", label: "Instance" },
        { name: "location", label: "Location (azure)", placeholder: "eastus" },
        {
          // No boolean field kind: a non-required select clears to "" (managed
          // VNet); "private" opts into azure private subnets.
          name: "private",
          label: "Network (azure)",
          placeholder: "managed VNet",
          options: [{ value: PRIVATE_NETWORK_TOKEN, label: "private subnets" }],
        },
      ],
    });
  }
  // Offer switching only when there's a cimpl-managed target that isn't already
  // current — otherwise the picker is a single-option, no-op mutation.
  if (switchTargets.some((name) => name !== context)) {
    actionItems.push({
      type: "switch-context",
      label: "Switch active context",
      glyph: "⇄",
      // Render the picker always-open so the target select shows directly in the ICC.
      expanded: true,
      payload: {
        observedCurrent: context,
        observedContexts: switchTargets,
        ...(stamp.fingerprint ? { fingerprint: stamp.fingerprint } : {}),
      },
      fields: [
        {
          name: "target",
          label: "Target context",
          required: true,
          options: selectOptions(switchTargets),
          // Preselect the current only when it's itself a valid target — the
          // canvas rejects a defaultValue outside the option set.
          ...(context && switchTargets.includes(context) ? { defaultValue: context } : {}),
        },
      ],
    });
  }
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

  const access = info ? buildAccessCards(info, stamp) : [];
  if (access.length > 0) {
    sections.push({ kind: "cards", title: "Access", boxed: true, items: access });
  }

  return {
    view: "board",
    title: "Cluster ICC",
    header: {
      status: clusterStatus(lifecycle, suspended),
      chip: context ?? "no context",
      segments: [
        { label: "Flux", n: flux.ready, tone: countTone(flux.ready, flux.total) },
        { label: "Services", n: services.ready, tone: countTone(services.ready, services.total) },
      ],
    },
    sections,
  };
}
