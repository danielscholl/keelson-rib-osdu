import { afterEach, describe, expect, test } from "bun:test";
import { analyticsSite, pmcReportLinks, pmcSite } from "../src/pmc.ts";

const PMC_ENV = "KEELSON_OSDU_PMC_URL";
const ANALYTICS_ENV = "KEELSON_OSDU_ANALYTICS_URL";
const originals: Record<string, string | undefined> = {
  [PMC_ENV]: process.env[PMC_ENV],
  [ANALYTICS_ENV]: process.env[ANALYTICS_ENV],
};

afterEach(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("pmcSite", () => {
  test("defaults to the report Pages dashboard", () => {
    delete process.env[PMC_ENV];
    expect(pmcSite()).toBe("https://pmc-report-generator-c7606f.pages.opengroup.org");
  });

  test("honours the env override and trims trailing slashes", () => {
    process.env[PMC_ENV] = "https://pmc.example.test///";
    expect(pmcSite()).toBe("https://pmc.example.test");
  });

  test("falls back to the default when the override is blank", () => {
    process.env[PMC_ENV] = "   ";
    expect(pmcSite()).toBe("https://pmc-report-generator-c7606f.pages.opengroup.org");
  });
});

describe("analyticsSite", () => {
  test("defaults to the analytics Pages dashboard", () => {
    delete process.env[ANALYTICS_ENV];
    expect(analyticsSite()).toBe("https://osdu-quality-6c74bd.pages.opengroup.org");
  });

  test("honours the env override and trims trailing slashes", () => {
    process.env[ANALYTICS_ENV] = "https://analytics.example.test///";
    expect(analyticsSite()).toBe("https://analytics.example.test");
  });
});

describe("pmcReportLinks", () => {
  test("addresses the report's three views by fragment, off its owning site", () => {
    expect(pmcReportLinks("https://pmc.example.test", "https://an.example.test")).toEqual([
      { text: "Dev Daily", href: "https://pmc.example.test/#dev" },
      { text: "QA Dev", href: "https://pmc.example.test/#qa" },
      { text: "Libraries", href: "https://pmc.example.test/#libraries" },
      { text: "Run History", href: "https://pmc.example.test/history.html" },
      { text: "Test Reliability", href: "https://an.example.test/" },
    ]);
  });

  test("every cell opens a distinct destination", () => {
    const links = pmcReportLinks("https://pmc.example.test", "https://an.example.test");
    expect(new Set(links.map((l) => l.href)).size).toBe(links.length);
    expect(new Set(links.map((l) => l.text)).size).toBe(links.length);
  });

  test("drops the destinations that only ever duplicate another cell", () => {
    const hrefs = pmcReportLinks("https://pmc.example.test", "https://an.example.test").map(
      (l) => l.href,
    );
    // releases.html is a frozen-only subset of history.html; the analytics
    // archives are stale renders of the Quality lane's own live payload.
    for (const dropped of ["releases.html", "release-reports.html", "status-reports.html"]) {
      expect(hrefs.some((href) => href.includes(dropped))).toBe(false);
    }
  });

  test("does not double the slash when a site carries a trailing one", () => {
    for (const link of pmcReportLinks("https://pmc.example.test/", "https://an.example.test/")) {
      expect(link.href).not.toContain(".test//");
    }
  });
});
