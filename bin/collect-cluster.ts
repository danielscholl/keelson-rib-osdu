#!/usr/bin/env bun
/**
 * Cluster board collector — the producer behind the `osdu-cluster` workflow.
 * Fetches `cimpl info` (sanitized — passwords stripped) plus Flux/HelmRelease
 * readiness via kubectl — the same fetch the `osdu_cluster` chat tool reuses —
 * shapes them into a canvas board-view JSON object, and prints that (and nothing
 * else) to stdout. Each source degrades independently to a valid board.
 */
import { buildClusterBoard, type ClusterLifecycle, fetchClusterInfo } from "../src/cluster.ts";
import {
  clearCreateMarker,
  markerExpired,
  markerInFlight,
  readCreateMarker,
} from "../src/create-marker.ts";
import { clusterFingerprint, currentContext, getReadiness, listContexts } from "../src/kubectl.ts";

const { info, error: infoError, deployment } = await fetchClusterInfo();
if (infoError) console.error(`[rib-osdu] cluster info degraded: ${infoError}`);

const context = currentContext();
const contexts = await listContexts();
const flux = await getReadiness("kustomizations", ["-n", "flux-system"]);
const services = await getReadiness("helmreleases", ["-A"]);
if (flux.error) console.error(`[rib-osdu] flux readiness degraded: ${flux.error}`);
if (services.error) console.error(`[rib-osdu] services readiness degraded: ${services.error}`);

// The create-dispatch marker rides in from the rib's data dir (path baked into
// this node's env by contributeWorkflows). An in-flight marker survives the
// deployment going live — the operating board reads it as Bootstrapping until
// the run's terminal event (or the window) settles it. A live deployment
// clears a settled marker rather than warn beside a working cluster; a
// day-old marker is abandoned noise and clears too.
const now = Date.now();
const dataDir = process.env.RIB_OSDU_DATA_DIR;
let createMarker = dataDir ? readCreateMarker(dataDir) : undefined;
if (
  dataDir &&
  createMarker &&
  ((info && !markerInFlight(createMarker, now)) || markerExpired(createMarker, now))
) {
  clearCreateMarker(dataDir);
  createMarker = undefined;
}

const fingerprint = clusterFingerprint();
const lifecycle: ClusterLifecycle = {
  context,
  fingerprint,
  // Reachable if any probe got an answer from the API server: cimpl info, the
  // kube-system fingerprint read, or either Flux read. The Flux probes alone
  // must not decide — a cluster without Flux CRDs fails both with "no resource
  // type" while being fully up (the foreign-context case).
  reachable: Boolean(info) || Boolean(fingerprint) || !flux.error || !services.error,
  // `stalled` only rides when the read succeeded — a degraded collection must
  // read as stalled-unknown ("Degraded"), never as cleanly converging.
  flux: { ready: flux.ready, total: flux.total, ...(flux.error ? {} : { stalled: flux.stalled }) },
  services: {
    ready: services.ready,
    total: services.total,
    ...(services.error ? {} : { stalled: services.stalled }),
  },
  contexts,
};

process.stdout.write(
  JSON.stringify(
    buildClusterBoard({
      info,
      deployment,
      lifecycle,
      now,
      ...(createMarker ? { createMarker } : {}),
    }),
  ),
);
