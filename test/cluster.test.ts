import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import {
  actionGuardError,
  buildClusterBoard,
  type ClusterInput,
  hasRealSecret,
  parseCimplInfoJson,
} from "../src/cluster.ts";

// Fixture credentials carry service + username ONLY — never a password. The
// password is fetched on demand by the reveal-credential action and must never
// appear in the board or a committed fixture.
const healthy: ClusterInput = {
  info: {
    suspended: false,
    endpoints: [
      { name: "Airflow", url: "https://airflow.example.test", note: "self-signed cert" },
      { name: "Keycloak", url: "https://kc.example.test", note: "" },
    ],
    internal_services: [
      { name: "PostgreSQL", address: "postgresql-rw.platform:5432", port_forward: "kubectl ..." },
      { name: "Redis", address: "redis.platform:6379", port_forward: "kubectl ..." },
      { name: "Redis (dataset)", address: "redis-dataset.osdu:6379", port_forward: "kubectl ..." },
      { name: "Redis (indexer)", address: "redis-indexer.osdu:6379", port_forward: "kubectl ..." },
    ],
    credentials: [
      { service: "PostgreSQL", username: "osdu" },
      { service: "PostgreSQL (superuser)", username: "postgres" },
      { service: "Keycloak Admin", username: "admin" },
      { service: "Redis", username: "" },
      { service: "OIDC Client", username: "datafier" },
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

function columnsSection(b: Board) {
  const col = b.sections.find((s) => s.kind === "columns");
  if (col?.kind !== "columns") throw new Error("expected a columns section");
  return col;
}

function rowsOf(b: Board) {
  for (const column of columnsSection(b).columns) {
    for (const s of column.sections) if (s.kind === "rows") return s;
  }
  throw new Error("expected a rows section in the columns body");
}

function actionsOf(b: Board) {
  for (const column of columnsSection(b).columns) {
    for (const s of column.sections) if (s.kind === "actions") return s;
  }
  throw new Error("expected an actions section in the columns body");
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

  test("a healthy cluster shows a ✓ Healthy header status pill + flux/service segments", () => {
    const board = buildClusterBoard(healthy);
    expect(board.header?.status).toEqual({ label: "✓ Healthy", tone: "ok" });
    expect(board.header?.chip).toBe("cimpl-stack-ms");
    expect(board.header?.segments?.map((s) => s.label)).toEqual(["Flux", "Services"]);
  });

  test("a partly-reconciled cluster reads as Degraded (warn)", () => {
    const board = buildClusterBoard({
      ...healthy,
      lifecycle: { ...healthy.lifecycle, services: { ready: 30, total: 32 } },
    });
    expect(board.header?.status).toEqual({ label: "⚠ Degraded", tone: "warn" });
  });

  test("the body is a two-column Lifecycle | Actions layout", () => {
    const col = columnsSection(buildClusterBoard(healthy));
    expect(col.columns).toHaveLength(2);
    expect(col.columns[0]?.sections[0]?.kind).toBe("rows");
    expect(col.columns[1]?.sections[0]?.kind).toBe("actions");
  });

  test("lifecycle rows cover context / cluster / flux / services with reconciled counts", () => {
    const rows = rowsOf(buildClusterBoard(healthy));
    expect(rows.items.map((r) => r.text)).toEqual(["Context", "Cluster", "Flux", "Services"]);
    expect(rows.items[2]?.trailing).toBe("29/29 reconciled");
    expect(rows.items[3]?.trailing).toBe("32/32 ready");
  });

  test("lifecycle rows and access cards render boxed (status-list / pill styling)", () => {
    const board = buildClusterBoard(healthy);
    expect(rowsOf(board).boxed).toBe(true);
    expect(accessSection(board).boxed).toBe(true);
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

  test("ACCESS endpoints render as green cards with a portal link", () => {
    const byTitle = accessByTitle(buildClusterBoard(healthy));
    expect(byTitle.Airflow?.dot).toBe("ok");
    expect(byTitle.Airflow?.href).toBe("https://airflow.example.test");
    expect(byTitle.Airflow?.footnote).toBe("self-signed cert");
  });

  test("ACCESS internal services render as cyan cards with no address pill", () => {
    const byTitle = accessByTitle(buildClusterBoard(healthy));
    expect(byTitle.PostgreSQL?.dot).toBe("neutral");
    // An internal host:port isn't an accessible URL — no copyable address field;
    // only credential (reveal) pills remain on the card.
    const fields = byTitle.PostgreSQL?.fields ?? [];
    expect(fields.some((f) => f.copyable)).toBe(false);
    expect(fields.every((f) => f.copyAction)).toBe(true);
  });

  test("credentials join onto their service card as copy-on-reveal fields (never a password)", () => {
    const byTitle = accessByTitle(buildClusterBoard(healthy));
    // Two PostgreSQL credentials on one card (osdu + superuser).
    const pgCreds = (byTitle.PostgreSQL?.fields ?? []).filter((f) => f.copyAction);
    expect(pgCreds.map((f) => f.copyAction?.payload)).toEqual([
      { service: "PostgreSQL", context: "cimpl-stack-ms" },
      { service: "PostgreSQL (superuser)", context: "cimpl-stack-ms" },
    ]);
    // Prefix match: "Keycloak Admin" credential lands on the "Keycloak" endpoint.
    const kcCred = (byTitle.Keycloak?.fields ?? []).find((f) => f.copyAction);
    expect(kcCred?.copyAction).toEqual({
      type: "reveal-credential",
      payload: { service: "Keycloak Admin", context: "cimpl-stack-ms" },
    });
    // Credential fields show the username (or "password" when none) — never a
    // mask and never the secret, which is fetched on copy via the action.
    const credValues: string[] = [];
    for (const card of accessSection(buildClusterBoard(healthy)).items) {
      for (const field of card.fields ?? []) {
        if (field.copyAction) credValues.push(String(field.value));
      }
    }
    expect(credValues).toContain("osdu");
    expect(credValues).toContain("postgres");
    expect(credValues).toContain("admin");
    expect(credValues).not.toContain("••••••");
  });

  test("Redis instance variants collapse into one card with an instance count", () => {
    const redis = accessByTitle(buildClusterBoard(healthy)).Redis;
    expect(redis?.footnote).toBe("3 instances");
  });

  test("an unmatched credential becomes its own card", () => {
    const card = accessByTitle(buildClusterBoard(healthy))["OIDC Client"];
    expect(card?.dot).toBe("neutral");
    expect(card?.fields?.[0]?.copyAction?.payload).toEqual({
      service: "OIDC Client",
      context: "cimpl-stack-ms",
    });
  });

  test("actions carry the board's context so onAction can guard against drift", () => {
    for (const action of actionsOf(buildClusterBoard(healthy)).items) {
      expect(action.payload).toEqual({ context: "cimpl-stack-ms" });
    }
  });

  test("with no context, actions carry no payload (nothing to guard)", () => {
    const board = buildClusterBoard({
      lifecycle: {
        context: null,
        reachable: false,
        flux: { ready: 0, total: 0 },
        services: { ready: 0, total: 0 },
      },
    });
    for (const action of actionsOf(board).items) {
      expect(action.payload).toBeUndefined();
    }
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

  test("an unreachable cluster still yields a valid board (degrades, never crashes)", () => {
    const board = buildClusterBoard({
      lifecycle: {
        context: null,
        reachable: false,
        flux: { ready: 0, total: 0 },
        services: { ready: 0, total: 0 },
      },
    });
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.header?.status).toEqual({ label: "✕ Unreachable", tone: "error" });
    expect(rowsOf(board).items[1]?.trailing).toBe("unreachable");
    // No access cards when cimpl info is absent.
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
  });
});
