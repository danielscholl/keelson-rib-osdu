#!/usr/bin/env bun
/**
 * Cluster ICC collector — the producer behind the `osdu-cluster` workflow.
 * Fetches `cimpl info` (sanitized — passwords stripped) plus Flux/HelmRelease
 * readiness via kubectl — the same fetch the `osdu_cluster` chat tool reuses —
 * shapes them into a canvas board-view JSON object, and prints that (and nothing
 * else) to stdout. Each source degrades independently to a valid board.
 */
import { buildClusterBoard, type ClusterLifecycle, fetchClusterInfo } from "../src/cluster.ts";
import { clusterFingerprint, currentContext, getReadiness, listContexts } from "../src/kubectl.ts";

const { info, error: infoError, deployment } = await fetchClusterInfo();
if (infoError) console.error(`[rib-osdu] cluster info degraded: ${infoError}`);

const context = currentContext();
const contexts = await listContexts();
const flux = await getReadiness("kustomizations", ["-n", "flux-system"]);
const services = await getReadiness("helmreleases", ["-A"]);
if (flux.error) console.error(`[rib-osdu] flux readiness degraded: ${flux.error}`);
if (services.error) console.error(`[rib-osdu] services readiness degraded: ${services.error}`);

const fingerprint = clusterFingerprint();
const lifecycle: ClusterLifecycle = {
  context,
  fingerprint,
  // Reachable if any probe got an answer from the API server: cimpl info, the
  // kube-system fingerprint read, or either Flux read. The Flux probes alone
  // must not decide — a cluster without Flux CRDs fails both with "no resource
  // type" while being fully up (the foreign-context case).
  reachable: Boolean(info) || Boolean(fingerprint) || !flux.error || !services.error,
  flux: { ready: flux.ready, total: flux.total },
  services: { ready: services.ready, total: services.total },
  contexts,
};

process.stdout.write(JSON.stringify(buildClusterBoard({ info, deployment, lifecycle })));
