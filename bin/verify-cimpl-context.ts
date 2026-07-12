#!/usr/bin/env bun
import { actionGuardError } from "../src/cluster.ts";
import { verifyCimplContext } from "../src/cluster-actions.ts";
import { localExec } from "../src/exec.ts";
import { getClusterFingerprint, getCurrentContext } from "../src/kubectl.ts";

// This gate closes the action-to-workflow TOCTOU window; it is not a view
// collector, so it binds no snapshot key and fails closed.
try {
  const exec = localExec();
  const payload: { context?: string; fingerprint?: string } = {
    context: process.env.KEELSON_INPUTS_context,
  };
  const expectedFingerprint = process.env.KEELSON_INPUTS_fingerprint;
  if (typeof expectedFingerprint === "string" && expectedFingerprint.length > 0) {
    payload.fingerprint = expectedFingerprint;
  }

  const liveContext = await getCurrentContext(exec);
  const identityGuard = actionGuardError(
    payload,
    liveContext,
    liveContext ? await getClusterFingerprint(exec) : null,
  );
  if (identityGuard) {
    console.error(`refusing Delete: ${identityGuard}`);
    process.exit(1);
  }

  const denial = await verifyCimplContext(exec);
  if (denial) {
    console.error(`refusing Delete: ${denial}`);
    process.exit(1);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`refusing Delete: failed to verify CIMPL context (${detail})`);
  process.exit(1);
}
