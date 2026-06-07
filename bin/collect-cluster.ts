#!/usr/bin/env bun
/**
 * Cluster ICC collector — the producer behind the `osdu-cluster` workflow.
 * Fetches `cimpl info` (sanitized — passwords stripped) plus Flux/HelmRelease
 * readiness via kubectl — the same fetch the `osdu_cluster` chat tool reuses —
 * shapes them into a canvas board-view JSON object, and prints that (and nothing
 * else) to stdout. Each source degrades independently to a valid board.
 */
import { buildClusterBoard, type ClusterLifecycle, fetchClusterInfo } from "../src/cluster.ts";
import { clusterFingerprint, currentContext, getReadiness } from "../src/kubectl.ts";

const { info, error: infoError } = await fetchClusterInfo();
if (infoError) console.error(`[rib-osdu] cluster info degraded: ${infoError}`);

const context = currentContext();
const flux = await getReadiness("kustomizations", ["-n", "flux-system"]);
const services = await getReadiness("helmreleases", ["-A"]);
if (flux.error) console.error(`[rib-osdu] flux readiness degraded: ${flux.error}`);
if (services.error) console.error(`[rib-osdu] services readiness degraded: ${services.error}`);

const lifecycle: ClusterLifecycle = {
  context,
  fingerprint: clusterFingerprint(),
  // Reachable if cimpl info OR any kubectl read succeeded; only treat the
  // cluster as unreachable when every probe failed. A live cluster whose Flux
  // CRDs/RBAC degraded still rendered its access data, so it isn't "down" — the
  // Flux/Services rows report their own degraded counts.
  reachable: Boolean(info) || !flux.error || !services.error,
  flux: { ready: flux.ready, total: flux.total },
  services: { ready: services.ready, total: services.total },
};

process.stdout.write(JSON.stringify(buildClusterBoard({ info, lifecycle })));
