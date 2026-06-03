#!/usr/bin/env bun
/**
 * Security collector — the producer behind the `osdu-security` workflow. Shapes
 * three one-shot sources into a canvas board-view JSON object and prints that
 * (and nothing else) to stdout:
 *   - `osdu-quality release --output json` — per-service vulnerability counts +
 *     Sonar security ratings (pulse, KPI tiles, offenders, low-rating cards).
 *   - `glab api graphql` group vulnerabilities — per-CVE detail (aged criticals,
 *     quick wins). `glab` handles GitLab auth.
 *   - OSV.dev `/v1/vulns/{id}` — fix versions for quick wins (public, no auth).
 *   - `osdu-activity mr --output json` — open vuln-labeled MRs (Vuln MRs tile).
 * Each source degrades independently; the board always renders what it has.
 */
import type { ReleaseReport } from "../src/quality.ts";
import {
  buildSecurityBoard,
  extractVulns,
  osvFixKey,
  parseOsvFixed,
  type SecurityInputs,
  type SecurityMr,
  type VulnRecord,
} from "../src/security.ts";

const GITLAB_GROUP = process.env.KEELSON_OSDU_GITLAB_GROUP ?? "osdu/platform";
// glab's default host is gitlab.com; the OSDU group lives on the community
// instance, so the vulnerabilities query must target it explicitly.
const GITLAB_HOST = process.env.KEELSON_OSDU_GITLAB_HOST ?? "community.opengroup.org";
const VULN_PAGE_SIZE = 100;
const MAX_VULN_PAGES = 20;
const OSV_BATCH = 8;
const OSV_TIMEOUT_MS = 4_000;
const MAX_OSV_LOOKUPS = 400;

function note(message: string): void {
  // stderr only — stdout must stay pure JSON.
  console.error(`[rib-osdu] security ${message}`);
}

function runOsduQuality(timeoutMs = 120_000): ReleaseReport {
  try {
    const proc = Bun.spawnSync(["osdu-quality", "release", "--output", "json"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim().split("\n").pop() ?? "";
      note(`degraded: ${stderr || `osdu-quality exited ${proc.exitCode}`}`);
      return { services: [] };
    }
    return JSON.parse(proc.stdout.toString()) as ReleaseReport;
  } catch (e) {
    note(`degraded: ${e instanceof Error ? e.message : String(e)}`);
    return { services: [] };
  }
}

function vulnQuery(group: string, cursor: string | null): string {
  const after = cursor ? `, after: ${JSON.stringify(cursor)}` : "";
  return `{ group(fullPath: ${JSON.stringify(group)}) { vulnerabilities(state: [DETECTED, CONFIRMED], first: ${VULN_PAGE_SIZE}${after}) { pageInfo { hasNextPage endCursor } nodes { detectedAt severity state webUrl identifiers { externalType externalId } project { fullPath } location { ... on VulnerabilityLocationDependencyScanning { dependency { package { name } version } } ... on VulnerabilityLocationContainerScanning { dependency { package { name } version } } } } } } }`;
}

interface VulnConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: unknown[];
}

function runGlab(query: string, timeoutMs = 30_000): VulnConnection | { error: string } {
  try {
    const proc = Bun.spawnSync(
      ["glab", "api", "graphql", "--hostname", GITLAB_HOST, "-f", `query=${query}`],
      { stdout: "pipe", stderr: "pipe", timeout: timeoutMs },
    );
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim().split("\n").pop() ?? "";
      return { error: stderr || `glab exited ${proc.exitCode}` };
    }
    const body = JSON.parse(proc.stdout.toString()) as {
      data?: { group?: { vulnerabilities?: VulnConnection } | null };
      errors?: unknown;
    };
    if (body.errors) return { error: `graphql: ${JSON.stringify(body.errors).slice(0, 200)}` };
    const conn = body.data?.group?.vulnerabilities;
    return conn ?? { nodes: [] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function collectVulns(): VulnRecord[] {
  const nodes: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_VULN_PAGES; page++) {
    const res = runGlab(vulnQuery(GITLAB_GROUP, cursor));
    if ("error" in res) {
      note(`vulns degraded: ${res.error}`);
      break;
    }
    nodes.push(...(res.nodes ?? []));
    if (!res.pageInfo?.hasNextPage || !res.pageInfo.endCursor) break;
    cursor = res.pageInfo.endCursor;
    if (page === MAX_VULN_PAGES - 1) {
      note(`vulns: hit the ${MAX_VULN_PAGES}-page cap — CVE detail may underreport`);
    }
  }
  return extractVulns(nodes);
}

function collectMrs(timeoutMs = 180_000): SecurityMr[] {
  try {
    const proc = Bun.spawnSync(
      [
        "osdu-activity",
        "mr",
        "--milestone",
        "Venus",
        "--output",
        "json",
        "--include-draft",
        "--limit",
        "1000",
      ],
      { stdout: "pipe", stderr: "pipe", timeout: timeoutMs },
    );
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim().split("\n").pop() ?? "";
      note(`mrs degraded: ${stderr || `osdu-activity exited ${proc.exitCode}`}`);
      return [];
    }
    const raw = JSON.parse(proc.stdout.toString().replace(/\p{Cc}/gu, " ")) as {
      data?: { projects?: unknown };
    };
    const projects = Array.isArray(raw.data?.projects) ? raw.data.projects : [];
    return projects.flatMap((p) => {
      const proj = p as { project_path?: string | null; merge_requests?: unknown };
      const path = proj.project_path ?? null;
      const mrs = Array.isArray(proj.merge_requests) ? proj.merge_requests : [];
      return mrs.map((m) => {
        const mr = m as SecurityMr;
        return {
          state: mr.state,
          draft: mr.draft,
          labels: mr.labels,
          iid: mr.iid,
          detailed_merge_status: mr.detailed_merge_status,
          latest_pipeline_status: mr.latest_pipeline_status,
          project_path: path,
        } satisfies SecurityMr;
      });
    });
  } catch (e) {
    note(`mrs degraded: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

async function collectFixes(vulns: VulnRecord[]): Promise<Map<string, string>> {
  const fixes = new Map<string, string>();
  // Distinct (package, CVE) pairs needing a fix; the OSV fix is package-specific
  // (one CVE record can carry fixes for several packages), so we extract per
  // pair. OSV is queried once per CVE and the body shared across its packages.
  const pairs = [
    ...new Map(
      vulns
        .filter((v) => v.cve_id && v.package_name)
        .map((v) => [osvFixKey(v.package_name, v.cve_id), v]),
    ).values(),
  ];
  let cves = [...new Set(pairs.map((v) => v.cve_id))];
  if (cves.length > MAX_OSV_LOOKUPS) {
    note(
      `osv: ${cves.length} CVEs exceeds the ${MAX_OSV_LOOKUPS} lookup cap — quick wins may underreport`,
    );
    cves = cves.slice(0, MAX_OSV_LOOKUPS);
  }
  const bodies = new Map<string, unknown>();
  for (let i = 0; i < cves.length; i += OSV_BATCH) {
    const batch = cves.slice(i, i + OSV_BATCH);
    const results = await Promise.all(
      batch.map(async (cve): Promise<[string, unknown]> => {
        try {
          const r = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(cve)}`, {
            signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
          });
          return [cve, r.ok ? await r.json() : null];
        } catch {
          return [cve, null];
        }
      }),
    );
    for (const [cve, body] of results) bodies.set(cve, body);
  }
  for (const v of pairs) {
    if (!bodies.has(v.cve_id)) continue;
    const fix = parseOsvFixed(bodies.get(v.cve_id), v.package_name);
    if (fix) fixes.set(osvFixKey(v.package_name, v.cve_id), fix);
  }
  return fixes;
}

const report = runOsduQuality();
const vulns = collectVulns();
const mrs = collectMrs();
const fixes = await collectFixes(vulns);

const inputs: SecurityInputs = { report, vulns, fixes, mrs, now: new Date() };
process.stdout.write(JSON.stringify(buildSecurityBoard(inputs)));
