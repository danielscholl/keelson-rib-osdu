import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CreateMarker,
  clearCreateMarker,
  formatAge,
  markerExpired,
  markerInFlight,
  markerPath,
  readCreateMarker,
  writeCreateMarker,
} from "../src/create-marker.ts";

const NOW = Date.parse("2026-07-13T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const base: CreateMarker = {
  status: "dispatched",
  provider: "kind",
  cluster: "cimpl-stack",
  command: "cimpl up --provider kind",
  startedAt: minutesAgo(2),
};

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "rib-osdu-marker-"));
}

describe("create marker file", () => {
  test("round-trips through the data dir, creating it on write", () => {
    const dir = join(scratchDir(), "rib-osdu");
    writeCreateMarker(dir, base);
    expect(readCreateMarker(dir)).toEqual(base);
    clearCreateMarker(dir);
    expect(readCreateMarker(dir)).toBeUndefined();
  });

  test("a missing, corrupt, or shape-invalid marker reads as no marker", () => {
    const dir = scratchDir();
    expect(readCreateMarker(dir)).toBeUndefined();
    writeFileSync(markerPath(dir), "not json");
    expect(readCreateMarker(dir)).toBeUndefined();
    writeFileSync(markerPath(dir), JSON.stringify({ status: "launching", provider: "kind" }));
    expect(readCreateMarker(dir)).toBeUndefined();
    // Optional fields must be strings too — a non-string would ride straight
    // into a board row's text.
    writeFileSync(markerPath(dir), JSON.stringify({ ...base, profile: {} }));
    expect(readCreateMarker(dir)).toBeUndefined();
    writeFileSync(markerPath(dir), JSON.stringify({ ...base, status: "failed", error: 42 }));
    expect(readCreateMarker(dir)).toBeUndefined();
    // Clearing what isn't there must not throw.
    clearCreateMarker(join(dir, "never-created"));
  });
});

describe("marker freshness", () => {
  test("a kind dispatch is in flight inside its window and stale past it", () => {
    expect(markerInFlight({ ...base, startedAt: minutesAgo(14) }, NOW)).toBe(true);
    expect(markerInFlight({ ...base, startedAt: minutesAgo(16) }, NOW)).toBe(false);
  });

  test("a cloud dispatch gets the longer window", () => {
    const azure = { ...base, provider: "azure" };
    expect(markerInFlight({ ...azure, startedAt: minutesAgo(45) }, NOW)).toBe(true);
    expect(markerInFlight({ ...azure, startedAt: minutesAgo(51) }, NOW)).toBe(false);
  });

  test("a failed marker is never in flight", () => {
    expect(markerInFlight({ ...base, status: "failed" }, NOW)).toBe(false);
  });

  test("an unparseable startedAt is neither in flight nor young", () => {
    const bad = { ...base, startedAt: "not-a-date" };
    expect(markerInFlight(bad, NOW)).toBe(false);
    expect(markerExpired(bad, NOW)).toBe(true);
  });

  test("a day-old marker is expired; a fresh one is not", () => {
    expect(markerExpired({ ...base, startedAt: minutesAgo(25 * 60) }, NOW)).toBe(true);
    expect(markerExpired(base, NOW)).toBe(false);
  });
});

describe("formatAge", () => {
  test("scales from moments through minutes to hours", () => {
    expect(formatAge(30_000)).toBe("moments ago");
    expect(formatAge(5 * 60_000)).toBe("5m ago");
    expect(formatAge(90 * 60_000)).toBe("1h 30m ago");
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe("unknown");
  });
});
