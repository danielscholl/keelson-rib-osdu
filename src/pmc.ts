// The PMC report generator publishes its dashboard to GitLab Pages under a
// unique (hashed) domain, so unlike a project URL it can't be derived from
// GITLAB_HOST. The readable osdu.pages.opengroup.org/... form 308s here.
const PMC_SITE_DEFAULT = "https://pmc-report-generator-c7606f.pages.opengroup.org";

export interface PmcLink {
  text: string;
  href: string;
}

// Mirrors the dashboard's own nav. Smoke tests are a section of the landing
// page rather than a page of their own; the per-service Allure reports it links
// are job artifacts elsewhere, so the anchor is the only stable entry point.
const PMC_SURFACES: ReadonlyArray<{ text: string; path: string }> = [
  { text: "Status Summary", path: "/" },
  { text: "Analytics", path: "/analytics/index.html" },
  { text: "Release Reports", path: "/analytics/release-reports.html" },
  { text: "Status Reports", path: "/analytics/status-reports.html" },
  { text: "History", path: "/history.html" },
  { text: "Smoke Tests", path: "/#smoke-tests-section" },
];

export function pmcSite(): string {
  const override = process.env.KEELSON_OSDU_PMC_URL?.trim();
  return (override || PMC_SITE_DEFAULT).replace(/\/+$/, "");
}

export function pmcReportLinks(site = pmcSite()): PmcLink[] {
  const base = site.replace(/\/+$/, "");
  return PMC_SURFACES.map(({ text, path }) => ({ text, href: `${base}${path}` }));
}
