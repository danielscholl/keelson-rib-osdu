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
  test("links each dashboard surface off its owning site", () => {
    expect(pmcReportLinks("https://pmc.example.test", "https://an.example.test")).toEqual([
      { text: "Status Summary", href: "https://pmc.example.test/" },
      { text: "Releases", href: "https://pmc.example.test/releases.html" },
      { text: "History", href: "https://pmc.example.test/history.html" },
      { text: "Analytics", href: "https://an.example.test/" },
      { text: "Release Reports", href: "https://an.example.test/release-reports.html" },
      { text: "Status Reports", href: "https://an.example.test/status-reports.html" },
    ]);
  });

  test("does not double the slash when a site carries a trailing one", () => {
    for (const link of pmcReportLinks("https://pmc.example.test/", "https://an.example.test/")) {
      expect(link.href).not.toContain(".test//");
    }
  });
});
