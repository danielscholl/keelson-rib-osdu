// The PMC report generator publishes to GitLab Pages under unique (hashed)
// domains, so unlike a project URL they can't be derived from GITLAB_HOST. The
// readable osdu.pages.opengroup.org/... forms 308 here. The report dashboard
// (status summary, releases, history) and the analytics dashboard (release /
// status reports) now publish to two separate Pages sites.
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

// Mirrors the dashboards' own nav. Status Summary / Releases / History live on
// the report site; Analytics and its Release/Status Reports live on the
// analytics site. Smoke Tests is intentionally absent — the dashboard now links
// it as a per-job Allure artifact with no stable URL to pin.
export function pmcReportLinks(report = pmcSite(), analytics = analyticsSite()): PmcLink[] {
  const r = report.replace(/\/+$/, "");
  const a = analytics.replace(/\/+$/, "");
  return [
    { text: "Status Summary", href: `${r}/` },
    { text: "Releases", href: `${r}/releases.html` },
    { text: "History", href: `${r}/history.html` },
    { text: "Analytics", href: `${a}/` },
    { text: "Release Reports", href: `${a}/release-reports.html` },
    { text: "Status Reports", href: `${a}/status-reports.html` },
  ];
}
