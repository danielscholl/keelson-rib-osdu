import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  actionGuardError,
  buildClusterBoard,
  type ClusterInput,
  hasRealSecret,
  parseCimplInfoJson,
} from "../src/cluster.ts";
import type { CreateMarker } from "../src/create-marker.ts";

// Fixture credentials carry service + username ONLY — never a password. The
// password is fetched on demand by the reveal-credential action and must never
// appear in the board or a committed fixture.
// Mirrors the raw `cimpl info` shape: the gateway, an Elasticsearch endpoint,
// the MinIO S3 API, SeaweedFS variants, per-namespace Redis, and an OIDC client
// secret all appear here — the Cluster board must curate them down to the
// operator-facing portals + SeaweedFS. Credentials carry service + username
// ONLY (never a password — that's fetched on demand by reveal-credential).
const healthy: ClusterInput = {
  info: {
    suspended: false,
    endpoints: [
      { name: "Gateway (HTTPS)", url: "https://gw.example.test", note: "self-signed cert" },
      { name: "Airflow", url: "https://airflow.example.test", note: "" },
      { name: "Elasticsearch", url: "https://es.example.test", note: "" },
      { name: "Keycloak", url: "https://kc.example.test", note: "" },
      { name: "Kibana", url: "https://kibana.example.test", note: "" },
      { name: "Minio", url: "https://minio.example.test", note: "" },
      { name: "Minio-api", url: "https://minio-api.example.test", note: "" },
      { name: "Rabbitmq", url: "https://rabbitmq.example.test", note: "" },
      { name: "Seaweedfs-s3", url: "https://swfs.example.test", note: "" },
    ],
    internal_services: [
      {
        name: "PostgreSQL",
        address: "postgresql-rw.platform:5432",
        port_forward: "kubectl port-forward -n platform svc/postgresql-rw 15432:5432",
      },
      { name: "Redis", address: "redis.platform:6379" },
      {
        name: "SeaweedFS S3",
        address: "seaweedfs-s3.platform:8333",
        port_forward: "kubectl port-forward -n platform svc/seaweedfs-s3 8333:8333",
      },
      {
        name: "SeaweedFS Admin",
        address: "seaweedfs-master.platform:9333",
        port_forward: "kubectl port-forward -n platform svc/seaweedfs-master 9333:9333",
      },
      { name: "Redis (dataset)", address: "redis-dataset.osdu:6379" },
      { name: "Redis (indexer)", address: "redis-indexer.osdu:6379" },
    ],
    credentials: [
      { service: "PostgreSQL", username: "osdu" },
      { service: "PostgreSQL (superuser)", username: "postgres" },
      { service: "Elasticsearch", username: "elastic" },
      { service: "Keycloak Admin", username: "admin" },
      { service: "RabbitMQ", username: "osdu" },
      { service: "MinIO", username: "osdu" },
      { service: "Redis", username: "" },
      { service: "SeaweedFS", username: "" },
      { service: "OIDC Client", username: "datafier" },
      { service: "Airflow", username: "admin" },
    ],
  },
  lifecycle: {
    context: "cimpl-stack-ms",
    reachable: true,
    flux: { ready: 29, total: 29 },
    services: { ready: 32, total: 32 },
  },
};

type Board = ReturnType<typeof buildClusterBoard>;

function leafSections(b: Board) {
  return b.sections.flatMap((s) =>
    s.kind === "columns" ? s.columns.flatMap((c) => c.sections) : [s],
  );
}

function columnsSection(b: Board) {
  const col = b.sections.find((s) => s.kind === "columns");
  if (col?.kind !== "columns") throw new Error("expected a columns section");
  return col;
}

// The primary actions section — the lifecycle verbs on the operating board, or
// the create tabs on a bring-up board. The context switcher rides its own
// "Active context" section, skipped here.
function actionsOf(b: Board) {
  for (const s of leafSections(b)) {
    if (s.kind === "actions" && s.title !== "Active context") return s;
  }
  throw new Error("expected a primary actions section");
}

function switchBar(b: Board) {
  for (const s of leafSections(b)) {
    if (s.kind === "actions" && s.title === "Active context") return s;
  }
  throw new Error("expected an Active context switcher section");
}

function accessSection(b: Board) {
  const cards = b.sections.find((s) => s.kind === "cards" && s.title === "Access");
  if (cards?.kind !== "cards") throw new Error("expected an Access cards section");
  return cards;
}

function accessByTitle(b: Board) {
  return Object.fromEntries(accessSection(b).items.map((c) => [c.title, c]));
}

describe("buildClusterBoard", () => {
  test("emits a valid canvas board view", () => {
    expect(canvasViewSchema.safeParse(buildClusterBoard(healthy)).success).toBe(true);
  });

  test("a fully reconciled cluster shows a ✓ Ready header status pill + kustomization/service segments", () => {
    const board = buildClusterBoard(healthy);
    expect(board.header?.status).toEqual({ label: "✓ Ready", tone: "ok" });
    expect(board.header?.chip).toBe("cimpl-stack-ms");
    // Health lives in the header pips — the only readout when the region is
    // collapsed. "Flux" reads as "Kustomizations" everywhere.
    expect(board.header?.segments?.map((s) => s.label)).toEqual(["Kustomizations", "Services"]);
  });

  test("a suspended source never dims a fully reconciled cluster — cimpl up pins it on every create", () => {
    const board = buildClusterBoard({ ...healthy, info: { ...healthy.info, suspended: true } });
    // Suspension is the normal pinned-source mode: the pill stays ok and only
    // gains a ⏸ marker. Cluster state lives in the pill, not a lifecycle row.
    expect(board.header?.status).toEqual({ label: "✓ Ready ⏸", tone: "ok" });
  });

  test("a partly-reconciled cluster reads as Degraded (warn)", () => {
    const board = buildClusterBoard({
      ...healthy,
      lifecycle: { ...healthy.lifecycle, services: { ready: 30, total: 32 } },
    });
    expect(board.header?.status).toEqual({ label: "⚠ Degraded", tone: "warn" });
  });

  // The operating board carries no Lifecycle rows: cluster state is the header
  // pill, the counts are the header pips, and the context is the header chip —
  // the rows only said all three a second time.
  test("the operating board drops the Lifecycle rows entirely", () => {
    const board = buildClusterBoard(healthy);
    const titles = leafSections(board)
      .map((s) => ("title" in s ? s.title : undefined))
      .filter(Boolean);
    expect(titles).not.toContain("Lifecycle");
    expect(leafSections(board).some((s) => s.kind === "rows")).toBe(false);
  });

  // With a single context there's no switch target, so the verbs stand alone as
  // the toolbar — a wrapping chip row, not a stack of full-width buttons.
  test("the verbs are a single wrapping actions toolbar when there's no switch target", () => {
    const board = buildClusterBoard(healthy);
    const actions = actionsOf(board);
    expect(actions.title).toBe("Actions");
    expect(actions.wrap).toBe(true);
    expect(actions.items.map((a) => a.type)).toEqual(["reconcile", "suspend", "delete"]);
    // No standalone lifecycle columns section on the operating board anymore.
    expect(board.sections.some((s) => s.kind === "columns")).toBe(false);
  });

  test("with a switch target the toolbar is context dropdown | verb chips, one strip", () => {
    const switchable: ClusterInput = {
      ...healthy,
      lifecycle: {
        ...healthy.lifecycle,
        contexts: ["cimpl-stack-ms", "cimpl-stack-seismic"],
        fingerprint: "uid-1",
      },
    };
    const board = buildClusterBoard(switchable);
    // A single toolbar columns section leads the body: switcher left, verbs right.
    const toolbar = board.sections[0];
    if (toolbar?.kind !== "columns") throw new Error("expected the toolbar columns section");
    const left = toolbar.columns[0]?.sections[0];
    const right = toolbar.columns[1]?.sections[0];
    expect(left?.kind === "actions" && left.title).toBe("Active context");
    expect(left?.kind === "actions" && left.items.map((a) => a.type)).toEqual(["switch-context"]);
    expect(right?.kind === "actions" && right.title).toBe("Actions");
    expect(right?.kind === "actions" && right.items.map((a) => a.type)).toEqual([
      "reconcile",
      "suspend",
      "delete",
    ]);
    // The verbs toolbar and the switcher are distinct sections.
    expect(actionsOf(board).items.map((a) => a.type)).toEqual(["reconcile", "suspend", "delete"]);
    expect(switchBar(board).items.map((a) => a.type)).toEqual(["switch-context"]);
  });

  test("access cards render as a boxed auto-fit grid shelf (reveal pills, side by side)", () => {
    const board = buildClusterBoard(healthy);
    expect(accessSection(board).boxed).toBe(true);
    expect(accessSection(board).grid).toBe(true);
  });

  test("a running cluster offers Reconcile (non-destructive) + Suspend + a destructive Delete", () => {
    const actions = actionsOf(buildClusterBoard(healthy));
    const byType = Object.fromEntries(actions.items.map((a) => [a.type, a]));
    expect(byType.reconcile?.glyph).toBe("↻");
    expect(byType.reconcile?.destructive).toBeUndefined();
    expect(byType.suspend?.glyph).toBe("⏸");
    expect(byType.suspend?.destructive).toBeUndefined();
    expect(byType.delete?.destructive).toBe(true);
    expect(byType.delete?.tone).toBe("error");
    expect(byType.resume).toBeUndefined();
  });

  test("a suspended cluster offers Resume instead of Suspend, and still Delete", () => {
    const board = buildClusterBoard({ ...healthy, info: { ...healthy.info, suspended: true } });
    const types = actionsOf(board).items.map((a) => a.type);
    expect(types).toContain("resume");
    expect(types).not.toContain("suspend");
    expect(types).toContain("delete");
  });

  test("ACCESS is curated to the operator-facing services, in order", () => {
    const titles = accessSection(buildClusterBoard(healthy)).items.map((c) => c.title);
    // The four portals you open, plus SeaweedFS. PostgreSQL and Redis are
    // credential-only (no link) and dropped from the shelf.
    expect(titles).toEqual(["Airflow", "Keycloak", "Kibana", "RabbitMQ", "SeaweedFS"]);
  });

  test("ACCESS drops the gateway, API-only endpoints, variants, OIDC client, and credential-only PostgreSQL/Redis", () => {
    const titles = accessSection(buildClusterBoard(healthy)).items.map((c) => c.title);
    for (const dropped of [
      "Gateway (HTTPS)",
      "Elasticsearch",
      "Minio-api",
      "Seaweedfs-s3",
      "SeaweedFS S3",
      "SeaweedFS Admin",
      "OIDC Client",
      "PostgreSQL",
      "Redis",
    ]) {
      expect(titles).not.toContain(dropped);
    }
  });

  test("ACCESS portals render as green cards with a portal link", () => {
    const byTitle = accessByTitle(buildClusterBoard(healthy));
    for (const ui of ["Airflow", "Keycloak", "Kibana", "RabbitMQ"]) {
      expect(byTitle[ui]?.dot).toBe("ok");
      expect(byTitle[ui]?.href).toBeTruthy();
    }
    expect(byTitle.Airflow?.href).toBe("https://airflow.example.test");
  });

  test("a portal with no endpoint (gateway not configured) is warn, not ok, and keeps its credential", () => {
    const noGateway: ClusterInput = {
      ...healthy,
      info: { ...healthy.info, endpoints: [] },
    };
    const kc = accessByTitle(buildClusterBoard(noGateway)).Keycloak;
    expect(kc?.dot).toBe("warn");
    expect(kc?.href).toBeUndefined();
    // The credential is still surfaced even though the browser URL is gone.
    expect((kc?.fields ?? []).some((f) => f.copyAction)).toBe(true);
  });

  test("SeaweedFS is a cyan service card with no portal link", () => {
    const swfs = accessByTitle(buildClusterBoard(healthy)).SeaweedFS;
    expect(swfs?.dot).toBe("neutral");
    expect(swfs?.href).toBeUndefined();
  });

  test("ACCESS internal services show reveal-only credentials and no port-forward command", () => {
    const byTitle = accessByTitle(buildClusterBoard(healthy));
    expect(byTitle.SeaweedFS?.dot).toBe("neutral");
    const fields = byTitle.SeaweedFS?.fields ?? [];
    // No inline shell command: the rib is sidecar-free and no longer surfaces a
    // copyable port-forward. Only the reveal-on-copy credentials remain.
    expect(fields.some((f) => f.copyable)).toBe(false);
    const credentials = fields.filter((f) => f.copyAction);
    expect(credentials).toHaveLength(1);
    expect(credentials.every((f) => f.copyable !== true)).toBe(true);
  });

  test("a service with neither a portal link nor a credential is dropped (no empty card)", () => {
    const noSeaweedCred: ClusterInput = {
      ...healthy,
      info: {
        ...healthy.info,
        credentials: (healthy.info?.credentials ?? []).filter((c) => c.service !== "SeaweedFS"),
      },
    };
    const titles = accessSection(buildClusterBoard(noSeaweedCred)).items.map((c) => c.title);
    // SeaweedFS is not a portal and now has no credential, so it renders nothing
    // rather than an empty title-only card.
    expect(titles).not.toContain("SeaweedFS");
  });

  test("credentials join onto their service card as copy-on-reveal fields (never a password)", () => {
    const byTitle = accessByTitle(buildClusterBoard(healthy));
    // Curated join: the "Keycloak Admin" credential lands on the Keycloak card.
    const kcCred = (byTitle.Keycloak?.fields ?? []).find((f) => f.copyAction);
    expect(kcCred?.copyAction).toEqual({
      type: "reveal-credential",
      payload: { service: "Keycloak Admin", context: "cimpl-stack-ms" },
    });
    // Cross-service join: Kibana fronts Elasticsearch, so the elastic credential
    // lands on the Kibana card (there is no separate Elasticsearch card).
    const kibanaCred = (byTitle.Kibana?.fields ?? []).find((f) => f.copyAction);
    expect(kibanaCred?.copyAction?.payload).toEqual({
      service: "Elasticsearch",
      context: "cimpl-stack-ms",
    });
    // Credential fields show the username (or "password" when none) — never a
    // mask and never the secret, which is fetched on copy via the action.
    const credValues: string[] = [];
    for (const card of accessSection(buildClusterBoard(healthy)).items) {
      for (const field of card.fields ?? []) {
        if (field.copyAction) credValues.push(String(field.value));
      }
    }
    // RabbitMQ → osdu, Keycloak → admin, Kibana → elastic; SeaweedFS has no
    // username so its reveal pill reads "password".
    expect(credValues).toContain("osdu");
    expect(credValues).toContain("admin");
    expect(credValues).toContain("elastic");
    expect(credValues).toContain("password");
    expect(credValues).not.toContain("••••••");
  });

  test("Kibana picks up the Elasticsearch '(actual)' credential under password drift", () => {
    // cimpl emits the usable secret as "Elasticsearch (actual)" and filters out
    // the "(OSDU cfg)" MISMATCH row — Kibana must still surface a reveal pill.
    const drift: ClusterInput = {
      ...healthy,
      info: {
        ...healthy.info,
        credentials: [
          ...(healthy.info?.credentials ?? []).filter((c) => c.service !== "Elasticsearch"),
          { service: "Elasticsearch (actual)", username: "elastic" },
        ],
      },
    };
    const kibanaCred = (accessByTitle(buildClusterBoard(drift)).Kibana?.fields ?? []).find(
      (f) => f.copyAction,
    );
    expect(kibanaCred?.value).toBe("elastic");
    // The payload keeps cimpl's exact service name so the reveal round-trips.
    expect(kibanaCred?.copyAction?.payload).toEqual({
      service: "Elasticsearch (actual)",
      context: "cimpl-stack-ms",
    });
  });

  test("SeaweedFS carries its (usernameless) credential as a reveal pill", () => {
    const swfs = accessByTitle(buildClusterBoard(healthy)).SeaweedFS;
    const cred = (swfs?.fields ?? []).find((f) => f.copyAction);
    expect(cred?.value).toBe("password");
    expect(cred?.copyAction?.payload).toEqual({ service: "SeaweedFS", context: "cimpl-stack-ms" });
  });

  test("actions carry the board's context so onAction can guard against drift", () => {
    for (const action of actionsOf(buildClusterBoard(healthy)).items) {
      expect(action.payload).toEqual({ context: "cimpl-stack-ms" });
    }
  });

  const noCluster: ClusterInput = {
    lifecycle: {
      context: null,
      reachable: false,
      flux: { ready: 0, total: 0 },
      services: { ready: 0, total: 0 },
      contexts: [],
    },
  };

  test("no cluster + no context leads with the create surface, not empty lifecycle rows", () => {
    const board = buildClusterBoard(noCluster);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    // Caution "No clusters yet", not a red error pill.
    expect(board.header?.status).toEqual({ label: "⚠ No clusters yet", tone: "caution" });
    // One "Create cluster" frame: provider tabs beside the plan rail — only
    // create actions, no inert reconcile/suspend/delete to operate.
    expect(columnsSection(board).title).toBe("Create cluster");
    expect(actionsOf(board).items.every((a) => a.type === "create")).toBe(true);
    // No guard stamp (no cluster to guard yet): the payload names the provider only.
    expect(actionsOf(board).items[0]?.payload).toEqual({ provider: "kind" });
  });

  test("the provider strip is a single-select tabs picker with aws/gcp disabled as Soon", () => {
    const tabs = actionsOf(buildClusterBoard(noCluster));
    expect(tabs.tabs).toBe(true);
    expect(tabs.title).toBe("Provider");
    expect(tabs.items.map((a) => a.label)).toEqual(["kind", "azure", "aws", "gcp"]);
    const byLabel = Object.fromEntries(tabs.items.map((a) => [a.label, a]));
    expect(byLabel.kind?.disabled).toBeUndefined();
    expect(byLabel.azure?.disabled).toBeUndefined();
    expect(byLabel.aws?.disabled).toBe(true);
    expect(byLabel.aws?.reason).toBe("coming soon");
    expect(byLabel.gcp?.disabled).toBe(true);
    expect(byLabel.gcp?.reason).toBe("coming soon");
    // The tagline rides the tab as its subtitle line; a disabled tab opens no form.
    expect(byLabel.kind?.subtitle).toBe("Fast · no cloud cost");
    expect(byLabel.aws?.fields).toBeUndefined();
  });

  test("each enabled tab carries its provider as static payload and provider-scoped fields", () => {
    const byLabel = Object.fromEntries(
      actionsOf(buildClusterBoard(noCluster)).items.map((a) => [a.label, a]),
    );
    expect(byLabel.kind?.payload).toEqual({ provider: "kind" });
    expect(byLabel.kind?.fields?.map((f) => f.name)).toEqual([
      "env",
      "profile",
      "partition",
      "instance",
    ]);
    // The azure-only Location/Network fields exist solely on the azure tab.
    expect(byLabel.azure?.payload).toEqual({ provider: "azure" });
    expect(byLabel.azure?.fields?.map((f) => f.name)).toEqual([
      "env",
      "profile",
      "partition",
      "instance",
      "location",
      "private",
    ]);
    // The submit is the verb, not the tab's provider name.
    expect(byLabel.kind?.submitLabel).toBe("Create cluster");
    expect(byLabel.azure?.submitLabel).toBe("Create cluster");
  });

  test("the default provider's form opens with the strip and submits as the primary verb", () => {
    const byLabel = Object.fromEntries(
      actionsOf(buildClusterBoard(noCluster)).items.map((a) => [a.label, a]),
    );
    // Only kind (the bare `cimpl up` default) seeds the open slot.
    expect(byLabel.kind?.defaultOpen).toBe(true);
    expect(byLabel.azure?.defaultOpen).toBe(false);
    expect(byLabel.aws?.defaultOpen).toBeUndefined();
    // The filled submit never tints the tab: submitTone, not tone.
    expect(byLabel.kind?.submitTone).toBe("brand");
    expect(byLabel.kind?.tone).toBeUndefined();
    expect(byLabel.azure?.submitTone).toBe("brand");
  });

  test("the create form reads as two-up rows with a segmented Profile", () => {
    const byLabel = Object.fromEntries(
      actionsOf(buildClusterBoard(noCluster)).items.map((a) => [a.label, a]),
    );
    for (const tab of [byLabel.kind, byLabel.azure]) {
      expect(tab?.fields?.every((f) => f.half === true)).toBe(true);
    }
    const profile = byLabel.kind?.fields?.find((f) => f.name === "profile");
    expect(profile?.segmented).toBe(true);
    // The clear segment wears the cimpl-default placeholder as its label.
    expect(profile?.placeholder).toBe("cimpl default");
    expect(profile?.required).toBeUndefined();
  });

  test("a default cluster plan + truthful command preview accompany the form", () => {
    const sections = leafSections(buildClusterBoard(noCluster));
    const plan = sections.find((s) => s.kind === "rows" && s.title === "Cluster plan");
    if (plan?.kind !== "rows") throw new Error("expected a Cluster plan rows section");
    expect(plan.items.map((r) => [r.text, r.trailing])).toEqual([
      // Bare `cimpl up` names the cluster cimpl-stack — no default env applies.
      ["Name", "cimpl-stack"],
      ["Provider", "Local KinD cluster"],
      ["Profile", "cimpl default"],
    ]);
    const preview = sections.find((s) => s.kind === "cards" && s.title === "Command preview");
    if (preview?.kind !== "cards") throw new Error("expected a Command preview card");
    // Mirrors what osdu-cluster-create actually runs for the defaults.
    expect(preview.items[0]?.title).toBe("cimpl up --provider kind");
    expect(preview.items[0]?.mono).toBe(true);
  });

  test("parseCimplInfoJson skips a Rich/log preamble before the JSON object", () => {
    const withPreamble = '[warning]Gateway domain not configured[/warning]\n{"suspended":false}';
    expect(parseCimplInfoJson(withPreamble)).toEqual({ suspended: false });
    expect(parseCimplInfoJson('{"suspended":true}')).toEqual({ suspended: true });
  });

  test("actionGuardError proceeds only when context and fingerprint both match", () => {
    // Context-only stamp (no fingerprint captured) falls back to name matching.
    expect(actionGuardError({ context: "ctx-a" }, "ctx-a", "uid-1")).toBeNull();
    expect(actionGuardError({ context: "ctx-a" }, "ctx-b", "uid-1")).toMatch(/context changed/);
    expect(actionGuardError({ context: "ctx-a" }, null, null)).toMatch(/context changed/);
    // A stale board built with no captured context must not act on whatever is
    // current now — including the payload-less actions above.
    expect(actionGuardError(undefined, "ctx-a", "uid-1")).toMatch(/no cluster context/);
    expect(actionGuardError({ context: "" }, "ctx-a", "uid-1")).toMatch(/no cluster context/);
    // Same context name, different cluster (recreated) → refuse on fingerprint.
    expect(
      actionGuardError({ context: "ctx-a", fingerprint: "uid-1" }, "ctx-a", "uid-1"),
    ).toBeNull();
    expect(actionGuardError({ context: "ctx-a", fingerprint: "uid-1" }, "ctx-a", "uid-2")).toMatch(
      /recreated/,
    );
  });

  test("a captured fingerprint rides along in action and credential payloads", () => {
    const board = buildClusterBoard({
      ...healthy,
      lifecycle: { ...healthy.lifecycle, fingerprint: "uid-1" },
    });
    for (const action of actionsOf(board).items) {
      expect(action.payload).toEqual({ context: "cimpl-stack-ms", fingerprint: "uid-1" });
    }
    const cred = (accessByTitle(board).Keycloak?.fields ?? []).find((f) => f.copyAction);
    expect(cred?.copyAction?.payload).toEqual({
      service: "Keycloak Admin",
      context: "cimpl-stack-ms",
      fingerprint: "uid-1",
    });
  });

  test("hasRealSecret rejects cimpl placeholders, advisories, empty, and non-strings", () => {
    expect(hasRealSecret("s3cr3t")).toBe(true);
    expect(hasRealSecret("n/a")).toBe(false);
    expect(hasRealSecret("[dim]n/a[/dim]")).toBe(false);
    // Credential-mismatch advisory — would not authenticate if copied.
    expect(hasRealSecret("[warning]hunter2 (MISMATCH)[/warning]")).toBe(false);
    expect(hasRealSecret("hunter2 (MISMATCH)")).toBe(false);
    expect(hasRealSecret("")).toBe(false);
    expect(hasRealSecret(undefined)).toBe(false);
    expect(hasRealSecret(null)).toBe(false);
  });

  test("a known context that went unreachable keeps the operating board + lifecycle recourse", () => {
    const board = buildClusterBoard({
      deployment: "absent",
      lifecycle: {
        context: "cimpl-stack-ms",
        reachable: false,
        flux: { ready: 0, total: 0 },
        services: { ready: 0, total: 0 },
      },
    });
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    // Cluster state is the header pill now (no lifecycle row repeats it).
    expect(board.header?.status).toEqual({ label: "✕ Unreachable", tone: "error" });
    // Reconcile/Delete stay so a dead-but-known cluster isn't stranded.
    const types = actionsOf(board).items.map((a) => a.type);
    expect(types).toContain("reconcile");
    expect(types).toContain("delete");
    // No access cards when cimpl info is absent.
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
  });

  test("a cimpl context without a deployment reads No deployment, withholds the verbs, and offers the provider tabs", () => {
    const board = buildClusterBoard({
      deployment: "absent",
      lifecycle: {
        context: "kind-cimpl-lab",
        reachable: true,
        flux: { ready: 0, total: 0 },
        services: { ready: 0, total: 0 },
      },
    });
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    // A reachable cimpl cluster with nothing on it is absence, not an outage.
    expect(board.header?.status).toEqual({ label: "⚠ No deployment", tone: "warn" });
    // The lifecycle verbs act on nothing here — Reconcile/Suspend no-op and
    // Delete's live-context re-verify refuses — so they're withheld entirely.
    const verbs = leafSections(board).flatMap((s) =>
      s.kind === "actions" ? s.items.map((a) => a.type) : [],
    );
    expect(verbs).not.toContain("reconcile");
    expect(verbs).not.toContain("suspend");
    expect(verbs).not.toContain("delete");
    // Create is the recourse — its own full-width tabs strip, same as the empty state.
    const tabs = board.sections.find((s) => s.kind === "actions" && s.title === "Create cluster");
    if (tabs?.kind !== "actions") throw new Error("expected a create tabs section");
    expect(tabs.tabs).toBe(true);
    expect(tabs.items.map((a) => a.label)).toEqual(["kind", "azure", "aws", "gcp"]);
  });

  test("a live cimpl deployment offers no create surface at all", () => {
    const board = buildClusterBoard(healthy);
    expect(actionsOf(board).items.map((a) => a.type)).not.toContain("create");
    // The verb toolbar is always present; what's absent is any create action.
    expect(
      leafSections(board).some(
        (s) => s.kind === "actions" && s.items.some((a) => a.type === "create"),
      ),
    ).toBe(false);
  });

  const foreign: ClusterInput = {
    deployment: "absent",
    lifecycle: {
      context: "osdu-mvp-aks",
      reachable: true,
      flux: { ready: 0, total: 0 },
      services: { ready: 0, total: 0 },
      contexts: [],
    },
  };

  function allActions(b: Board) {
    return leafSections(b).flatMap((s) => (s.kind === "actions" ? s.items : []));
  }

  test("a reachable non-cimpl context reads Not a CIMPL stack, not Unreachable", () => {
    const board = buildClusterBoard(foreign);
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status).toEqual({ label: "⚠ Not a CIMPL stack", tone: "caution" });
    expect(board.header?.chip).toBe("osdu-mvp-aks");
    // Flux/Services counts are stack concepts — no red 0/0 segments here.
    expect(board.header?.segments).toBeUndefined();
  });

  test("a foreign context offers no lifecycle verbs — create is the only recourse", () => {
    const board = buildClusterBoard(foreign);
    expect(allActions(board).every((a) => a.type === "create")).toBe(true);
    // The create hero is the same frame as the empty state, default form open.
    expect(columnsSection(board).title).toBe("Create cluster");
    const tabs = actionsOf(board);
    expect(tabs.tabs).toBe(true);
    expect(tabs.items.find((a) => a.label === "kind")?.defaultOpen).toBe(true);
  });

  test("the foreign board's rail leads with the current-context panel", () => {
    const board = buildClusterBoard(foreign);
    const panel = columnsSection(board).columns[1]?.sections[0];
    if (panel?.kind !== "rows") throw new Error("expected the context panel");
    expect(panel.title).toBe("Current context");
    expect(panel.items[0]?.text).toBe("osdu-mvp-aks");
    expect(panel.items[0]?.trailing).toBe("not cimpl-managed");
    // The CLI guard's explanation rides the row's on-demand disclosure.
    expect(panel.items[0]?.detail).toContain("cimpl-stack deployment");
    expect(panel.items[1]).toMatchObject({ glyph: "ok", text: "Cluster", trailing: "reachable" });
  });

  test("an unreachable foreign context keeps the caution pill but reports the dead cluster", () => {
    const board = buildClusterBoard({
      ...foreign,
      lifecycle: { ...foreign.lifecycle, reachable: false },
    });
    expect(board.header?.status).toEqual({ label: "⚠ Not a CIMPL stack", tone: "caution" });
    const panel = columnsSection(board).columns[1]?.sections[0];
    if (panel?.kind !== "rows") throw new Error("expected the context panel");
    expect(panel.items[1]).toMatchObject({ glyph: "error", trailing: "unreachable" });
  });

  test("the foreign board offers switch-context when a cimpl-managed target exists", () => {
    const board = buildClusterBoard({
      ...foreign,
      lifecycle: { ...foreign.lifecycle, contexts: ["cimpl-a"], fingerprint: "uid-9" },
    });
    const switchAction = allActions(board).find((a) => a.type === "switch-context");
    expect(switchAction?.payload).toEqual({
      observedCurrent: "osdu-mvp-aks",
      observedContexts: ["cimpl-a"],
      fingerprint: "uid-9",
    });
    expect(switchAction?.fields?.[0]?.options?.map((o) => o.value)).toEqual(["cimpl-a"]);
    // Every other action is still a create tab — never reconcile/suspend/delete.
    const others = allActions(board).filter((a) => a.type !== "switch-context");
    expect(others.every((a) => a.type === "create")).toBe(true);
  });

  test("an indeterminate cimpl probe keeps the operating board — new states need confirmed absence", () => {
    // Same foreign-named context, but the probe never completed (deployment
    // omitted → unknown): a transient cimpl failure over a live stack must not
    // hide the lifecycle recourse or claim absence.
    const board = buildClusterBoard({ lifecycle: foreign.lifecycle });
    expect(board.header?.status).toEqual({ label: "⚠ Degraded", tone: "warn" });
    const types = actionsOf(board).items.map((a) => a.type);
    expect(types).toContain("reconcile");
    expect(types).toContain("delete");
    // …and bring-up is not offered over an unconfirmed absence.
    expect(
      leafSections(board).some(
        (s) => s.kind === "actions" && s.items.some((a) => a.type === "create"),
      ),
    ).toBe(false);
  });

  const NOW = Date.parse("2026-07-13T12:00:00Z");
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
  const dispatched: CreateMarker = {
    status: "dispatched",
    provider: "kind",
    cluster: "cimpl-stack",
    command: "cimpl up --provider kind",
    startedAt: minutesAgo(2),
  };

  test("an in-flight create renders the provisioning board — plan, elapsed, command, no verbs", () => {
    const board = buildClusterBoard({ ...foreign, createMarker: dispatched, now: NOW });
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status).toEqual({ label: "◌ Bootstrapping…", tone: "info" });
    expect(board.header?.chip).toBe("cimpl-stack");
    expect(board.header?.segments).toBeUndefined();
    // Nothing to mis-click while cimpl works: no create tabs, no lifecycle verbs.
    expect(allActions(board)).toEqual([]);
    const rows = leafSections(board).find((s) => s.kind === "rows");
    if (rows?.kind !== "rows") throw new Error("expected the provisioning rows");
    expect(rows.items.map((r) => [r.text, r.trailing])).toEqual([
      ["Provider", "Local KinD cluster"],
      ["Profile", "cimpl default"],
      ["Started", "2m ago"],
      ["Live output", "Workflows tab → osdu-cluster-create"],
    ]);
    const command = leafSections(board).find((s) => s.kind === "cards");
    if (command?.kind !== "cards") throw new Error("expected the command card");
    expect(command.items[0]?.title).toBe("cimpl up --provider kind");
    expect(command.items[0]?.mono).toBe(true);
  });

  test("the provisioning board carries the chosen env in its name and rows", () => {
    const marker: CreateMarker = {
      ...dispatched,
      provider: "azure",
      profile: "graduated",
      env: "lab",
      cluster: "cimpl-stack-lab",
      command: "cimpl up --provider azure --profile graduated --env lab",
      startedAt: minutesAgo(20),
    };
    // 20 minutes in: past the kind window but well inside the cloud one.
    const board = buildClusterBoard({ ...foreign, createMarker: marker, now: NOW });
    expect(board.header?.status?.label).toBe("◌ Bootstrapping…");
    expect(board.header?.chip).toBe("cimpl-stack-lab");
    const rows = leafSections(board).find((s) => s.kind === "rows");
    if (rows?.kind !== "rows") throw new Error("expected the provisioning rows");
    expect(rows.items.map((r) => r.trailing)).toEqual([
      "Azure Kubernetes Service",
      "graduated",
      "lab",
      "20m ago",
      "Workflows tab → osdu-cluster-create",
    ]);
  });

  test("the provisioning board also replaces the no-context create state", () => {
    const board = buildClusterBoard({ ...noCluster, createMarker: dispatched, now: NOW });
    expect(board.header?.status?.label).toBe("◌ Bootstrapping…");
    expect(allActions(board)).toEqual([]);
  });

  test("a live deployment outranks any marker — the operating board renders uncautioned", () => {
    // Full convergence wins even mid-run: the create is finishing up, and the
    // board should already read Ready rather than hold Bootstrapping.
    const board = buildClusterBoard({ ...healthy, createMarker: dispatched, now: NOW });
    expect(board.header?.status).toEqual({ label: "✓ Ready", tone: "ok" });
    // The operating board, not the provisioning one — its Access shelf is present.
    expect(board.sections.some((s) => s.kind === "cards" && s.title === "Access")).toBe(true);
  });

  test("a live-but-converging deployment reads Bootstrapping while the create run is in flight", () => {
    const board = buildClusterBoard({
      ...healthy,
      createMarker: dispatched,
      now: NOW,
      lifecycle: {
        ...healthy.lifecycle,
        flux: { ready: 2, total: 22, stalled: 0 },
        services: { ready: 5, total: 32, stalled: 0 },
      },
    });
    expect(board.header?.status).toEqual({ label: "◌ Bootstrapping 2/22", tone: "info" });
    // A degraded read mid-run is expected, not a health verdict — the run
    // itself settles a failure through the marker.
    const stalledUnknown = buildClusterBoard({
      ...healthy,
      createMarker: dispatched,
      now: NOW,
      lifecycle: {
        ...healthy.lifecycle,
        flux: { ready: 2, total: 22 },
        services: { ready: 0, total: 0 },
      },
    });
    expect(stalledUnknown.header?.status).toEqual({ label: "◌ Bootstrapping 2/22", tone: "info" });
    // Once the marker settles (window elapsed), the ordinary ladder resumes.
    const settled = buildClusterBoard({
      ...healthy,
      createMarker: { ...dispatched, startedAt: minutesAgo(20) },
      now: NOW,
      lifecycle: {
        ...healthy.lifecycle,
        flux: { ready: 2, total: 22, stalled: 0 },
        services: { ready: 5, total: 32, stalled: 0 },
      },
    });
    expect(settled.header?.status).toEqual({ label: "◌ Reconciling 2/22", tone: "info" });
  });

  test("a dispatched marker past its window prepends the check-the-run caution", () => {
    const stale: CreateMarker = { ...dispatched, startedAt: minutesAgo(20) };
    const board = buildClusterBoard({ ...foreign, createMarker: stale, now: NOW });
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    // The foreign board still routes beneath it — create stays reachable.
    expect(board.header?.status?.label).toBe("⚠ Not a CIMPL stack");
    const caution = board.sections[0];
    if (caution?.kind !== "rows") throw new Error("expected the caution rows first");
    expect(caution.items[0]?.glyph).toBe("warn");
    expect(caution.items[0]?.text).toContain("has not produced a deployment");
    expect(caution.items[0]?.trailing).toBe("cimpl-stack");
    expect(caution.items[0]?.detail).toContain("osdu-cluster-create");
    expect(board.sections.some((s) => s.kind === "columns")).toBe(true);
  });

  test("a failed marker names the failure and keeps the run pointer", () => {
    const failed: CreateMarker = {
      ...dispatched,
      status: "failed",
      startedAt: minutesAgo(3),
      error: "cimpl up exited 2",
    };
    const board = buildClusterBoard({ ...foreign, createMarker: failed, now: NOW });
    const caution = board.sections[0];
    if (caution?.kind !== "rows") throw new Error("expected the caution rows first");
    expect(caution.items[0]?.text).toBe("The last cluster create failed");
    expect(caution.items[0]?.detail).toContain("cimpl up exited 2");
    expect(caution.items[0]?.detail).toContain("osdu-cluster-create");
  });

  test("an incomplete reconcile with nothing stalled reads Reconciling with counts, not Degraded", () => {
    const board = buildClusterBoard({
      ...healthy,
      lifecycle: {
        ...healthy.lifecycle,
        flux: { ready: 17, total: 22, stalled: 0 },
        services: { ready: 30, total: 32, stalled: 0 },
      },
    });
    expect(board.header?.status).toEqual({ label: "◌ Reconciling 17/22", tone: "info" });
    // Flux done, services trailing: the counts follow the lagging signal.
    const servicesTrailing = buildClusterBoard({
      ...healthy,
      lifecycle: {
        ...healthy.lifecycle,
        flux: { ready: 22, total: 22, stalled: 0 },
        services: { ready: 30, total: 32, stalled: 0 },
      },
    });
    expect(servicesTrailing.header?.status).toEqual({ label: "◌ Reconciling 30/32", tone: "info" });
  });

  test("a stalled resource makes an incomplete reconcile Degraded", () => {
    const board = buildClusterBoard({
      ...healthy,
      lifecycle: {
        ...healthy.lifecycle,
        flux: { ready: 17, total: 22, stalled: 1 },
        services: { ready: 30, total: 32, stalled: 0 },
      },
    });
    expect(board.header?.status).toEqual({ label: "⚠ Degraded", tone: "warn" });
  });

  test("stalled counts never soften a fully-ready or stalled-unknown pill", () => {
    const ready = buildClusterBoard({
      ...healthy,
      lifecycle: {
        ...healthy.lifecycle,
        flux: { ready: 29, total: 29, stalled: 0 },
        services: { ready: 32, total: 32, stalled: 0 },
      },
    });
    expect(ready.header?.status).toEqual({ label: "✓ Ready", tone: "ok" });
    // One side collected without stalled (a degraded read) → Degraded, not
    // Reconciling: an unknown can't vouch for clean convergence.
    const unknown = buildClusterBoard({
      ...healthy,
      lifecycle: {
        ...healthy.lifecycle,
        flux: { ready: 17, total: 22, stalled: 0 },
        services: { ready: 30, total: 32 },
      },
    });
    expect(unknown.header?.status).toEqual({ label: "⚠ Degraded", tone: "warn" });
  });
});
