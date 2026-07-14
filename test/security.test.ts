import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import type { ReleaseReport } from "../src/quality.ts";
import {
  buildSecurityBoard,
  extractVulns,
  hashTone,
  osvFixKey,
  parseOsvFixed,
  type SecurityMr,
} from "../src/security.ts";
import osvFixes from "./fixtures/osv-fixes.json";
import report from "./fixtures/security-report.json";
import vulnNodes from "./fixtures/security-vulns.json";

const NOW = new Date("2026-06-01T00:00:00Z");
const vulns = extractVulns(vulnNodes);
// The fix map is keyed by (package, CVE) — mirror how the collector builds it
// from the CVE-keyed fixture and each vuln's package.
const rawFixes = osvFixes as Record<string, string>;
const fixes = new Map<string, string>();
for (const v of vulns) {
  const fix = rawFixes[v.cve_id];
  if (fix) fixes.set(osvFixKey(v.package_name, v.cve_id), fix);
}
const board = buildSecurityBoard({
  report: report as ReleaseReport,
  vulns,
  fixes,
  now: NOW,
});

const section = (kind: string, titleIncludes?: string) =>
  board.sections.find(
    (s) => s.kind === kind && (titleIncludes ? (s.title ?? "").includes(titleIncludes) : true),
  );

describe("buildSecurityBoard", () => {
  test("emits a valid canvas board view", () => {
    expect(canvasViewSchema.safeParse(board).success).toBe(true);
  });

  test("header pulse buckets services by worst severity (unscanned excluded)", () => {
    const segs = board.header?.segments ?? [];
    expect(segs.map((s) => [s.label, s.n])).toEqual([
      ["Crit", 2],
      ["High", 1],
      ["Med", 0],
      ["Clear", 2],
    ]);
  });

  test("KPI tiles total severity counts across scanned services", () => {
    const stats = section("stats");
    expect(stats?.kind).toBe("stats");
    if (stats?.kind !== "stats") return;
    const byLabel = (l: string) => stats.items.find((i) => i.label === l);
    expect(byLabel("Critical")?.value).toBe(16);
    expect(byLabel("Critical")?.tone).toBe("error");
    expect(byLabel("Critical")?.sub).toContain("1 unscanned");
    expect(byLabel("High")?.value).toBe(51);
    expect(byLabel("Medium")?.value).toBe(20);
    expect(byLabel("Vuln MRs")).toBeDefined();
  });

  test("Low security rating: below-A grades worst-first, A filtered out", () => {
    const grid = section("grid", "Low security rating");
    expect(grid?.kind).toBe("grid");
    if (grid?.kind !== "grid") return;
    // Confirmed-A services (Legal, Partition, Register) drop out; only the
    // below-A grades remain, worst-first.
    expect(grid.cells.map((c) => [c.label, c.badge?.text])).toEqual([
      ["Policy", "D"],
      ["Storage", "C"],
      ["Search", "B"],
    ]);
    // The 5-step grade ramp (B info · C warn · D caution), not the 3-step
    // health bucket.
    expect(grid.cells[0]?.badge?.tone).toBe("caution"); // D
    expect(grid.cells[1]?.badge?.tone).toBe("warn"); // C
    expect(grid.cells[2]?.badge?.tone).toBe("info"); // B
  });

  test("Low security rating links to clean Sonar security measures", () => {
    const b = buildSecurityBoard({
      report: {
        services: [
          {
            name: "policy",
            display_name: "Policy",
            sonar: {
              security_rating: "E",
              sonar_url: "https://user:token@sonar.example.com/dashboard?id=osdu.policy",
            },
          },
          {
            name: "search",
            display_name: "Search",
            sonar: {
              security_rating: "D",
              sonar_url: "https://sonar.example.com/dashboard?id=osdu.search-service",
            },
          },
          {
            name: "storage",
            display_name: "Storage",
            sonar: {
              security_rating: "C",
              sonar_url: "https://sonar.example.com/dashboard?id=osdu.storage",
            },
          },
          {
            name: "legal",
            display_name: "Legal",
            sonar: {
              security_rating: "B",
              sonar_url: "https://sonar.example.com/dashboard?id=osdu%2Flegal%3Asvc",
            },
          },
          {
            name: "partition",
            display_name: "Partition",
            sonar: {
              security_rating: "A",
              sonar_url: "https://sonar.example.com/dashboard?id=osdu.partition",
            },
          },
        ],
      },
      now: NOW,
    });
    const grid = b.sections.find((s) => s.kind === "grid" && s.title === "Low security rating");
    expect(grid?.kind).toBe("grid");
    if (grid?.kind !== "grid") return;

    expect(grid.cells.map((c) => [c.label, c.badge?.text, c.href])).toEqual([
      [
        "Policy",
        "E",
        "https://sonar.example.com/component_measures?id=osdu.policy&metric=security_rating&view=list",
      ],
      [
        "Search",
        "D",
        "https://sonar.example.com/component_measures?id=osdu.search-service&metric=security_rating&view=list",
      ],
      [
        "Storage",
        "C",
        "https://sonar.example.com/component_measures?id=osdu.storage&metric=security_rating&view=list",
      ],
      [
        "Legal",
        "B",
        "https://sonar.example.com/component_measures?id=osdu%2Flegal%3Asvc&metric=security_rating&view=list",
      ],
    ]);
    expect(grid.cells[0]?.href?.startsWith("https://sonar.example.com/component_measures?")).toBe(
      true,
    );
    expect(grid.cells[0]?.href).not.toContain("user");
    expect(grid.cells[0]?.href).not.toContain("token");
  });

  test("Low security rating leaves cells unlinked when the Sonar url is missing or non-http", () => {
    const b = buildSecurityBoard({
      report: {
        services: [
          { name: "nourl", display_name: "NoUrl", sonar: { security_rating: "E" } },
          {
            name: "jsurl",
            display_name: "JsUrl",
            sonar: { security_rating: "D", sonar_url: "javascript:alert(1)" },
          },
          {
            name: "ftpurl",
            display_name: "FtpUrl",
            sonar: {
              security_rating: "C",
              sonar_url: "ftp://sonar.example.com/dashboard?id=osdu.ftp",
            },
          },
        ],
      },
      now: NOW,
    });
    const grid = b.sections.find((s) => s.kind === "grid" && s.title === "Low security rating");
    expect(grid?.kind).toBe("grid");
    if (grid?.kind !== "grid") return;

    expect(grid.cells.map((c) => [c.label, c.badge?.text, c.href])).toEqual([
      ["NoUrl", "E", undefined],
      ["JsUrl", "D", undefined],
      ["FtpUrl", "C", undefined],
    ]);
  });

  test("Low security rating collapses when every service is rated A", () => {
    const b = buildSecurityBoard({
      report: {
        services: [
          { name: "a1", display_name: "A1", sonar: { security_rating: "A" } },
          { name: "a2", display_name: "A2", sonar: { security_rating: "A" } },
        ],
      },
      now: NOW,
    });
    expect(b.sections.some((s) => (s.title ?? "").includes("Low security rating"))).toBe(false);
  });

  test("top-offender bars sorted by crit+high with a severity tail, inline layout", () => {
    const bars = section("bars");
    expect(bars?.kind).toBe("bars");
    if (bars?.kind !== "bars") return;
    expect(bars.inline).toBe(true);
    expect(bars.items.map((b) => b.label)).toEqual(["Storage", "Search", "Legal"]);
    const storageBar = bars.items[0];
    expect(storageBar?.value).toBe(43);
    expect(storageBar?.total).toBe(43);
    expect(storageBar?.tone).toBe("error");
    expect(storageBar?.trailing).toBe("10 crit · 33 high");
    expect(storageBar?.href).toBe(
      "https://community.opengroup.org/osdu/platform/system/storage/-/security/vulnerability_report",
    );
    const searchBar = bars.items[1];
    expect(searchBar?.href).toBe(
      "https://community.opengroup.org/osdu/platform/system/search-service/-/security/vulnerability_report",
    );
    const legalBar = bars.items[2];
    expect(legalBar?.tone).toBe("warn");
    expect(legalBar?.trailing).toBe("0 crit · 1 high");
    expect(legalBar?.href).toBe(
      "https://community.opengroup.org/osdu/platform/security-and-compliance/legal/-/security/vulnerability_report",
    );
  });

  test("top-offender bars link only when a vuln project path resolves", () => {
    const b = buildSecurityBoard({
      report: {
        services: [
          {
            name: "storage",
            display_name: "Storage",
            vulnerabilities: { critical: 2, high: 1 },
          },
          {
            name: "notification",
            display_name: "Notification",
            vulnerabilities: { critical: 0, high: 2 },
          },
        ],
      },
      vulns: [
        {
          project_path: "osdu/platform/system/storage",
          cve_id: "CVE-2026-0001",
          severity: "high",
          package_name: "pkg",
          current_version: "1.0.0",
          detected_at: "2026-05-01T00:00:00Z",
          state: "DETECTED",
          web_url:
            "https://community.opengroup.org/osdu/platform/system/storage/-/security/vulnerabilities/1",
        },
      ],
      now: NOW,
    });
    const bars = b.sections.find(
      (s) => s.kind === "bars" && s.title === "Top offenders · crit + high",
    );
    expect(bars?.kind).toBe("bars");
    if (bars?.kind !== "bars") return;

    const storageBar = bars.items.find((bar) => bar.label === "Storage");
    expect(storageBar?.href).toBe(
      "https://community.opengroup.org/osdu/platform/system/storage/-/security/vulnerability_report",
    );
    expect(storageBar?.tone).toBe("error");
    expect(storageBar?.trailing).toBe("2 crit · 1 high");

    const notificationBar = bars.items.find((bar) => bar.label === "Notification");
    expect(notificationBar?.href).toBeUndefined();
    expect(notificationBar?.tone).toBe("warn");
    expect(notificationBar?.trailing).toBe("0 crit · 2 high");
  });

  test("aged criticals: red-mono CVE id, hash-toned svc chip, no per-row age", () => {
    const cards = section("cards", "Aged criticals");
    expect(cards?.kind).toBe("cards");
    if (cards?.kind !== "cards") return;
    expect(cards.title).toBe("Aged criticals · 5 crit · 0 high · >30d");
    expect(cards.items.map((c) => c.title)).toEqual([
      "CVE-2024-0001",
      "CVE-2024-0004",
      "CVE-2024-0002",
      "CVE-2024-0007",
      "CVE-2024-0008",
    ]);
    const first = cards.items[0];
    expect(first?.titleTone).toBe("error");
    expect(first?.mono).toBe(true);
    expect(first?.pill?.label).toBe("storage");
    expect(first?.pill?.tone).toBe(hashTone("storage"));
    expect(first?.fields?.[0]?.value).toBe("golang.org/x/net 0.17.0");
    // Age lives in the section header, not per row.
    expect(first?.footnote).toBeUndefined();
    // Non-core CVE (samples/java-service) is excluded despite being the oldest.
    expect(cards.items.some((c) => c.title === "CVE-2024-9999")).toBe(false);
  });

  test("quick wins: groups by package, ranks by criticals, drops risky/no-fix/fixed", () => {
    const cards = section("cards", "Quick wins");
    expect(cards?.kind).toBe("cards");
    if (cards?.kind !== "cards") return;
    expect(cards.items.map((c) => c.title)).toEqual(["golang.org/x/net", "leftpad", "somepkg"]);

    const net = cards.items[0];
    expect(net?.fields?.map((f) => f.value)).toEqual([
      "0.18.0 → 0.36.0",
      "fixes 2 critical CVEs",
      "search-service, storage",
    ]);
    // org.apache.* major bump is high-risk and excluded.
    expect(cards.items.some((c) => c.title.startsWith("org.apache"))).toBe(false);
    // alreadyfixed (downgrade) and nofixpkg (no OSV fix) excluded.
    expect(cards.items.some((c) => c.title === "alreadyfixed")).toBe(false);
    expect(cards.items.some((c) => c.title === "nofixpkg")).toBe(false);
    expect(cards.items[2]?.fields?.[1]?.value).toBe("fixes 1 medium CVE");
  });

  test("Vuln MRs tile counts core, vuln-labeled, open MRs deduped by readiness", () => {
    const mrs: SecurityMr[] = [
      {
        state: "opened",
        draft: false,
        labels: ["vulnerability management"],
        project_path: "osdu/platform/system/storage",
        iid: 1,
        detailed_merge_status: "mergeable",
        latest_pipeline_status: "success",
      },
      {
        state: "opened",
        draft: false,
        labels: ["Dependencies upgrade"],
        project_path: "osdu/platform/security-and-compliance/legal",
        iid: 2,
        detailed_merge_status: "mergeable",
        latest_pipeline_status: "failed",
      },
      {
        state: "opened",
        draft: true,
        labels: ["vulnerability management"],
        project_path: "osdu/platform/system/search-service",
        iid: 3,
      },
      {
        state: "opened",
        draft: false,
        labels: ["other"],
        project_path: "osdu/platform/system/storage",
        iid: 4,
      },
      {
        state: "merged",
        draft: false,
        labels: ["vulnerability management"],
        project_path: "osdu/platform/system/storage",
        iid: 5,
      },
      {
        state: "opened",
        draft: false,
        labels: ["vulnerability management"],
        project_path: "osdu/platform/ddms/well-delivery",
        iid: 6,
        detailed_merge_status: "mergeable",
        latest_pipeline_status: "success",
      },
    ];
    const b = buildSecurityBoard({ report: report as ReleaseReport, mrs, now: NOW });
    const stats = b.sections.find((s) => s.kind === "stats");
    if (stats?.kind !== "stats") throw new Error("no stats section");
    const tile = stats.items.find((i) => i.label === "Vuln MRs");
    expect(tile?.value).toBe(1);
    expect(tile?.sub).toBe("+1 blocked · +1 draft");
  });
});

describe("buildSecurityBoard edge cases", () => {
  test("counts-only (no vulns/fixes) yields no aged or quick-win sections", () => {
    const b = buildSecurityBoard({ report: report as ReleaseReport, now: NOW });
    expect(canvasViewSchema.safeParse(b).success).toBe(true);
    expect(b.sections.some((s) => (s.title ?? "").includes("Aged criticals"))).toBe(false);
    expect(b.sections.some((s) => (s.title ?? "").includes("Quick wins"))).toBe(false);
    // Counts-based sections still render.
    expect(b.sections.some((s) => s.kind === "bars")).toBe(true);
  });

  test("empty report still yields a valid board with KPI tiles", () => {
    const b = buildSecurityBoard({ report: { services: [] }, now: NOW });
    expect(canvasViewSchema.safeParse(b).success).toBe(true);
    const stats = b.sections.find((s) => s.kind === "stats");
    expect(stats?.kind).toBe("stats");
    if (stats?.kind === "stats") {
      expect(stats.items.find((i) => i.label === "Critical")?.value).toBe("—");
    }
  });

  test("missing services key is tolerated", () => {
    expect(canvasViewSchema.safeParse(buildSecurityBoard({ report: {} })).success).toBe(true);
  });

  test("Low security rating keeps unscanned (last) and drops A grades", () => {
    const b = buildSecurityBoard({
      report: {
        services: [
          { name: "unscanned-a", sonar: {} },
          { name: "rated-d", display_name: "Rated D", sonar: { security_rating: "D" } },
          { name: "unscanned-b" },
          { name: "rated-a", display_name: "Rated A", sonar: { security_rating: "A" } },
          // A padded/lower-case grade still normalizes to A and is filtered out.
          { name: "padded-a", display_name: "Padded A", sonar: { security_rating: " a " } },
        ],
      },
      now: NOW,
    });
    const grid = b.sections.find((s) => s.kind === "grid");
    expect(grid?.kind).toBe("grid");
    if (grid?.kind !== "grid") return;
    // Rated-A drops; the worst real grade (D) leads, unscanned ("—") sorts last
    // by name — a missing scan is still surfaced as a gap.
    expect(grid.cells.map((c) => c.badge?.text)).toEqual(["D", "—", "—"]);
    expect(grid.cells.map((c) => c.label)).toEqual(["Rated D", "unscanned-a", "unscanned-b"]);
  });
});

describe("extractVulns", () => {
  test("normalizes GraphQL nodes and drops non-CVE findings", () => {
    expect(vulns).toHaveLength(9);
    expect(vulns.some((v) => v.cve_id.startsWith("GHSA"))).toBe(false);
    const first = vulns[0];
    expect(first).toMatchObject({
      cve_id: "CVE-2024-0001",
      severity: "critical",
      state: "DETECTED",
      package_name: "golang.org/x/net",
      current_version: "0.17.0",
      project_path: "osdu/platform/system/storage",
    });
  });

  test("tolerates non-array input", () => {
    expect(extractVulns(null)).toEqual([]);
    expect(extractVulns({})).toEqual([]);
  });
});

describe("parseOsvFixed", () => {
  test("picks the highest published fixed version for the matching package", () => {
    const body = {
      affected: [
        {
          package: { name: "golang.org/x/net" },
          ranges: [{ events: [{ introduced: "0" }, { fixed: "1.2.0" }, { fixed: "1.10.0" }] }],
        },
      ],
    };
    expect(parseOsvFixed(body, "golang.org/x/net")).toBe("1.10.0");
  });

  test("ignores fixes for other packages in the same CVE", () => {
    const body = {
      affected: [
        { package: { name: "other/pkg" }, ranges: [{ events: [{ fixed: "9.9.9" }] }] },
        { package: { name: "golang.org/x/net" }, ranges: [{ events: [{ fixed: "1.10.0" }] }] },
      ],
    };
    expect(parseOsvFixed(body, "golang.org/x/net")).toBe("1.10.0");
    expect(parseOsvFixed(body, "unmatched/pkg")).toBe("");
  });

  test("matches Maven group:artifact (OSV) to group/artifact (GitLab)", () => {
    const body = {
      affected: [
        {
          package: { name: "org.apache.tomcat.embed:tomcat-embed-core" },
          ranges: [{ events: [{ fixed: "10.1.34" }] }],
        },
      ],
    };
    expect(parseOsvFixed(body, "org.apache.tomcat.embed/tomcat-embed-core")).toBe("10.1.34");
  });

  test("rejects git-SHA fixed events and empty bodies", () => {
    const body = {
      affected: [
        {
          package: { name: "p" },
          ranges: [{ events: [{ fixed: "abcdef1234567890abcdef1234567890" }] }],
        },
      ],
    };
    expect(parseOsvFixed(body, "p")).toBe("");
    expect(parseOsvFixed({}, "p")).toBe("");
    expect(parseOsvFixed(null, "p")).toBe("");
  });
});
