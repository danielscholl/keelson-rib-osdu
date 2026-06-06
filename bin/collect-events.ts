#!/usr/bin/env bun
/**
 * Current Events collector — the producer behind the `osdu-events` workflow.
 * Shells `osdu-activity mr` (open MRs) and `osdu-activity epic list` (merged MRs
 * ride epic `related_mrs`, the only source carrying merged_at) plus
 * `kubectl get jobs`, shapes recent motion into a canvas board feed, and prints
 * that (and nothing else) to stdout. Degrades to a valid board when a source is
 * missing or errors.
 */
import { buildEventsBoard, extractFeedMrs, extractMergedRelatedMrs } from "../src/events.ts";
import { getJobs } from "../src/kubectl.ts";

// `osdu-activity` can emit unescaped control characters (raw newlines in MR /
// epic titles) that JSON.parse rejects; strip them before parsing.
function parseLenient(stdout: string): unknown {
  return JSON.parse(stdout.replace(/\p{Cc}/gu, " "));
}

function runActivity(args: string[], timeoutMs = 180_000): { json?: unknown; error?: string } {
  try {
    const proc = Bun.spawnSync(["osdu-activity", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim().split("\n").pop() ?? "";
      return {
        error:
          stderr.length > 0 ? stderr : `osdu-activity ${args.join(" ")} exited ${proc.exitCode}`,
      };
    }
    return { json: parseLenient(proc.stdout.toString()) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const MR_LIMIT = 1000;
const EPIC_LIMIT = 500;
const VENUS = "Venus";

// Open MRs (default state) — the mr report carries created_at but not merged_at.
const mrsRes = runActivity([
  "mr",
  "--milestone",
  VENUS,
  "--output",
  "json",
  "--limit",
  String(MR_LIMIT),
]);
// Merged MRs ride epic related_mrs (the only source with merged_at).
const epicsRes = runActivity([
  "epic",
  "list",
  "--label",
  VENUS,
  "--output",
  "json",
  "--limit",
  String(EPIC_LIMIT),
]);
const jobsRes = getJobs();

for (const [name, err] of [
  ["mrs", mrsRes.error],
  ["epics", epicsRes.error],
  ["jobs", jobsRes.error],
] as const) {
  // stderr only — stdout must stay pure JSON.
  if (err) console.error(`[rib-osdu] events ${name} degraded: ${err}`);
}

const openMrs = mrsRes.json ? extractFeedMrs(mrsRes.json) : [];
const mergedMrs = epicsRes.json ? extractMergedRelatedMrs(epicsRes.json) : [];

process.stdout.write(
  JSON.stringify(buildEventsBoard({ openMrs, mergedMrs, jobs: jobsRes.jobs, now: new Date() })),
);
