import { describe, expect, test } from "bun:test";
import { canvasViewSchema } from "@keelson/shared";
import type { ReleaseReport } from "../src/quality.ts";
import {
  buildSecurityBoard,
  extractVulns,
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

  test("low security rating cards: non-A grades, worst-first", () => {
    const cards = section("cards", "Low security rating");
    expect(cards?.kind).toBe("cards");
    if (cards?.kind !== "cards") return;
    expect(cards.items.map((c) => [c.title, c.pill?.label])).toEqual([
      ["Policy", "D"],
      ["Storage", "C"],
      ["Search", "B"],
    ]);
    expect(cards.items[0]?.pill?.tone).toBe("error");
    expect(cards.items[1]?.pill?.tone).toBe("warn");
  });

  test("top-offender bars sorted by crit+high with a severity tail", () => {
    const bars = section("bars");
    expect(bars?.kind).toBe("bars");
    if (bars?.kind !== "bars") return;
    expect(bars.items.map((b) => b.label)).toEqual(["Storage", "Search", "Legal"]);
    const storageBar = bars.items[0];
    expect(storageBar?.value).toBe(43);
    expect(storageBar?.total).toBe(43);
    expect(storageBar?.tone).toBe("error");
    expect(storageBar?.trailing).toBe("10 crit · 33 high");
    const legalBar = bars.items[2];
    expect(legalBar?.tone).toBe("warn");
    expect(legalBar?.trailing).toBe("0 crit · 1 high");
  });

  test("aged criticals: critical, >30d, oldest first, with summary in title", () => {
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
    expect(cards.items[0]?.pill?.label).toBe("storage");
    expect(cards.items[0]?.fields?.[0]?.value).toBe("golang.org/x/net 0.17.0");
    expect(cards.items[0]?.footnote).toBe("aged 151 days");
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
