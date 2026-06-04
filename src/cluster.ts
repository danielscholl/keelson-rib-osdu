import type { CanvasBoardView } from "@keelson/shared";

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
  reachable: boolean;
  flux: { ready: number; total: number };
  services: { ready: number; total: number };
}

export interface ClusterInput {
  info?: CimplInfo;
  lifecycle: ClusterLifecycle;
}

type Tone = "ok" | "warn" | "error" | "neutral";
type BoardSection = CanvasBoardView["sections"][number];
type ColumnsSection = Extract<BoardSection, { kind: "columns" }>;
type LeafSection = ColumnsSection["columns"][number]["sections"][number];
type CardsSection = Extract<BoardSection, { kind: "cards" }>;
type CardItem = CardsSection["items"][number];
type FieldItem = NonNullable<CardItem["fields"]>[number];

function countTone(ready: number, total: number): Tone {
  if (total === 0) return "error";
  return ready === total ? "ok" : "warn";
}

// cimpl reports a missing/unreadable secret as a placeholder containing "n/a"
// (sometimes with rich markup). Such rows must not produce a copy affordance —
// there is nothing to copy — and the reveal handler must reject them too.
export function hasRealSecret(password: unknown): boolean {
  if (typeof password !== "string") return false;
  const p = password.trim().toLowerCase();
  return p.length > 0 && !p.includes("n/a");
}

// Normalize a service name to a join key: drop parenthetical qualifiers
// ("PostgreSQL (superuser)" → postgresql) and non-alphanumerics, lowercase.
function norm(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]/g, "");
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

function credentialField(cred: CimplCredential): FieldItem {
  const username = cred.username?.trim();
  return {
    // The username is shown; the value is a mask, not the secret. The copy
    // button reveals the password on demand and writes it to the clipboard.
    label: username && username.length > 0 ? username : "password",
    value: "••••••",
    copyAction: { type: "reveal-credential", payload: { service: cred.service } },
  };
}

// Unified ACCESS grid: external endpoints (green dot, portal ↗) + internal
// services (cyan dot, collapsed by base name), with credentials joined onto the
// matching card by normalized service name (exact, then prefix). Unmatched
// credentials become their own cyan card so none are dropped.
function buildAccessCards(info: CimplInfo): CardItem[] {
  type JoinCard = CardItem & { norm: string };
  const cards: JoinCard[] = [];

  for (const e of info.endpoints ?? []) {
    cards.push({
      norm: norm(e.name),
      title: e.name,
      dot: "ok",
      ...(e.url ? { href: e.url } : {}),
      ...(e.note && e.note.trim().length > 0 ? { footnote: e.note } : {}),
      fields: [],
    });
  }

  const groups = new Map<string, CimplInternalService[]>();
  for (const s of info.internal_services ?? []) {
    const key = baseName(s.name);
    const members = groups.get(key) ?? [];
    members.push(s);
    groups.set(key, members);
  }
  for (const [base, members] of groups) {
    const fields: FieldItem[] = [];
    const address = members[0]?.address;
    if (address) fields.push({ label: "address", value: address, copyable: true });
    cards.push({
      norm: norm(base),
      title: base,
      dot: "neutral",
      ...(members.length > 1 ? { footnote: `${members.length} instances` } : {}),
      fields,
    });
  }

  for (const cred of info.credentials ?? []) {
    const cn = norm(cred.service);
    const target =
      cards.find((c) => c.norm === cn) ??
      cards.find((c) => c.norm.length > 0 && cn.startsWith(c.norm));
    if (target) {
      if (!target.fields) target.fields = [];
      target.fields.push(credentialField(cred));
    } else {
      cards.push({
        norm: cn,
        title: cred.service,
        dot: "neutral",
        fields: [credentialField(cred)],
      });
    }
  }

  return cards.map(({ norm: _norm, fields, ...rest }) => ({
    ...rest,
    ...(fields && fields.length > 0 ? { fields } : {}),
  }));
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

  const lifecycleRows: LeafSection = {
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
  };

  const actions: LeafSection = {
    kind: "actions",
    title: "Actions",
    items: [
      { type: "reconcile", label: "Reconcile", glyph: "↻" },
      suspended
        ? { type: "resume", label: "Resume", glyph: "▶" }
        : { type: "suspend", label: "Suspend", glyph: "⏸" },
      { type: "delete", label: "Delete", glyph: "✕", tone: "error", destructive: true },
    ],
  };

  const sections: BoardSection[] = [
    {
      kind: "columns",
      columns: [
        { weight: 1.4, sections: [lifecycleRows] },
        { weight: 1, sections: [actions] },
      ],
    },
  ];

  const access = info ? buildAccessCards(info) : [];
  if (access.length > 0) {
    sections.push({ kind: "cards", title: "Access", items: access });
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
