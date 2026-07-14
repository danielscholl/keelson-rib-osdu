import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The create-dispatch marker: a file in the rib's private data dir recording
 * that a `cimpl up` workflow was dispatched, so the Cluster board collector (a
 * separate process with no view of harness run state) can render a
 * provisioning (then Bootstrapping) board and refuse a double-create. The
 * run's terminal event settles the outcome; the collector clears a settled
 * marker on the first collect that finds a live deployment. `failed` is
 * written by run-event wiring (or a future operator verb); a dispatched
 * marker past its provider window simply stops reading as in-flight.
 */
export interface CreateMarker {
  status: "dispatched" | "failed";
  provider: string;
  profile?: string;
  env?: string;
  cluster: string;
  command: string;
  startedAt: string;
  error?: string;
  // Owning run — absent on a board dispatch until the first running event
  // adopts the marker; other runs' events leave a claimed marker alone.
  runId?: string;
}

export const CREATE_MARKER_FILE = "cluster-create.json";

// How long a dispatched create plausibly stays in flight. kind brings a stack
// up in minutes; a cloud create (AKS + Flux converge) can take most of an
// hour. Past the window the board stops claiming "creating" and shows the
// check-the-run caution instead — without run-state access this is a ceiling
// on the run's duration, not a health check.
const KIND_WINDOW_MS = 15 * 60_000;
const CLOUD_WINDOW_MS = 50 * 60_000;

// A marker this old is stale noise from a long-abandoned attempt; the
// collector deletes it rather than warning forever.
export const CREATE_MARKER_EXPIRY_MS = 24 * 60 * 60_000;

export function markerWindowMs(provider: string): number {
  return provider === "kind" ? KIND_WINDOW_MS : CLOUD_WINDOW_MS;
}

export function markerAgeMs(marker: CreateMarker, now: number): number {
  const started = Date.parse(marker.startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : Number.POSITIVE_INFINITY;
}

// A dispatched marker inside its provider window — the only state that renders
// the provisioning board and refuses a second create.
export function markerInFlight(marker: CreateMarker, now: number): boolean {
  return (
    marker.status === "dispatched" && markerAgeMs(marker, now) < markerWindowMs(marker.provider)
  );
}

export function markerExpired(marker: CreateMarker, now: number): boolean {
  return markerAgeMs(marker, now) >= CREATE_MARKER_EXPIRY_MS;
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export function markerPath(dataDir: string): string {
  return join(dataDir, CREATE_MARKER_FILE);
}

// Tolerant read: a missing, unreadable, or malformed marker is no marker — the
// board falls back to its markerless states rather than failing the collect.
// Optional fields are validated too: a non-string profile/env/error would ride
// straight into a board row's text.
export function readCreateMarker(dataDir: string): CreateMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath(dataDir), "utf8"));
  } catch {
    return undefined;
  }
  const m = parsed as CreateMarker;
  const optionalString = (v: unknown) => v === undefined || typeof v === "string";
  const valid =
    (m?.status === "dispatched" || m?.status === "failed") &&
    typeof m.provider === "string" &&
    typeof m.cluster === "string" &&
    typeof m.command === "string" &&
    typeof m.startedAt === "string" &&
    optionalString(m.profile) &&
    optionalString(m.env) &&
    optionalString(m.error) &&
    optionalString(m.runId);
  return valid ? m : undefined;
}

export function writeCreateMarker(dataDir: string, marker: CreateMarker): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(markerPath(dataDir), `${JSON.stringify(marker, null, 2)}\n`);
}

export function clearCreateMarker(dataDir: string): void {
  rmSync(markerPath(dataDir), { force: true });
}
