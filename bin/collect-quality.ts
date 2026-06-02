#!/usr/bin/env bun
/**
 * Quality collector — the producer behind the `osdu-quality` workflow. Shells
 * the one-shot `osdu-quality release --output json` CLI (which handles auth via
 * GITLAB_TOKEN or `glab`), shapes its report into a canvas board-view JSON
 * object, and prints that (and nothing else) to stdout. Degrades to a valid
 * empty board when the CLI is missing or errors.
 */
import { buildQualityBoard, type ReleaseReport } from "../src/quality.ts";

function runOsduQuality(timeoutMs = 120_000): { report?: ReleaseReport; error?: string } {
  try {
    const proc = Bun.spawnSync(["osdu-quality", "release", "--output", "json"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim().split("\n").pop() ?? "";
      return { error: stderr.length > 0 ? stderr : `osdu-quality exited ${proc.exitCode}` };
    }
    return { report: JSON.parse(proc.stdout.toString()) as ReleaseReport };
  } catch (e) {
    // CLI missing, not on PATH, timed out, or unparseable — degrade, don't throw.
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const { report, error } = runOsduQuality();
if (error) {
  // stderr only — stdout must stay pure JSON.
  console.error(`[rib-osdu] quality degraded: ${error}`);
}
process.stdout.write(JSON.stringify(buildQualityBoard(report ?? { services: [] })));
