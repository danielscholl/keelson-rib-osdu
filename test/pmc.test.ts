import { describe, expect, test } from "bun:test";
import { derivePmcReleaseSlug } from "../src/pmc.ts";

describe("derivePmcReleaseSlug", () => {
  test("maps release tokens to wiki slugs", () => {
    expect(derivePmcReleaseSlug("Release 0.30")).toBe("release-0-30");
    expect(derivePmcReleaseSlug("Release 0.29")).toBe("release-0-29");
    expect(derivePmcReleaseSlug("v0.30")).toBe("release-0-30");
  });

  test("maps milestone tokens to wiki slugs", () => {
    expect(derivePmcReleaseSlug("M26")).toBe("releases/release-m26");
  });

  test("prefers numeric release tokens in compound milestones", () => {
    expect(derivePmcReleaseSlug("M26 - Release 0.30")).toBe("release-0-30");
    expect(derivePmcReleaseSlug("M26 - Release 0.29 (Venus - Preview 1)")).toBe(
      "release-0-29",
    );
  });

  test("returns null when no slug can be derived", () => {
    expect(derivePmcReleaseSlug("random")).toBeNull();
    expect(derivePmcReleaseSlug("")).toBeNull();
    expect(derivePmcReleaseSlug(null)).toBeNull();
    expect(derivePmcReleaseSlug(undefined)).toBeNull();
  });
});
