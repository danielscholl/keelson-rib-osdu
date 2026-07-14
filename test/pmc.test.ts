import { afterEach, describe, expect, test } from "bun:test";
import { pmcReportLinks, pmcSite } from "../src/pmc.ts";

const ENV_KEY = "KEELSON_OSDU_PMC_URL";
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

describe("pmcSite", () => {
  test("defaults to the Pages dashboard", () => {
    delete process.env[ENV_KEY];
    expect(pmcSite()).toBe("https://pmc-report-generator-c7606f.pages.opengroup.org");
  });

  test("honours the env override and trims trailing slashes", () => {
    process.env[ENV_KEY] = "https://pmc.example.test///";
    expect(pmcSite()).toBe("https://pmc.example.test");
  });

  test("falls back to the default when the override is blank", () => {
    process.env[ENV_KEY] = "   ";
    expect(pmcSite()).toBe("https://pmc-report-generator-c7606f.pages.opengroup.org");
  });
});

describe("pmcReportLinks", () => {
  test("links every dashboard surface off the given site", () => {
    expect(pmcReportLinks("https://pmc.example.test")).toEqual([
      { text: "Status Summary", href: "https://pmc.example.test/" },
      { text: "Analytics", href: "https://pmc.example.test/analytics/index.html" },
      {
        text: "Release Reports",
        href: "https://pmc.example.test/analytics/release-reports.html",
      },
      {
        text: "Status Reports",
        href: "https://pmc.example.test/analytics/status-reports.html",
      },
      { text: "History", href: "https://pmc.example.test/history.html" },
      { text: "Smoke Tests", href: "https://pmc.example.test/#smoke-tests-section" },
    ]);
  });

  test("does not double the slash when the site carries one", () => {
    for (const link of pmcReportLinks("https://pmc.example.test/")) {
      expect(link.href).not.toContain(".test//");
    }
  });
});
