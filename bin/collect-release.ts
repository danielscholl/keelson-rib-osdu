#!/usr/bin/env bun
/**
 * Release Train collector — the producer behind the `osdu-release` workflow.
 * Reads the shared Venus bundle: open MRs (for the milestone identity + the New
 * Merge Requests queue) and merged MRs that ride epic `related_mrs` (the only
 * source carrying merged_at, for Platform Wins). Shapes them into a Release Train
 * board and prints that (and nothing else) to stdout. The active milestone is the
 * most-common token across open MRs (the CLI no longer pins it server-side, so
 * the bundle's all-core fetch makes the plurality correct). Degrades to a valid
 * board when a source errors.
 */
import { loadVenusBundle } from "../src/activity.ts";
import { extractMergedRelatedMrs } from "../src/events.ts";
import { resolvePmcReportUrl } from "../src/pmc.ts";
import {
  buildReleaseBoard,
  extractMilestoneFilter,
  extractReleaseMrs,
  resolveReleaseTrain,
} from "../src/release.ts";

const bundle = await loadVenusBundle();
for (const err of bundle.errors) console.error(`[rib-osdu] release ${err}`);

const openMrs = extractReleaseMrs(bundle.mrsRaw);
// Null without a server-side --milestone filter; buildReleaseBoard falls back to
// the most-common milestone across the open MRs.
const release = extractMilestoneFilter(bundle.mrsRaw);
const mergedMrs = extractMergedRelatedMrs(bundle.epicsRaw);
const train = resolveReleaseTrain(release, openMrs);
const pmcReportUrl = await resolvePmcReportUrl(train);

process.stdout.write(
  JSON.stringify(buildReleaseBoard({ openMrs, mergedMrs, release, pmcReportUrl, now: new Date() })),
);
