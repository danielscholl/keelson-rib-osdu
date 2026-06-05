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

  test("the Cluster ICC is the collapsible header region", () => {
    const header = rib.surfaces?.[0]?.layout.header;
    expect(header?.key).toBe("rib:osdu:cluster");
    expect(header?.collapsible).toBe(true);
    expect(header?.collapsed).toBe(true);
  });

  test("the surface composes the three lane boards, all rib-namespaced", () => {
    const columns = rib.surfaces?.[0]?.layout.rows[0]?.columns ?? [];
    expect(columns.map((c) => c.key)).toEqual([
      "rib:osdu:quality",
      "rib:osdu:features",
      "rib:osdu:security",
    ]);
    expect(columns.every((c) => c.key.startsWith("rib:osdu:"))).toBe(true);
  });

  test("each region names the workflow its refresh re-runs", () => {
    const layout = rib.surfaces?.[0]?.layout;
    expect(layout?.header?.workflow).toBe("osdu-cluster");
    expect(layout?.rows[0]?.columns.map((c) => c.workflow)).toEqual([
      "osdu-quality",
      "osdu-features",
      "osdu-security",
    ]);
  });

  test("every region's refresh workflow is one the rib actually contributes", () => {
    const ctx = {} as Parameters<NonNullable<typeof rib.contributeWorkflows>>[0];
    const contributed = new Set(
      (rib.contributeWorkflows?.(ctx) ?? []).map((c) => (c.definition as { name: string }).name),
    );
    const layout = rib.surfaces?.[0]?.layout;
    const regions = [layout?.header, ...(layout?.rows.flatMap((r) => r.columns) ?? [])];
    for (const region of regions) {
      if (region?.workflow) expect(contributed.has(region.workflow)).toBe(true);
    }
  });
});
