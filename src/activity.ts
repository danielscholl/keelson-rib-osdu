// Shared osdu-activity fetch + GitLab GraphQL enrichment layer behind the
// Features / Release / Events / Security collectors. The osdu-activity `mr` and
// `epic list` CLIs are slow (network round-trips to GitLab) and each collector
// is a separate subprocess on its own cadence, so we fetch the Venus open-MR and
// epic envelopes once, scope MRs to the core services, enrich epics with
// work-item assignees and MRs with last-activity, and cache the result for reuse.
//
// Two GitLab facts drive the enrichment: epics migrated to Work Items so the
// legacy REST `assignees` field the CLI reads is always null (real assignees live
// in the ASSIGNEES widget), and the `mr` CLI returns `updated_at` null. Both are
// recovered via `glab api graphql` (transparent auth). Every external call
// degrades to a no-op — a degraded source yields a raw/empty value, never a throw.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const GITLAB_GROUP = process.env.KEELSON_OSDU_GITLAB_GROUP ?? "osdu/platform";
// glab's default host is gitlab.com; the OSDU group lives on the community
// instance, so every query must target it explicitly.
export const GITLAB_HOST = process.env.KEELSON_OSDU_GITLAB_HOST ?? "community.opengroup.org";

const VENUS_LABEL = "Venus";
const MR_LIMIT = 1000;
const EPIC_LIMIT = 500;
const ASSIGNEE_BATCH = 100;
const MR_PAGE_SIZE = 100;
const MAX_MR_PAGES = 30;
const CACHE_VERSION = 3;
const DEFAULT_TTL_MS = 600_000;

// The 17 Venus core services — mirrors cimpl-agent's bridge scope so the lanes'
// counts match the upstream dashboard. Off-core projects (DDMS, etc.) stay out
// of the KPI / vuln / win totals. Membership is by repo basename, so a renamed
// core repo silently drops until added here (cimpl's mirror test is the guard).
export const VENUS_CORE: ReadonlySet<string> = new Set([
  "partition",
  "entitlements",
  "legal",
  "storage",
  "indexer-service",
  "search-service",
  "file",
  "schema-service",
  "notification",
  "register",
  "dataset",
  "secret",
  "policy",
  "crs-catalog-service",
  "crs-conversion-service",
  "unit-service",
  "ingestion-workflow",
]);

export function serviceOf(projectPath: string | null | undefined): string {
  if (!projectPath) return "";
  return projectPath.split("/").pop() ?? "";
}

export function isVenusCore(projectPath: string | null | undefined): boolean {
  return VENUS_CORE.has(serviceOf(projectPath));
}

type RunResult = { ok: true; stdout: string } | { ok: false; error: string };

function spawn(cmd: string, args: string[], timeoutMs: number): RunResult {
  try {
    const proc = Bun.spawnSync([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim().split("\n").pop() ?? "";
      return { ok: false, error: stderr.length > 0 ? stderr : `${cmd} exited ${proc.exitCode}` };
    }
    return { ok: true, stdout: proc.stdout.toString() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// osdu-activity (and the epic CLI) emit unescaped control characters (raw
// newlines in titles/descriptions) that JSON.parse rejects; strip before parse.
export function parseLenient(stdout: string): unknown {
  return JSON.parse(stdout.replace(/\p{Cc}/gu, " "));
}

export type ActivityRunner = (args: string[]) => { json?: unknown; error?: string };
export type GraphqlRunner = (query: string) => { json?: unknown; error?: string };

export function runActivity(
  args: string[],
  timeoutMs = 180_000,
): { json?: unknown; error?: string } {
  const res = spawn("osdu-activity", args, timeoutMs);
  if (!res.ok) return { error: res.error };
  try {
    return { json: parseLenient(res.stdout) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// Generic GitLab GraphQL via glab. Returns the parsed top-level body so each
// caller reads its own `data` shape; surfaces transport and `errors` failures.
export function runGraphql(query: string, timeoutMs = 30_000): { json?: unknown; error?: string } {
  const res = spawn(
    "glab",
    ["api", "graphql", "--hostname", GITLAB_HOST, "-f", `query=${query}`],
    timeoutMs,
  );
  if (!res.ok) return { error: res.error };
  try {
    const body = JSON.parse(res.stdout) as { errors?: unknown };
    if (body.errors) return { error: `graphql: ${JSON.stringify(body.errors).slice(0, 200)}` };
    return { json: body };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// --- enrichment ----------------------------------------------------------

function assigneeUsernames(workItem: unknown): string[] {
  const widgets = (workItem as { widgets?: unknown })?.widgets;
  if (!Array.isArray(widgets)) return [];
  for (const widget of widgets) {
    const nodes = (widget as { assignees?: { nodes?: unknown } })?.assignees?.nodes;
    if (!Array.isArray(nodes)) continue;
    return nodes
      .map((n) => (n as { username?: unknown })?.username)
      .filter((u): u is string => typeof u === "string" && u.length > 0);
  }
  return [];
}

// Epic assignees live in the work-item ASSIGNEES widget (the legacy REST field
// the CLI reads is always null). One aliased query per batch of iids; fail-closed
// to whatever we resolved so far.
export function fetchWorkItemAssignees(
  iids: number[],
  runGql: GraphqlRunner = runGraphql,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const list = iids.filter((i) => Number.isFinite(i) && i > 0);
  for (let i = 0; i < list.length; i += ASSIGNEE_BATCH) {
    const batch = list.slice(i, i + ASSIGNEE_BATCH);
    const aliases = batch
      .map(
        (iid) =>
          `e${iid}: workItem(iid: "${iid}") { widgets { ... on WorkItemWidgetAssignees { assignees { nodes { username } } } } }`,
      )
      .join(" ");
    const res = runGql(`{ group(fullPath: ${JSON.stringify(GITLAB_GROUP)}) { ${aliases} } }`);
    if (res.error || !res.json) break;
    const group = (res.json as { data?: { group?: Record<string, unknown> } })?.data?.group ?? {};
    for (const iid of batch) {
      const names = assigneeUsernames(group[`e${iid}`]);
      if (names.length > 0) out.set(iid, names);
    }
  }
  return out;
}

// The `mr` CLI returns updated_at null; recover last-activity from the group's
// open merge requests, keyed by `${project}!${iid}`. Paginated, fail-closed.
export function fetchMrUpdatedAt(runGql: GraphqlRunner = runGraphql): Map<string, string> {
  const out = new Map<string, string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_MR_PAGES; page++) {
    const after = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
    const res = runGql(
      `{ group(fullPath: ${JSON.stringify(GITLAB_GROUP)}) { mergeRequests(state: opened, includeSubgroups: true, first: ${MR_PAGE_SIZE}${after}) { pageInfo { hasNextPage endCursor } nodes { iid updatedAt project { fullPath } } } } }`,
    );
    if (res.error || !res.json) break;
    const conn = (
      res.json as {
        data?: {
          group?: {
            mergeRequests?: {
              pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
              nodes?: unknown[];
            } | null;
          };
        };
      }
    )?.data?.group?.mergeRequests;
    for (const node of conn?.nodes ?? []) {
      const n = node as { iid?: unknown; updatedAt?: unknown; project?: { fullPath?: unknown } };
      const path = typeof n.project?.fullPath === "string" ? n.project.fullPath : null;
      const iid = n.iid != null ? String(n.iid) : null;
      const updated = typeof n.updatedAt === "string" ? n.updatedAt : null;
      if (path && iid && updated) out.set(`${path}!${iid}`, updated);
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

// --- envelope transforms -------------------------------------------------

type MrEnvelope = { data?: { projects?: unknown } } & Record<string, unknown>;
type EpicEnvelope = { data?: { epics?: unknown } } & Record<string, unknown>;

// Drop off-core projects and stamp each surviving MR with its project_path, so
// downstream extractors read service + scope without re-walking the projects.
function scopeMrsToCore(raw: unknown): unknown {
  const env = (raw ?? {}) as MrEnvelope;
  const projects = env.data?.projects;
  if (!Array.isArray(projects)) return raw;
  const kept = projects
    .filter((p) => isVenusCore((p as { project_path?: string | null })?.project_path ?? null))
    .map((p) => {
      const proj = p as { project_path?: string | null; merge_requests?: unknown };
      const path = proj.project_path ?? null;
      const mrs = Array.isArray(proj.merge_requests) ? proj.merge_requests : [];
      return {
        ...proj,
        merge_requests: mrs.map((m) => ({ ...(m as object), project_path: path })),
      };
    });
  return { ...env, data: { ...env.data, projects: kept } };
}

function patchAssignees(raw: unknown, map: Map<number, string[]>): unknown {
  const env = (raw ?? {}) as EpicEnvelope;
  const epics = env.data?.epics;
  if (!Array.isArray(epics) || map.size === 0) return raw;
  const patched = epics.map((e) => {
    const iid = (e as { iid?: unknown })?.iid;
    const names = typeof iid === "number" ? map.get(iid) : undefined;
    return names && names.length > 0 ? { ...(e as object), assignees: names } : e;
  });
  return { ...env, data: { ...env.data, epics: patched } };
}

function patchUpdatedAt(raw: unknown, map: Map<string, string>): unknown {
  const env = (raw ?? {}) as MrEnvelope;
  const projects = env.data?.projects;
  if (!Array.isArray(projects) || map.size === 0) return raw;
  const patched = projects.map((p) => {
    const proj = p as { project_path?: string | null; merge_requests?: unknown };
    const path = proj.project_path ?? null;
    const mrs = Array.isArray(proj.merge_requests) ? proj.merge_requests : [];
    return {
      ...proj,
      merge_requests: mrs.map((m) => {
        const mr = m as { iid?: unknown; updated_at?: unknown };
        const updated = path && mr.iid != null ? map.get(`${path}!${String(mr.iid)}`) : undefined;
        return updated ? { ...(m as object), updated_at: updated } : m;
      }),
    };
  });
  return { ...env, data: { ...env.data, projects: patched } };
}

function epicIids(raw: unknown): number[] {
  const epics = (raw as EpicEnvelope)?.data?.epics;
  if (!Array.isArray(epics)) return [];
  return epics
    .map((e) => (e as { iid?: unknown })?.iid)
    .filter((i): i is number => typeof i === "number");
}

// --- cache ---------------------------------------------------------------

interface CacheEntry {
  version: number;
  fetchedAt: number;
  bundle: VenusBundle;
}

// Cross-process cache so collectors on staggered cadences reuse one fetch.
// Co-locate with the harness DB when KEELSON_DB is set, else the OS temp dir.
function defaultCacheDir(): string {
  const db = process.env.KEELSON_DB;
  const base = db ? dirname(db) : tmpdir();
  return join(base, "rib-osdu-cache");
}

function cacheFile(dir: string): string {
  return join(dir, `venus-bundle-v${CACHE_VERSION}.json`);
}

function readCache(dir: string, now: number, ttlMs: number): VenusBundle | null {
  try {
    const file = cacheFile(dir);
    if (!existsSync(file)) return null;
    const entry = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    if (entry.version !== CACHE_VERSION) return null;
    if (now - entry.fetchedAt >= ttlMs) return null;
    return entry.bundle;
  } catch {
    return null;
  }
}

function writeCache(dir: string, bundle: VenusBundle, now: number): void {
  try {
    mkdirSync(dir, { recursive: true });
    const entry: CacheEntry = { version: CACHE_VERSION, fetchedAt: now, bundle };
    const tmp = join(dir, `venus-bundle-v${CACHE_VERSION}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(entry));
    renameSync(tmp, cacheFile(dir));
  } catch {
    // Cache is best-effort; a write failure just means the next run refetches.
  }
}

// --- bundle --------------------------------------------------------------

export interface VenusBundle {
  mrsRaw: unknown;
  epicsRaw: unknown;
  errors: string[];
}

export interface BundleDeps {
  runActivity?: ActivityRunner;
  runGraphql?: GraphqlRunner;
  now?: () => number;
  // A directory path to enable the file cache, or null to disable it (tests and
  // single-shot callers that don't want cross-process reuse).
  cacheDir?: string | null;
  ttlMs?: number;
}

export function loadVenusBundle(deps: BundleDeps = {}): VenusBundle {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? readTtlEnv();
  const cacheDir = deps.cacheDir === null ? null : (deps.cacheDir ?? defaultCacheDir());

  if (cacheDir) {
    const hit = readCache(cacheDir, now(), ttlMs);
    if (hit) return hit;
  }

  const runAct = deps.runActivity ?? ((args) => runActivity(args));
  const runGql = deps.runGraphql ?? ((q) => runGraphql(q));
  const errors: string[] = [];

  const mrsRes = runAct(["mr", "--output", "json", "--include-draft", "--limit", String(MR_LIMIT)]);
  if (mrsRes.error) errors.push(`mrs degraded: ${mrsRes.error}`);
  const epicsRes = runAct([
    "epic",
    "list",
    "--label",
    VENUS_LABEL,
    "--output",
    "json",
    "--limit",
    String(EPIC_LIMIT),
  ]);
  if (epicsRes.error) errors.push(`epics degraded: ${epicsRes.error}`);

  let mrsRaw: unknown = scopeMrsToCore(mrsRes.json ?? { data: { projects: [] } });
  let epicsRaw: unknown = epicsRes.json ?? { data: { epics: [] } };
  if (epicIids(epicsRaw).length >= EPIC_LIMIT) {
    errors.push(`epics: hit the ${EPIC_LIMIT}-row cap — board may underreport`);
  }

  epicsRaw = patchAssignees(epicsRaw, fetchWorkItemAssignees(epicIids(epicsRaw), runGql));
  mrsRaw = patchUpdatedAt(mrsRaw, fetchMrUpdatedAt(runGql));

  const bundle: VenusBundle = { mrsRaw, epicsRaw, errors };
  if (cacheDir) writeCache(cacheDir, bundle, now());
  return bundle;
}

function readTtlEnv(): number {
  const raw = process.env.KEELSON_OSDU_BUNDLE_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}
