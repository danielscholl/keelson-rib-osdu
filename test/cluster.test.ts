import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildClusterBoard, type ClusterInput } from "../src/cluster.ts";

const healthy: ClusterInput = {
  info: {
    suspended: false,
    endpoints: [
      { name: "Airflow", url: "https://airflow.example.test", note: "self-signed cert" },
      { name: "Gateway", url: "https://gw.example.test", note: "" },
    ],
    internal_services: [
      {
        name: "PostgreSQL",
        address: "postgresql-rw.platform:5432",
        port_forward: "kubectl cnpg psql postgresql -n platform",
      },
    ],
  },
  lifecycle: {
    context: "cimpl-stack-ms",
    reachable: true,
    flux: { ready: 29, total: 29 },
    services: { ready: 32, total: 32 },
  },
};

const sectionsByKind = (b: ReturnType<typeof buildClusterBoard>) =>
  Object.fromEntries(b.sections.map((s) => [s.kind, s]));

describe("buildClusterBoard", () => {
  test("emits a valid canvas board view", () => {
    expect(canvasViewSchema.safeParse(buildClusterBoard(healthy)).success).toBe(true);
  });

  test("lifecycle rows cover context / cluster / flux / services with reconciled counts", () => {
    const rows = sectionsByKind(buildClusterBoard(healthy)).rows;
    if (rows?.kind !== "rows") throw new Error("expected a rows section");
    expect(rows.items.map((r) => r.text)).toEqual(["Context", "Cluster", "Flux", "Services"]);
    expect(rows.items[2]?.trailing).toBe("29/29 reconciled");
    expect(rows.items[3]?.trailing).toBe("32/32 ready");
  });

  test("a running cluster offers Reconcile + a destructive Suspend", () => {
    const actions = sectionsByKind(buildClusterBoard(healthy)).actions;
    if (actions?.kind !== "actions") throw new Error("expected an actions section");
    const byType = Object.fromEntries(actions.items.map((a) => [a.type, a]));
    expect(byType.reconcile?.label).toBe("Reconcile");
    expect(byType.suspend?.destructive).toBe(true);
    expect(byType.resume).toBeUndefined();
  });

  test("a suspended cluster offers Resume instead of Suspend", () => {
    const board = buildClusterBoard({
      ...healthy,
      info: { ...healthy.info, suspended: true },
    });
    const actions = sectionsByKind(board).actions;
    if (actions?.kind !== "actions") throw new Error("expected an actions section");
    const types = actions.items.map((a) => a.type);
    expect(types).toContain("resume");
    expect(types).not.toContain("suspend");
  });

  test("access cards expose endpoint links and copyable internal-service fields", () => {
    const board = buildClusterBoard(healthy);
    const cards = board.sections.filter((s) => s.kind === "cards");
    const titles = cards.map((c) => (c.kind === "cards" ? c.title : undefined));
    expect(titles).toContain("Endpoints");
    expect(titles).toContain("Internal services");
    const internal = cards.find((c) => c.kind === "cards" && c.title === "Internal services");
    if (internal?.kind !== "cards") throw new Error("expected internal cards");
    expect(internal.items[0]?.fields?.every((f) => f.copyable)).toBe(true);
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
    const rows = sectionsByKind(board).rows;
    if (rows?.kind !== "rows") throw new Error("expected a rows section");
    expect(rows.items[1]?.trailing).toBe("unreachable");
    // No access cards when cimpl info is absent.
    expect(board.sections.some((s) => s.kind === "cards")).toBe(false);
  });
});
