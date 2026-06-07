#!/usr/bin/env bun
/**
 * Security collector — the producer behind the `osdu-security` workflow. Composes
 * four one-shot sources (osdu-quality release, GitLab vulnerability GraphQL,
 * OSV.dev fix versions, the shared Venus bundle's vuln MRs) into the security
 * board inputs — the same fetch the `osdu_security` chat tool reuses — and prints
 * the board (and nothing else) to stdout. Each source degrades independently.
 */
import { buildSecurityBoard, fetchSecurityInputs } from "../src/security.ts";

const { inputs, errors } = await fetchSecurityInputs();
for (const err of errors) console.error(`[rib-osdu] security ${err}`);
process.stdout.write(JSON.stringify(buildSecurityBoard(inputs)));
