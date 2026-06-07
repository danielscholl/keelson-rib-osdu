#!/usr/bin/env bun
/**
 * Features collector — the producer behind the `osdu-features` workflow. Reads
 * the shared Venus bundle (open MRs scoped to core services + enriched epics),
 * shapes it into a canvas board-view object, and prints that (and nothing else)
 * to stdout. Degrades to a valid empty board when a source errors.
 */
import { loadVenusBundle } from "../src/activity.ts";
import { buildFeaturesBoard, extractEpics, extractMrs } from "../src/features.ts";

const bundle = await loadVenusBundle();
for (const err of bundle.errors) console.error(`[rib-osdu] features ${err}`);

const epics = extractEpics(bundle.epicsRaw);
const mrs = extractMrs(bundle.mrsRaw);

process.stdout.write(JSON.stringify(buildFeaturesBoard(epics, mrs, new Date())));
