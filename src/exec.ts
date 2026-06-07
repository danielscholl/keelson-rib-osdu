import type { RibExec } from "@keelson/shared";
import { runJSON, runText } from "@keelson/shared/exec";

// The harness hands tools a RibExec via `ctx.getExec()` — `{ runJSON, runText }`
// from `@keelson/shared/exec` (apps/server bootstrap). The standalone collectors
// have no RibContext, so they reach the same async, non-blocking exec here. One
// fetch path serves both: collectors call `localExec()`, tools pass the harness's
// `ctx.getExec()`, tests inject a fake.
export function localExec(): RibExec {
  return { runJSON, runText };
}

export function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
