#!/usr/bin/env bun
/**
 * Waiting on You collector — the producer behind the `osdu-waiting` workflow.
 * Composes the operator's personal queue: their GitLab dashboard MRs (authored
 * with a failed pipeline / changes requested / ready to merge, plus MRs awaiting
 * their review) via `currentUser`, joined with cluster resources that need a
 * human (not-ready Flux Kustomizations/HelmReleases, failed load Jobs). Prints a
 * Waiting on You board and nothing else; degrades to a valid (empty) board when a
 * source errors.
 */
import { fetchMyMergeRequests } from "../src/activity.ts";
import { getHelmReleases, getJobs, getKustomizations } from "../src/kubectl.ts";
import { buildWaitingBoard, composeQueue } from "../src/waiting.ts";

const mrs = fetchMyMergeRequests();
const { kustomizations, error: kErr } = getKustomizations();
if (kErr) console.error(`[rib-osdu] waiting kustomizations degraded: ${kErr}`);
const { helmreleases, error: hErr } = getHelmReleases();
if (hErr) console.error(`[rib-osdu] waiting helmreleases degraded: ${hErr}`);
const { jobs, error: jErr } = getJobs();
if (jErr) console.error(`[rib-osdu] waiting jobs degraded: ${jErr}`);

const items = composeQueue({ mrs, kustomizations, helmreleases, jobs, now: new Date() });
process.stdout.write(JSON.stringify(buildWaitingBoard(items)));
