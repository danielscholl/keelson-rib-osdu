import type { CanvasBoardView } from "@keelson/shared";

// The subset of `cimpl info --json` the ICC reads. Credentials (behind
// --show-secrets) are intentionally NOT consumed: rendering live passwords as
// plaintext in a persisted, screenshot-able board is unsafe without a masked
// card-field affordance — deferred to a follow-up.
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
export interface CimplInfo {
  endpoints?: CimplEndpoint[];
  internal_services?: CimplInternalService[];
  suspended?: boolean;
}

export interface ClusterLifecycle {
  context: string | null;
  reachable: boolean;
  flux: { ready: number; total: number };
  services: { ready: number; total: number };
}

export interface ClusterInput {
  info?: CimplInfo;
  lifecycle: ClusterLifecycle;
}

type BoardSection = CanvasBoardView["sections"][number];
type Tone = "ok" | "warn" | "error" | "neutral";

function countTone(ready: number, total: number): Tone {
  if (total === 0) return "error";
  return ready === total ? "ok" : "warn";
}

/**
 * Build the Cluster ICC board from `cimpl info` access data + kubectl-derived
 * lifecycle counts. Pure — no I/O. Always emits a valid board: a degraded
 * (unreachable) cluster still renders lifecycle rows + actions, just with no
 * endpoint/service cards.
 */
export function buildClusterBoard(input: ClusterInput): CanvasBoardView {
  const { info, lifecycle } = input;
  const { context, reachable, flux, services } = lifecycle;
  const suspended = info?.suspended === true;

  const sections: BoardSection[] = [
    {
      kind: "rows",
      title: "Lifecycle",
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
    },
    {
      kind: "actions",
      title: "Actions",
      items: [
        { type: "reconcile", label: "Reconcile" },
        suspended
          ? { type: "resume", label: "Resume" }
          : { type: "suspend", label: "Suspend", tone: "warn", destructive: true },
      ],
    },
  ];

  const endpoints = info?.endpoints ?? [];
  if (endpoints.length > 0) {
    sections.push({
      kind: "cards",
      title: "Endpoints",
      items: endpoints.map((e) => ({
        title: e.name,
        ...(e.url ? { href: e.url } : {}),
        ...(e.note && e.note.trim().length > 0 ? { footnote: e.note } : {}),
      })),
    });
  }

  const internal = info?.internal_services ?? [];
  if (internal.length > 0) {
    sections.push({
      kind: "cards",
      title: "Internal services",
      items: internal.map((s) => ({
        title: s.name,
        fields: [
          ...(s.address ? [{ label: "address", value: s.address, copyable: true }] : []),
          ...(s.port_forward
            ? [{ label: "port-forward", value: s.port_forward, copyable: true }]
            : []),
        ],
      })),
    });
  }

  return {
    view: "board",
    title: "Cluster ICC",
    header: {
      chip: context ?? "no context",
      segments: [
        { label: "Flux", n: flux.ready, tone: countTone(flux.ready, flux.total) },
        { label: "Services", n: services.ready, tone: countTone(services.ready, services.total) },
      ],
    },
    sections,
  };
}
