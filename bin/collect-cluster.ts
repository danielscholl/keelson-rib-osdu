#!/usr/bin/env bun
/**
 * Cluster ICC collector — the producer behind the `osdu-cluster` workflow.
 * Shells `cimpl info --json --show-secrets` (endpoints + internal services +
 * credentials + suspended state) and reads Flux/HelmRelease readiness via
 * kubectl, shapes them into a canvas board-view JSON object, and prints that
 * (and nothing else) to stdout. `--show-secrets` is used ONLY to enumerate
 * which services have credentials; passwords are stripped here and never reach
 * the board — the reveal-credential action re-fetches a single password on copy.
 * Each source degrades independently to a valid "cluster unreachable" board.
 */
import {
  buildClusterBoard,
  type CimplInfo,
  type ClusterLifecycle,
  hasRealSecret,
  parseCimplInfoJson,
} from "../src/cluster.ts";
import { currentContext, getReadiness } from "../src/kubectl.ts";

// Pick only the fields the board needs; drop each credential's `password` so a
// plaintext secret never crosses into the published snapshot.
function sanitizeInfo(raw: unknown): CimplInfo {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const creds = Array.isArray(obj.credentials) ? obj.credentials : [];
  return {
    endpoints: obj.endpoints as CimplInfo["endpoints"],
    internal_services: obj.internal_services as CimplInfo["internal_services"],
    suspended: obj.suspended === true,
    // Keep only credentials that actually have a secret (cimpl emits "n/a"
    // placeholders during partial deployments) and a service name — a copy
    // affordance for a nonexistent secret would copy the placeholder.
    credentials: creds
      .map((c) => (c ?? {}) as Record<string, unknown>)
      .filter((c) => String(c.service ?? "").trim().length > 0 && hasRealSecret(c.password))
      .map((c) => ({
        service: String(c.service),
        username: typeof c.username === "string" ? c.username : undefined,
      })),
  };
}

function runCimplInfo(timeoutMs = 30_000): { info?: CimplInfo; error?: string } {
  try {
    const proc = Bun.spawnSync(["cimpl", "info", "--json", "--show-secrets"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString().trim().split("\n").pop() ?? "";
      return { error: stderr.length > 0 ? stderr : `cimpl exited ${proc.exitCode}` };
    }
    return { info: sanitizeInfo(parseCimplInfoJson(proc.stdout.toString())) };
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
  // Reachable if cimpl info OR any kubectl read succeeded; only treat the
  // cluster as unreachable when every probe failed. A live cluster whose Flux
  // CRDs/RBAC degraded still rendered its access data, so it isn't "down" — the
  // Flux/Services rows report their own degraded counts.
  reachable: Boolean(info) || !flux.error || !services.error,
  flux: { ready: flux.ready, total: flux.total },
  services: { ready: services.ready, total: services.total },
};

process.stdout.write(JSON.stringify(buildClusterBoard({ info, lifecycle })));
