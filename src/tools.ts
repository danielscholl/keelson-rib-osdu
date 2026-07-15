import type { RibContext, RibExec, ToolContext, ToolDefinition } from "@keelson/shared";
import { errText, z } from "@keelson/shared";
import { fetchMyMergeRequests, loadVenusBundle, serviceOf, VENUS_CORE } from "./activity.ts";
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
import {
  compareVulns,
  dedupeVulns,
  fetchSecurityInputs,
  osvFixKey,
  osvFixParts,
  SEVERITIES,
} from "./security.ts";
import { fetchSetupCheck, SETUP_PROVIDERS } from "./setup.ts";
import { composeQueue } from "./waiting.ts";

// Tool results stream to chat as `tool_result` chunks; keep each one well under
// the chat context budget.
const MAX_TOOL_RESULT_CHARS = 16_000;

// Compact (not pretty) so the cap carries more data.
//
// An oversized result becomes a valid envelope rather than a slice of the real
// one. The reader is a model: a JSON document cut at a byte boundary does not
// parse, so slicing does not cost it the tail — it costs it everything, and the
// note explaining why arrives inside the wreckage. A tool that can overflow is
// expected to bound its own payload (see fitToCap) and report what it dropped;
// this is the floor that keeps a miss from emitting garbage.
//
// `hint` must be true for the calling tool: telling a caller to narrow a request
// it has no arguments to narrow is an invitation to retry the same call forever.
function boundedJson(data: unknown, hint: string): string {
  const full = JSON.stringify(data);
  if (full.length <= MAX_TOOL_RESULT_CHARS) return full;
  return JSON.stringify({
    error: `result is ${full.length} chars, over the ${MAX_TOOL_RESULT_CHARS} limit, and was not returned`,
    hint,
  });
}

// The largest prefix of `rows` whose built result still fits. Callers order rows
// worst-first, so dropping from the tail sheds the least actionable detail, and
// `build` recomputes the whole result — including its own count of what was
// dropped — for whatever prefix survives.
//
// Bound by serialized size rather than a row count: row size varies by service,
// so any fixed count is tuned against one of them and wrong for the rest.
export function fitToCap<T>(rows: readonly T[], build: (kept: readonly T[]) => unknown): number {
  const fits = (n: number): boolean =>
    JSON.stringify(build(rows.slice(0, n))).length <= MAX_TOOL_RESULT_CHARS;
  if (fits(rows.length)) return rows.length;
  // Each probe serializes the whole result, so bisect rather than walk.
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function emitResult(ctx: ToolContext, content: string, isError = false): void {
  ctx.emit({ type: "tool_result", toolUseId: "", content, ...(isError ? { isError: true } : {}) });
}

// A read tool: fetch the live rows behind a panel, emit them as bounded JSON.
// Never throws — a degraded source surfaces as an error tool_result. The fetched
// result is always emitted (no abort early-return): suppressing the emit would
// make a cancelled read look like an empty-but-successful result to the model.
// `inputSchema` defaults to the no-argument shape; pass one to take arguments,
// and `fetch` receives the parsed input.
function readTool<S extends z.ZodType = z.ZodType<Record<string, never>>>(
  name: string,
  description: string,
  fetch: (input: z.infer<S>) => Promise<unknown>,
  inputSchema?: S,
): ToolDefinition {
  const schema = (inputSchema ?? z.object({})) as S;
  // Only a tool that declares a schema has anything to narrow with; the rest
  // take no arguments, so advising them to narrow would loop the caller through
  // the identical call. Say what is actually true of each.
  const overflowHint =
    inputSchema === undefined
      ? `${name} takes no arguments, so this result cannot be narrowed — the source returned more than the limit allows. Report that rather than retrying.`
      : "narrow the request (e.g. a single service, or a severity filter) and call again";
  return {
    name,
    description,
    inputSchema: schema,
    state_changing: false,
    async execute(input, ctx) {
      // Refuse malformed arguments rather than falling back to the argument-free
      // fetch: every argument here narrows scope, so silently dropping one turns
      // a cheap read into the full-platform sweep the caller was avoiding.
      const parsed = schema.safeParse(input ?? {});
      if (!parsed.success) {
        emitResult(ctx, `${name}: invalid arguments — ${parsed.error.message}`, true);
        return;
      }
      try {
        emitResult(ctx, boundedJson(await fetch(parsed.data), overflowHint));
      } catch (e) {
        emitResult(ctx, `${name} failed: ${errText(e)}`, true);
      }
    },
  };
}

// Comma-separated service names -> the validated scope both scoped read tools
// take. Unknown names are returned separately so the tool can refuse loudly: a
// typo silently scoping to nothing would read as "this service is clean".
function parseServices(raw: string | undefined): { services: string[]; unknown: string[] } {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    services: names.filter((n) => VENUS_CORE.has(n)),
    unknown: names.filter((n) => !VENUS_CORE.has(n)),
  };
}

// Strict: a stray key must fail rather than be stripped. Every argument here
// narrows scope, so a silently-dropped typo (`servicee`) would parse as "no
// scope" and run the full-platform sweep the caller was trying to avoid.
const serviceScopeSchema = z.object({ service: z.string().optional() }).strict();
const securityScopeSchema = z
  .object({
    service: z.string().optional(),
    severity: z.string().optional(),
  })
  .strict();

function parseSeverities(raw: string | undefined): { severities: string[]; unknown: string[] } {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = new Set<string>(SEVERITIES);
  return {
    severities: names.filter((n) => valid.has(n)),
    unknown: names.filter((n) => !valid.has(n)),
  };
}

function scopeLabel(services: readonly string[]): string {
  return services.length > 0 ? services.join(",") : "all core services";
}

// Refuse an unrecognized service instead of scoping to nothing, which would
// otherwise hand back an empty report the model would read as "no findings".
function unknownServiceError(unknown: readonly string[]): {
  error: string;
  validServices: string[];
} {
  return {
    error: `unknown service(s): ${unknown.join(", ")} — no report was fetched`,
    validServices: [...VENUS_CORE].sort(),
  };
}

const SERVICE_SCOPE_DOC =
  "Optional `service` scopes the report to one or more core services (comma-separated, e.g. " +
  "'partition' or 'partition,storage'). STRONGLY prefer it when the question is about specific " +
  `services: unscoped covers all ${VENUS_CORE.size} core services, which is slow enough to time out ` +
  "and large enough to truncate. Valid names are the core service slugs (e.g. partition, storage, " +
  "legal, entitlements); an unrecognized name is refused rather than silently ignored.";

const confirmSchema = z.object({ confirm: z.boolean().default(false) });
const setupProviderSchema = z.object({ provider: z.enum(SETUP_PROVIDERS).optional() });

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
            `Ran \`${res.ran}\` on "${context}". The Cluster board will reflect the new state on its next refresh.`,
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
      `Use when the user asks about platform release quality, test pass rates, Sonar grades, coverage, or which services are failing. Returns the live \`osdu-quality release\` report: per-service acceptance/unit pass rates, coverage, reliability/security/maintainability grades, and vulnerability counts. ${SERVICE_SCOPE_DOC} Read-only. NOT for changing pipelines or merging.`,
      async ({ service }) => {
        const { services, unknown } = parseServices(service);
        if (unknown.length > 0) return unknownServiceError(unknown);
        const { report, error } = await fetchReleaseReport(exec, services);
        return {
          scope: scopeLabel(services),
          report,
          notes: error ? [`quality degraded: ${error}`] : [],
        };
      },
      serviceScopeSchema,
    ),
    readTool(
      "osdu_security",
      `Use when the user asks about platform security posture — critical/high CVEs, aged vulnerabilities, vulnerable dependencies, quick-win bumps, or security MRs. Returns, per service, SonarCloud's static-analysis grade for the service's OWN code (\`sonar_security_rating\`) and — separately — CVE counts in its DEPENDENCIES (\`dependency_vulnerabilities\`); the grade says nothing about those CVEs, so a service can rate A and still carry criticals. Also returns per-CVE detail (severity/state/package), OSV fix versions, and open vulnerability-labeled MRs. ${SERVICE_SCOPE_DOC} Optional \`severity\` narrows the per-CVE rows (comma-separated: ${SEVERITIES.join(", ")}); rows come back worst-first and are trimmed to fit the result size limit, with \`vulnCounts\` and \`notes\` reporting how many matched versus how many were returned — narrow by severity to see the rest. Read-only. NOT for patching or merging.`,
      async ({ service, severity }) => {
        const { services, unknown } = parseServices(service);
        if (unknown.length > 0) return unknownServiceError(unknown);
        const { severities, unknown: badSeverity } = parseSeverities(severity);
        if (badSeverity.length > 0) {
          return {
            error: `unknown severity: ${badSeverity.join(", ")} — no report was fetched`,
            validSeverities: [...SEVERITIES],
          };
        }
        const { inputs, errors } = await fetchSecurityInputs(exec, services);

        const matched = dedupeVulns(inputs.vulns ?? [])
          .filter((v) => severities.length === 0 || severities.includes(v.severity))
          .sort(compareVulns);
        // The report carries whatever the CLI's service map holds, which is not
        // the same set the CVEs and MRs are filtered to. Hold it to the same
        // scope this result claims, or it labels itself "all core services" while
        // listing services nothing else in the payload accounts for.
        const inScope = (s: { name?: string; gitlab_path?: string | null }): boolean => {
          const svc = serviceOf(s.gitlab_path ?? s.name ?? "");
          return VENUS_CORE.has(svc) && (services.length === 0 || services.includes(svc));
        };

        // Built for whatever prefix of `matched` survives the cap, so the counts
        // and the note describe the rows actually returned. `vulnCounts` and
        // `notes` lead: they are what a reader checks the rest against.
        const build = (kept: readonly (typeof matched)[number][]) => {
          const notes = [...errors];
          if (matched.length > kept.length) {
            notes.push(
              `vulns: returned the ${kept.length} most severe of ${matched.length} matching rows — narrow with severity (e.g. "critical,high") to see the rest`,
            );
          }
          // Keep the fix list aligned with the rows actually returned, so a fix
          // never references a CVE the caller cannot see.
          const shown = new Set(
            kept.map((v) => osvFixKey(v.package_name, v.cve_id, v.current_version)),
          );
          return {
            scope: scopeLabel(services),
            severityFilter: severities.length > 0 ? severities : "all",
            vulnCounts: { matched: matched.length, returned: kept.length },
            notes,
            services: (inputs.report.services ?? []).filter(inScope).map((s) => ({
              name: s.display_name || s.name,
              // Two different scans of two different things, and the pairing is
              // easy to misread: the Sonar grade covers the code this service's
              // team wrote, and is blind to every CVE counted beside it — those
              // live in the libraries it imports. A service rates A here and
              // still carries criticals there.
              sonar_security_rating: s.sonar?.security_rating ?? null,
              dependency_vulnerabilities: s.vulnerabilities ?? null,
            })),
            vulns: kept,
            // A list of {package, cve, installed, fixedVersion} rather than the raw
            // fix map: its keys are an internal composite, and serializing them
            // straight would put the NUL separator in front of the model.
            fixes: [...(inputs.fixes ?? new Map())]
              .filter(([key]) => shown.has(key))
              .map(([key, fixedVersion]) => {
                const { packageName, cveId, installedVersion } = osvFixParts(key);
                return {
                  package: packageName,
                  cve: cveId,
                  installed: installedVersion,
                  fixedVersion,
                };
              }),
            vulnMrs: inputs.mrs,
          };
        };

        return build(matched.slice(0, fitToCap(matched, build)));
      },
      securityScopeSchema,
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
    {
      name: "osdu_setup_check",
      description:
        "Use when: checking whether the local cluster-CLI environment is ready to deploy or what a provider requires. Returns: the cimpl inventory of kubectl, kind, flux, docker, aws, gcloud, oc, az, and eksctl installations and versions; optional provider scopes it to one provider. Read-only. NOT for: installing tools or mutating the cluster.",
      inputSchema: setupProviderSchema,
      state_changing: false,
      async execute(input, toolCtx) {
        const parsed = setupProviderSchema.safeParse(input);
        const provider = parsed.success ? parsed.data.provider : undefined;
        try {
          const { result, error } = await fetchSetupCheck(exec, provider);
          if (error || !result) {
            emitResult(
              toolCtx,
              `osdu_setup_check failed: ${error ?? "no inventory returned"}`,
              true,
            );
            return;
          }
          emitResult(
            toolCtx,
            boundedJson(result, "scope the inventory to one provider and call again"),
          );
        } catch (e) {
          emitResult(toolCtx, `osdu_setup_check failed: ${errText(e)}`, true);
        }
      },
    },
    lifecycleTool(exec, "reconcile", "Reconcile Flux on"),
    lifecycleTool(exec, "suspend", "Suspend Flux reconciliation on"),
    lifecycleTool(exec, "resume", "Resume Flux reconciliation on"),
  ];
}
