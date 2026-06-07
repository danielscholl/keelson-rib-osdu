#!/usr/bin/env bun
/**
 * Current Events collector — the producer behind the `osdu-events` workflow.
 * Reads the shared Venus bundle (open MRs + merged MRs riding epic `related_mrs`,
 * the only source carrying merged_at) plus `kubectl get jobs`, shapes recent
 * motion into a canvas board feed, and prints that (and nothing else) to stdout.
 * Degrades to a valid board when a source is missing or errors.
 */
import { loadVenusBundle } from "../src/activity.ts";
import { buildEventsBoard, extractFeedMrs, extractMergedRelatedMrs } from "../src/events.ts";
import { getJobs } from "../src/kubectl.ts";

const bundle = loadVenusBundle();
const jobsRes = getJobs();
for (const err of bundle.errors) console.error(`[rib-osdu] events ${err}`);
if (jobsRes.error) console.error(`[rib-osdu] events jobs degraded: ${jobsRes.error}`);

const openMrs = extractFeedMrs(bundle.mrsRaw);
const mergedMrs = extractMergedRelatedMrs(bundle.epicsRaw);

process.stdout.write(
  JSON.stringify(buildEventsBoard({ openMrs, mergedMrs, jobs: jobsRes.jobs, now: new Date() })),
);
