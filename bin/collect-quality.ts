#!/usr/bin/env bun
/**
 * Quality collector — the producer behind the `osdu-quality` workflow. Fetches
 * the one-shot `osdu-quality release` report (the same fetch the `osdu_quality`
 * chat tool reuses), shapes it into a canvas board-view JSON object, and prints
 * that (and nothing else) to stdout. Exits non-zero when the report fetch
 * degraded, so the lane keeps its last good snapshot instead of zeros.
 */
import { buildQualityBoard, fetchReleaseReport } from "../src/quality.ts";

const { report, error } = await fetchReleaseReport();
// A degraded fetch yields an empty report, and an empty board is structurally
// valid — publishing it would overwrite the last good snapshot with zeros for
// the lane's whole cadence. Fail the run instead, so the reason stays visible.
if (error) {
  console.error(`[rib-osdu] quality degraded: ${error}`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(buildQualityBoard(report)));
