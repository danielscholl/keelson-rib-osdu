import { GITLAB_HOST } from "./activity.ts";

const PMC_PROJECT = "osdu/platform/deployment-and-operations/pmc-report-generator";
const PMC_PROJECT_ENC = encodeURIComponent(PMC_PROJECT);
const PMC_MASTER_SLUG = "master";
const FETCH_TIMEOUT_MS = 5_000;
// Only the exact slug shapes derivePmcReleaseSlug emits (plus the master
// fallback) may reach the outbound wiki fetch, so release-token-derived data
// can't steer the request path.
const PMC_SLUG_ALLOWLIST = /^(?:master|release-\d+-\d+|releases\/release-m\d+)$/;

export function derivePmcReleaseSlug(token: string | null | undefined): string | null {
  const release = token?.match(/(?:\brelease\s+|\bv)(\d+)\.(\d+)/i);
  if (release) return `release-${release[1]}-${release[2]}`;

  const milestone = token?.match(/\bM(\d+)\b/i);
  if (milestone) return `releases/release-m${milestone[1]}`;

  return null;
}

export async function fetchPmcReport(slug: string, host = GITLAB_HOST): Promise<string | null> {
  if (!PMC_SLUG_ALLOWLIST.test(slug)) return null;
  try {
    const r = await fetch(
      `https://${host}/api/v4/projects/${PMC_PROJECT_ENC}/wikis/${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    return r.ok ? `https://${host}/${PMC_PROJECT}/-/wikis/${slug}` : null;
  } catch {
    return null;
  }
}

export async function resolvePmcReportUrl(
  train: string | null | undefined,
  host = GITLAB_HOST,
): Promise<string | null> {
  const slug = derivePmcReleaseSlug(train);
  if (slug) {
    const url = await fetchPmcReport(slug, host);
    if (url) return url;
  }

  return fetchPmcReport(PMC_MASTER_SLUG, host);
}
