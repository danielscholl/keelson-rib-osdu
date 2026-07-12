import type { CanvasBoardView, CanvasCell, RibExec } from "@keelson/shared";
import { localExec } from "./exec.ts";

export interface CimplCheckTool {
  name: string;
  description?: string;
  installed: boolean;
  version?: string | null;
  providers?: string[];
}

export interface CimplCheckResult {
  platform?: string;
  provider?: string;
  total?: number;
  installed?: number;
  missing?: number;
  tools?: CimplCheckTool[];
  feature_flags_active?: string[];
}

export const SETUP_PROVIDERS = [
  "kind",
  "azure",
  "aws",
  "gcp",
  "openshift",
  "current-context",
] as const;

export type SetupProvider = (typeof SETUP_PROVIDERS)[number];

export async function fetchSetupCheck(
  exec: RibExec = localExec(),
  provider?: SetupProvider,
): Promise<{ result?: CimplCheckResult; error?: string }> {
  const res = await exec.runJSON<CimplCheckResult>(
    "cimpl",
    ["check", "--json", ...(provider ? ["--provider", provider] : [])],
    { timeoutMs: 60_000, acceptNonZeroExit: true },
  );
  return res.ok ? { result: res.data } : { error: res.error };
}

export function buildDoctorBoard(result?: CimplCheckResult): CanvasBoardView {
  const tools = result?.tools ?? [];
  const installed = result?.installed ?? tools.filter((tool) => tool.installed).length;
  const missing = result?.missing ?? tools.filter((tool) => !tool.installed).length;
  const total = result?.total ?? tools.length;
  const rows = [...tools]
    .sort(
      (a, b) =>
        Number(a.installed) - Number(b.installed) || a.name.localeCompare(b.name),
    )
    .map((tool) => ({
      tool: tool.name,
      version: tool.version ?? "—",
      status: {
        badges: [{ text: tool.installed ? "●" : "○", tone: tool.installed ? "ok" : "error" }],
      },
    }) satisfies Record<string, CanvasCell>);

  return {
    view: "board",
    title: `Cluster Doctor · ${result?.provider ?? "current"}`,
    header: {
      segments: [
        { label: "Installed", n: installed, tone: "ok" },
        { label: "Missing", n: missing, tone: "error" },
      ],
    },
    sections: [
      {
        kind: "stats",
        items: [
          { label: "Installed", value: installed, tone: "ok" },
          { label: "Missing", value: missing, tone: missing > 0 ? "warn" : "ok" },
          { label: "Total", value: total },
        ],
      },
      {
        kind: "table",
        columns: [
          { key: "tool", label: "Tool" },
          { key: "version", label: "Version" },
          { key: "status", label: "" },
        ],
        rows,
      },
    ],
  };
}
