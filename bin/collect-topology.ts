#!/usr/bin/env bun
/**
 * Topology collector — the deterministic producer behind the `osdu-topology`
 * workflow. Reads Flux Kustomizations via kubectl and prints a single
 * canvas graph-view JSON object to stdout (and nothing else, so the workflow
 * executor can promote it to structured output). Degrades to a valid one-node
 * graph when no cluster is reachable.
 */
import { getKustomizations } from "../src/kubectl.ts";
import { buildTopologyGraph } from "../src/topology.ts";

const result = getKustomizations();
if (result.error) {
  // stderr only — stdout must stay pure JSON.
  console.error(`[rib-osdu] topology degraded: ${result.error}`);
}
const graph = buildTopologyGraph({
  context: result.context,
  kustomizations: result.kustomizations,
});
process.stdout.write(JSON.stringify(graph));
