#!/usr/bin/env bun
/**
 * Features collector — the producer behind the `osdu-features` workflow. Shells
 * the one-shot `osdu-activity epic list` and `osdu-activity mr` CLIs (which
 * handle auth via GITLAB_TOKEN or `glab`), shapes their JSON into a canvas
 * board-view object, and prints that (and nothing else) to stdout. Degrades to
 * a valid empty board when a CLI is missing or errors.
 */
import { buildFeaturesBoard, extractEpics, extractMrs } from "../src/features.ts";

// `osdu-activity epic list` emits unescaped control characters (raw newlines in
// epic descriptions) that JSON.parse rejects; strip them before parsing.
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

// Scope to the Venus release via the CLI's own filters (`--label Venus` for
// epics, `--milestone Venus` fuzzy for MRs) — no hardcoded service list. Raise
// the row caps and include drafts: the defaults (50 newest-motion epics, 20
// MRs/project, drafts off) silently truncate before the board summarizes.
const EPIC_LIMIT = 500;
const MR_LIMIT = 1000;
const VENUS = "Venus";

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
const mrsRes = runActivity([
  "mr",
  "--milestone",
  VENUS,
  "--output",
  "json",
  "--include-draft",
  "--limit",
  String(MR_LIMIT),
]);
for (const [name, res] of [
  ["epics", epicsRes],
  ["mrs", mrsRes],
] as const) {
  // stderr only — stdout must stay pure JSON.
  if (res.error) console.error(`[rib-osdu] features ${name} degraded: ${res.error}`);
}

const epics = epicsRes.json ? extractEpics(epicsRes.json) : [];
const mrs = mrsRes.json ? extractMrs(mrsRes.json) : [];
if (epics.length >= EPIC_LIMIT) {
  console.error(
    `[rib-osdu] features: epic list hit the ${EPIC_LIMIT}-row cap — board may underreport`,
  );
}
process.stdout.write(JSON.stringify(buildFeaturesBoard(epics, mrs, new Date())));
