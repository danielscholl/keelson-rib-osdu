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

  test("the surface composes the three lane boards, all rib-namespaced", () => {
    const columns = rib.surfaces?.[0]?.layout.rows[0]?.columns ?? [];
    expect(columns.map((c) => c.key)).toEqual([
      "rib:osdu:quality",
      "rib:osdu:features",
      "rib:osdu:security",
    ]);
    expect(columns.every((c) => c.key.startsWith("rib:osdu:"))).toBe(true);
  });
});
