import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import { buildDoctorBoard, type CimplCheckResult, fetchSetupCheck } from "../src/setup.ts";
import { makeExec } from "./fetch.test.ts";
import fixture from "./fixtures/cimpl-check.json";

const checkFixture = fixture as CimplCheckResult;

describe("fetchSetupCheck", () => {
  test("runs cimpl check as an inventory even when missing tools set a non-zero exit", async () => {
    const { exec, calls, jsonOptions } = makeExec({
      json: () => ({ ok: true, data: checkFixture }),
    });

    expect(await fetchSetupCheck(exec)).toEqual({ result: checkFixture });
    expect(calls[0]).toEqual({ cmd: "cimpl", args: ["check", "--json"] });
    expect(jsonOptions[0]).toEqual({ timeoutMs: 60_000, acceptNonZeroExit: true });
  });

  test("scopes the inventory to a provider", async () => {
    const { exec, calls } = makeExec({ json: () => ({ ok: true, data: checkFixture }) });

    await fetchSetupCheck(exec, "aws");

    expect(calls[0]).toEqual({ cmd: "cimpl", args: ["check", "--json", "--provider", "aws"] });
  });

  test("degrades to an error instead of throwing when cimpl is unavailable", async () => {
    const { exec } = makeExec({
      json: () => ({ ok: false, error: "cimpl not found", code: null }),
    });

    expect(await fetchSetupCheck(exec)).toEqual({ error: "cimpl not found" });
  });
});

describe("buildDoctorBoard", () => {
  test("renders the check inventory as a valid Doctor board", () => {
    const board = buildDoctorBoard(checkFixture);
    const stats = board.sections.find((section) => section.kind === "stats");
    const table = board.sections.find((section) => section.kind === "table");

    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    expect(board.view).toBe("board");
    expect(board.title).toBe("Cluster Doctor · current-context");
    if (stats?.kind !== "stats") throw new Error("Doctor stats missing");
    expect(stats.items).toEqual([
      { label: "Installed", value: 5, tone: "ok" },
      { label: "Missing", value: 3, tone: "warn" },
      { label: "Total", value: 8 },
    ]);
    if (table?.kind !== "table") throw new Error("Doctor table missing");
    expect(table.rows).toHaveLength(checkFixture.tools?.length ?? 0);
    expect(table.rows.map((row) => row.tool)).toEqual([
      "aws",
      "az",
      "eksctl",
      "docker",
      "flux",
      "gcloud",
      "kind",
      "kubectl",
    ]);
  });

  test("renders a valid empty board without a check result", () => {
    const board = buildDoctorBoard();
    const stats = board.sections.find((section) => section.kind === "stats");
    const table = board.sections.find((section) => section.kind === "table");

    expect(canvasViewSchema.safeParse(board).success).toBe(true);
    if (stats?.kind !== "stats") throw new Error("Doctor stats missing");
    expect(stats.items.map((item) => item.value)).toEqual([0, 0, 0]);
    if (table?.kind !== "table") throw new Error("Doctor table missing");
    expect(table.rows).toEqual([]);
  });
});
