#!/usr/bin/env bun
/**
 * Security collector — the producer behind the `osdu-security` workflow. Shapes
 * four one-shot sources into a canvas board-view JSON object and prints that
 * (and nothing else) to stdout:
 *   - `osdu-quality release --output json` — per-service vulnerability counts +
 *     Sonar security ratings (pulse, KPI tiles, offenders, low-rating cards).
 *   - `glab api graphql` group vulnerabilities — per-CVE detail (aged criticals,
 *     quick wins). `glab` handles GitLab auth.
 *   - OSV.dev `/v1/vulns/{id}` — fix versions for quick wins (public, no auth).
 *   - the shared Venus bundle — open vuln-labeled MRs, core-scoped (Vuln MRs tile).
 * Each source degrades independently; the board always renders what it has.
 */
import { GITLAB_GROUP, loadVenusBundle, runGraphql } from "../src/activity.ts";
import type { ReleaseReport } from "../src/quality.ts";
import {
  buildSecurityBoard,
  extractSecurityMrs,
  extractVulns,
  osvFixKey,
  parseOsvFixed,
  type SecurityInputs,
  type VulnRecord,
} from "../src/security.ts";

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

function collectVulns(): VulnRecord[] {
  const nodes: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_VULN_PAGES; page++) {
    const res = runGraphql(vulnQuery(GITLAB_GROUP, cursor));
    if (res.error || !res.json) {
      note(`vulns degraded: ${res.error ?? "no data"}`);
      break;
    }
    const conn = (res.json as { data?: { group?: { vulnerabilities?: VulnConnection } | null } })
      ?.data?.group?.vulnerabilities;
    nodes.push(...(conn?.nodes ?? []));
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
    if (page === MAX_VULN_PAGES - 1) {
      note(`vulns: hit the ${MAX_VULN_PAGES}-page cap — CVE detail may underreport`);
    }
  }
  return extractVulns(nodes);
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

const bundle = loadVenusBundle();
for (const err of bundle.errors) note(err);
const report = runOsduQuality();
const vulns = collectVulns();
const mrs = extractSecurityMrs(bundle.mrsRaw);
const fixes = await collectFixes(vulns);

const inputs: SecurityInputs = { report, vulns, fixes, mrs, now: new Date() };
process.stdout.write(JSON.stringify(buildSecurityBoard(inputs)));
