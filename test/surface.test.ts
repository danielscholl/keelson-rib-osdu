import { describe, expect, test } from "bun:test";
import { ribSurfaceDescriptorSchema } from "@keelson/shared";
import rib from "../src/index.ts";

describe("CIMPL surface", () => {
  test("the rib declares one valid CIMPL surface", () => {
    expect(rib.surfaces).toHaveLength(1);
    const surface = rib.surfaces?.[0];
    expect(surface?.id).toBe("cimpl");
    expect(surface?.title).toBe("CIMPL");
    expect(ribSurfaceDescriptorSchema.safeParse(surface).success).toBe(true);
  });

  test("the Cluster board is the collapsible header region", () => {
    const header = rib.surfaces?.[0]?.layout.header;
    expect(header?.key).toBe("rib:osdu:cluster");
    expect(header?.collapsible).toBe(true);
    expect(header?.collapsed).toBe(true);
  });

  test("Waiting on You is the banner region, above the Release Train", () => {
    const banner = rib.surfaces?.[0]?.layout.banner;
    expect(banner?.key).toBe("rib:osdu:waiting");
    expect(banner?.workflow).toBe("osdu-waiting");
    expect(banner?.title).toBe("Waiting on You");
    expect(typeof banner?.glyph?.char).toBe("string");
  });

  test("the Release Train is the full-width row above the lanes", () => {
    const strip = rib.surfaces?.[0]?.layout.rows[0];
    expect(strip?.columns.map((c) => c.key)).toEqual(["rib:osdu:release"]);
    expect(strip?.columns[0]?.workflow).toBe("osdu-release");
    expect(strip?.columns[0]?.title).toBe("Release Train");
  });

  test("the surface composes the three lane boards in Features·Quality·Security order", () => {
    const columns = rib.surfaces?.[0]?.layout.rows[1]?.columns ?? [];
    expect(columns.map((c) => c.key)).toEqual([
      "rib:osdu:features",
      "rib:osdu:quality",
      "rib:osdu:security",
    ]);
    expect(columns.every((c) => c.key.startsWith("rib:osdu:"))).toBe(true);
  });

  test("each lane carries a static identity (title + toned glyph)", () => {
    const columns = rib.surfaces?.[0]?.layout.rows[1]?.columns ?? [];
    expect(columns.map((c) => c.title)).toEqual(["Features", "Quality", "Security"]);
    expect(columns.map((c) => c.glyph?.tone)).toEqual(["brand", "info", "caution"]);
    expect(columns.every((c) => typeof c.glyph?.char === "string")).toBe(true);
    expect(rib.surfaces?.[0]?.layout.header?.title).toBe("Cluster");
  });

  test("each region names the workflow its refresh re-runs", () => {
    const layout = rib.surfaces?.[0]?.layout;
    expect(layout?.header?.workflow).toBe("osdu-cluster");
    expect(layout?.rows[1]?.columns.map((c) => c.workflow)).toEqual([
      "osdu-features",
      "osdu-quality",
      "osdu-security",
    ]);
  });

  test("every region's refresh workflow is one the rib actually contributes", () => {
    const ctx = {} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0];
    const contributed = new Set(
      (rib.contributeWorkflows?.(ctx) ?? []).map((c) => (c.definition as { name: string }).name),
    );
    const layout = rib.surfaces?.[0]?.layout;
    const regions = [
      layout?.header,
      layout?.banner,
      ...(layout?.rows.flatMap((r) => r.columns) ?? []),
    ];
    for (const region of regions) {
      if (region?.workflow) expect(contributed.has(region.workflow)).toBe(true);
    }
  });
});
