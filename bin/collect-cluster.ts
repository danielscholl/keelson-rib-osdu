#!/usr/bin/env bun
/**
 * Cluster ICC collector — the producer behind the `osdu-cluster` workflow.
 * Shells `cimpl info --json` (endpoints + internal services + suspended state)
 * and reads Flux/HelmRelease readiness via kubectl, shapes them into a canvas
 * board-view JSON object, and prints that (and nothing else) to stdout. Each
 * source degrades independently to a valid "cluster unreachable" board.
 */
import { buildClusterBoard, type CimplInfo, type ClusterLifecycle } from "../src/cluster.ts";
import { currentContext, getReadiness } from "../src/kubectl.ts";

// Parse from the first JSON delimiter so a leading warning/preamble on stdout
// (cimpl can emit one even on success) doesn't discard otherwise-valid JSON.
function parseJsonLoose(text: string): unknown {
  const start = text.search(/[{[]/);
  return JSON.parse(start > 0 ? text.slice(start) : text);
}

function runCimplInfo(timeoutMs = 30_000): { info?: CimplInfo; error?: string } {
  try {
    const proc = Bun.spawnSync(["cimpl", "info", "--json"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim().split("\n").pop() ?? "";
      return { error: stderr.length > 0 ? stderr : `cimpl exited ${proc.exitCode}` };
    }
    return { info: parseJsonLoose(proc.stdout.toString()) as CimplInfo };
  } catch (e) {
    // CLI missing, not on PATH, timed out, or unparseable — degrade, don't throw.
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const { info, error: infoError } = runCimplInfo();
if (infoError) console.error(`[rib-osdu] cluster info degraded: ${infoError}`);

const context = currentContext();
const flux = getReadiness("kustomizations", ["-n", "flux-system"]);
const services = getReadiness("helmreleases", ["-A"]);
if (flux.error) console.error(`[rib-osdu] flux readiness degraded: ${flux.error}`);
if (services.error) console.error(`[rib-osdu] services readiness degraded: ${services.error}`);

const lifecycle: ClusterLifecycle = {
  context,
  // Reachable if any kubectl read succeeded; both failing means no cluster.
  reachable: !flux.error || !services.error,
  flux: { ready: flux.ready, total: flux.total },
  services: { ready: services.ready, total: services.total },
};

process.stdout.write(JSON.stringify(buildClusterBoard({ info, lifecycle })));
