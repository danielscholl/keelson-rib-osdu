#!/usr/bin/env bun
import { verifyCimplContext } from "../src/cluster-actions.ts";
import { localExec } from "../src/exec.ts";

// This gate closes the action-to-workflow TOCTOU window; it is not a view
// collector, so it binds no snapshot key and fails closed.
try {
  const denial = await verifyCimplContext(localExec());
  if (denial) {
    console.error(`refusing Delete: ${denial}`);
    process.exit(1);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`refusing Delete: failed to verify CIMPL context (${detail})`);
  process.exit(1);
}
