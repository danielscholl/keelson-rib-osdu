#!/usr/bin/env bun
/**
 * Topology collector — the deterministic producer behind the `osdu-topology`
 * workflow. Reads Flux Kustomizations and HelmReleases via kubectl and prints a
 * single canvas graph-view JSON object to stdout (and nothing else, so the
 * workflow executor can promote it to structured output). Degrades to a valid
 * one-node graph when no cluster is reachable.
 */
import { getHelmReleases, getKustomizations } from "../src/kubectl.ts";
import { buildTopologyGraph } from "../src/topology.ts";

const [ks, hr] = await Promise.all([getKustomizations(), getHelmReleases()]);
if (ks.error) {
  // stderr only — stdout must stay pure JSON.
  console.error(`[rib-osdu] topology kustomizations degraded: ${ks.error}`);
}
if (hr.error) {
  // stderr only — stdout must stay pure JSON.
  console.error(`[rib-osdu] topology helmreleases degraded: ${hr.error}`);
}
const graph = buildTopologyGraph({
  context: ks.context,
  kustomizations: ks.kustomizations,
  helmreleases: hr.helmreleases,
});
process.stdout.write(JSON.stringify(graph));
