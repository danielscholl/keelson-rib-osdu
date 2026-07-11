import type { RibContext, RibExec, ToolContext, ToolDefinition } from "@keelson/shared";
import { errText, z } from "@keelson/shared";
import { fetchMyMergeRequests, loadVenusBundle } from "./activity.ts";
import { fetchClusterInfo } from "./cluster.ts";
import {
  CLUSTER_LIFECYCLE_ARGS,
  type ClusterVerb,
  runClusterLifecycle,
  verifyCimplContext,
} from "./cluster-actions.ts";
import { extractFeedMrs, extractMergedRelatedMrs } from "./events.ts";
import { extractEpics, extractMrs } from "./features.ts";
import {
  getCurrentContext,
  getHelmReleases,
  getJobs,
  getKustomizations,
  getReadiness,
  listContexts,
} from "./kubectl.ts";
import { fetchReleaseReport } from "./quality.ts";
import { extractMilestoneFilter, extractReleaseMrs } from "./release.ts";
import { fetchSecurityInputs } from "./security.ts";
import { composeQueue } from "./waiting.ts";

// Tool results stream to chat as `tool_result` chunks; keep each one well under
// the chat context budget. Truncation is signalled, never silent.
const MAX_TOOL_RESULT_CHARS = 16_000;

// Compact (not pretty) so the cap carries more data and large payloads aren't
// fully pretty-printed just to be sliced away.
function boundedJson(data: unknown): string {
  const full = JSON.stringify(data);
  if (full.length <= MAX_TOOL_RESULT_CHARS) return full;
  const omitted = full.length - MAX_TOOL_RESULT_CHARS;
  return `${full.slice(0, MAX_TOOL_RESULT_CHARS)}\n…(truncated — ${omitted} more chars; ask for a narrower slice)`;
}

function emitResult(ctx: ToolContext, content: string, isError = false): void {
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

// A read tool: fetch the live rows behind a panel, emit them as bounded JSON.
// Never throws — a degraded source surfaces as an error tool_result. The fetched
// result is always emitted (no abort early-return): suppressing the emit would
// make a cancelled read look like an empty-but-successful result to the model.
function readTool(
  name: string,
  description: string,
  fetch: () => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: z.object({}),
    state_changing: false,
    async execute(_input, ctx) {
      try {
        emitResult(ctx, boundedJson(await fetch()));
      } catch (e) {
        emitResult(ctx, `${name} failed: ${errText(e)}`, true);
      }
    },
  };
}

const confirmSchema = z.object({ confirm: z.boolean().default(false) });

// A reversible cluster-lifecycle tool, self-gated by an in-tool `confirm` flag
// (keelson chat does not pause on requires_confirmation yet). Without confirm it
// reports what it WOULD run; with confirm it verifies the context is CIMPL, then
// runs the verb. Acts on the live kubectl current-context.
function lifecycleTool(exec: RibExec, verb: ClusterVerb, action: string): ToolDefinition {
  const name = `osdu_cluster_${verb}`;
  const cmd = `cimpl ${CLUSTER_LIFECYCLE_ARGS[verb].join(" ")}`;
  return {
    name,
    description:
      `${action} the current CIMPL dev cluster (\`${cmd}\`). Reversible. State-changing: ` +
      `set confirm:true ONLY after the user has explicitly approved running it — without ` +
      `confirm the tool reports what it would do and runs nothing. Acts on the live kubectl ` +
      `current-context; refused unless that context is a confirmed CIMPL deployment. ` +
      `NOT for creating or deleting clusters.`,
    inputSchema: confirmSchema,
    state_changing: true,
    requires_confirmation: true,
    async execute(input, ctx) {
      const parsed = confirmSchema.safeParse(input);
      const confirm = parsed.success && parsed.data.confirm === true;
      const context = await getCurrentContext(exec);
      if (!confirm) {
        emitResult(
          ctx,
          `Would run \`${cmd}\` on context "${context ?? "none"}". Re-call ${name} with confirm:true once the user approves.`,
        );
        return;
      }
      try {
        const denial = await verifyCimplContext(exec);
        if (denial) {
          emitResult(ctx, `Refused: ${denial}`, true);
          return;
        }
        // The exec can't cancel an in-flight cimpl run, so the most we can do is
        // not START the mutation if the turn was cancelled during verification.
        if (ctx.abortSignal.aborted) return;
        const res = await runClusterLifecycle(exec, verb, 120_000);
        if (res.ok) {
          emitResult(
            ctx,
            `Ran \`${res.ran}\` on "${context}". The Cluster ICC board will reflect the new state on its next refresh.`,
          );
        } else {
          emitResult(ctx, `\`${cmd}\` failed: ${res.error}`, true);
        }
      } catch (e) {
        emitResult(ctx, `${name} failed: ${errText(e)}`, true);
      }
    },
  };
}

// The OSDU rib's chat tools: one read tool per dashboard panel (the same data
// layer the visualizations use) plus the reversible cluster-lifecycle verbs.
// `registerTools` captures the RibContext once at boot; the tools close over its
// exec so each call routes through the harness's async, non-blocking exec.
export function registerOsduTools(ctx: RibContext): ToolDefinition[] {
  const exec = ctx.getExec();
  return [
    readTool(
      "osdu_quality",
      "Use when the user asks about platform release quality, test pass rates, Sonar grades, coverage, or which services are failing. Returns the live `osdu-quality release` report: per-service acceptance/unit pass rates, coverage, reliability/security/maintainability grades, and vulnerability counts. Read-only. NOT for changing pipelines or merging.",
      async () => {
        const { report, error } = await fetchReleaseReport(exec);
        return { report, notes: error ? [`quality degraded: ${error}`] : [] };
      },
    ),
    readTool(
      "osdu_security",
      "Use when the user asks about platform security posture — critical/high CVEs, aged vulnerabilities, vulnerable dependencies, quick-win bumps, or security MRs. Returns live per-service security ratings and vuln counts, per-CVE detail (severity/state/package), OSV fix versions, and open vulnerability-labeled MRs. Read-only. NOT for patching or merging.",
      async () => {
        const { inputs, errors } = await fetchSecurityInputs(exec);
        return {
          services: inputs.report.services?.map((s) => ({
            name: s.display_name || s.name,
            security_rating: s.sonar?.security_rating ?? null,
            vulnerabilities: s.vulnerabilities ?? null,
          })),
          vulns: inputs.vulns,
          fixes: Object.fromEntries(inputs.fixes ?? new Map()),
          vulnMrs: inputs.mrs,
          notes: errors,
        };
      },
    ),
    readTool(
      "osdu_features",
      "Use when the user asks what's moving or stalled — open MRs, epics in flight, stalled work. Returns live core-scoped epics (with assignees/progress) and open merge requests. Read-only. NOT for merging or editing MRs.",
      async () => {
        const b = await loadVenusBundle();
        return { epics: extractEpics(b.epicsRaw), mrs: extractMrs(b.mrsRaw), notes: b.errors };
      },
    ),
    readTool(
      "osdu_release",
      "Use when the user asks about the active release train — the current milestone, queued new MRs, or what merged to main this week. Returns the active milestone, open release MRs, and recently merged core MRs. Read-only. NOT for merging or changing the release.",
      async () => {
        const b = await loadVenusBundle();
        return {
          milestone: extractMilestoneFilter(b.mrsRaw),
          openMrs: extractReleaseMrs(b.mrsRaw),
          mergedMrs: extractMergedRelatedMrs(b.epicsRaw),
          notes: b.errors,
        };
      },
    ),
    readTool(
      "osdu_events",
      "Use when the user asks what just happened or for recent platform + cluster motion. Returns newest-first open/merged MRs (PLATFORM) and recent kubectl Jobs (CLUSTER). Read-only. NOT for changing cluster state or merging.",
      async () => {
        const [b, jobs] = await Promise.all([loadVenusBundle(), getJobs(exec)]);
        return {
          openMrs: extractFeedMrs(b.mrsRaw),
          mergedMrs: extractMergedRelatedMrs(b.epicsRaw),
          jobs: jobs.jobs,
          notes: [...b.errors, ...(jobs.error ? [`jobs: ${jobs.error}`] : [])],
        };
      },
    ),
    readTool(
      "osdu_waiting",
      "Use when the user asks what needs their attention, their queue, or what they're blocking. Returns the operator's personal queue: their MRs with a failed pipeline / changes requested / ready to merge, MRs awaiting their review, not-ready Flux resources, and failed load jobs — priority-sorted. Read-only. NOT for merging, approving, or reconciling.",
      async () => {
        const [mrs, k, h, j] = await Promise.all([
          fetchMyMergeRequests(),
          getKustomizations(undefined, exec),
          getHelmReleases(exec),
          getJobs(exec),
        ]);
        const notes = [
          k.error && `kustomizations: ${k.error}`,
          h.error && `helmreleases: ${h.error}`,
          j.error && `jobs: ${j.error}`,
        ].filter((n): n is string => Boolean(n));
        return {
          queue: composeQueue({
            mrs,
            kustomizations: k.kustomizations,
            helmreleases: h.helmreleases,
            jobs: j.jobs,
            now: new Date(),
          }),
          notes,
        };
      },
    ),
    readTool(
      "osdu_cluster",
      "Use when the user asks about the CIMPL dev cluster's health, access, or where a service/portal is. Returns the live kubectl context, Flux/HelmRelease readiness, and sanitized `cimpl info` access data (endpoints + internal services + which services have credentials — passwords are never returned). Read-only. NOT for creating, deleting, or reconciling the cluster (use the lifecycle tools).",
      async () => {
        const [{ info, error }, context, flux, services] = await Promise.all([
          fetchClusterInfo(exec),
          getCurrentContext(exec),
          getReadiness("kustomizations", ["-n", "flux-system"], exec),
          getReadiness("helmreleases", ["-A"], exec),
        ]);
        const notes = [
          error && `info: ${error}`,
          flux.error && `flux: ${flux.error}`,
          services.error && `services: ${services.error}`,
        ].filter((n): n is string => Boolean(n));
        return { context, info, flux, services, notes };
      },
    ),
    readTool(
      "osdu_topology",
      "Use when the user asks about cluster reconciliation health or the Flux topology. Returns the live Flux Kustomizations (name, namespace, ready conditions, dependencies) on the active context. Read-only. NOT for changing cluster state.",
      async () => {
        const r = await getKustomizations(undefined, exec);
        return {
          context: r.context,
          kustomizations: r.kustomizations,
          notes: r.error ? [`kustomizations: ${r.error}`] : [],
        };
      },
    ),
    readTool(
      "osdu_contexts",
      "Use when the user asks which CIMPL clusters they have or which kubectl context is active. Returns the current context plus the cimpl-managed contexts on the machine (prefix-filtered; CIMPL_CONTEXT_PREFIXES overrides the default prefix set), degrading to an empty list when kubectl is unavailable. Read-only. NOT for switching contexts or changing cluster state.",
      async () => {
        const [current, contexts] = await Promise.all([
          getCurrentContext(exec),
          listContexts(exec),
        ]);
        return { current, contexts };
      },
    ),
    lifecycleTool(exec, "reconcile", "Reconcile Flux on"),
    lifecycleTool(exec, "suspend", "Suspend Flux reconciliation on"),
    lifecycleTool(exec, "resume", "Resume Flux reconciliation on"),
  ];
}
