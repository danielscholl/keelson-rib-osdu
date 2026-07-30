// The PMC report generator publishes to GitLab Pages under unique (hashed)
// domains, so unlike a project URL they can't be derived from GITLAB_HOST. The
// readable osdu.pages.opengroup.org/... forms 308 here. The quality report and
// the test-reliability analytics publish to two separate Pages sites; the
// report's own nav still points at an `analytics/index.html` that 404s, which is
// why both base URLs live here rather than one.
const PMC_SITE_DEFAULT = "https://pmc-report-generator-c7606f.pages.opengroup.org";
const ANALYTICS_SITE_DEFAULT = "https://osdu-quality-6c74bd.pages.opengroup.org";

export interface PmcLink {
  text: string;
  href: string;
}

export function pmcSite(): string {
  const override = process.env.KEELSON_OSDU_PMC_URL?.trim();
  return (override || PMC_SITE_DEFAULT).replace(/\/+$/, "");
}

export function analyticsSite(): string {
  const override = process.env.KEELSON_OSDU_ANALYTICS_URL?.trim();
  return (override || ANALYTICS_SITE_DEFAULT).replace(/\/+$/, "");
}

// One cell per distinct destination. The report site is a single-page app whose
// three views are addressed by fragment (`VIEWS` + a `location.hash` read on
// init), so #dev/#qa/#libraries are three real pages on a cold load — which is
// all a canvas cell does, since grid links open in a new tab.
//
// Deliberately absent: `releases.html`, which filters the same history manifest
// `history.html` renders down to its frozen entries, so it can only ever show a
// subset; and the analytics site's release/status report archives, which are
// stale renders of the `osdu-quality release` payload the Quality lane already
// holds live. The analytics root stays — job-level reliability across every
// cloud provider is the one lens no rib view renders.
export function pmcReportLinks(report = pmcSite(), analytics = analyticsSite()): PmcLink[] {
  const r = report.replace(/\/+$/, "");
  const a = analytics.replace(/\/+$/, "");
  return [
    { text: "Dev Daily", href: `${r}/#dev` },
    { text: "QA Dev", href: `${r}/#qa` },
    { text: "Libraries", href: `${r}/#libraries` },
    { text: "Run History", href: `${r}/history.html` },
    { text: "Test Reliability", href: `${a}/` },
  ];
}
