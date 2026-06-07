#!/usr/bin/env bun
/**
 * Quality collector — the producer behind the `osdu-quality` workflow. Fetches
 * the one-shot `osdu-quality release` report (the same fetch the `osdu_quality`
 * chat tool reuses), shapes it into a canvas board-view JSON object, and prints
 * that (and nothing else) to stdout. Degrades to a valid empty board.
 */
import { buildQualityBoard, fetchReleaseReport } from "../src/quality.ts";

const { report, error } = await fetchReleaseReport();
if (error) console.error(`[rib-osdu] quality degraded: ${error}`);
process.stdout.write(JSON.stringify(buildQualityBoard(report)));
