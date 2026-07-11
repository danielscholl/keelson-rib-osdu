// The providers cimpl can bring up today. cimpl-agent's PROVIDER_CARDS enables
// only `kind` and `azure` (aws/gcp render as "Soon" placeholders); `kind` is the
// default a bare `cimpl up` uses.
export const CLUSTER_PROVIDERS = ["kind", "azure"] as const;
export type ClusterProvider = (typeof CLUSTER_PROVIDERS)[number];

export const DEFAULT_CLUSTER_PROVIDER: ClusterProvider = "kind";

export const CLUSTER_PROFILES = ["minimal", "core", "core-plus", "graduated", "full"] as const;
export type ClusterProfile = (typeof CLUSTER_PROFILES)[number];

export interface ClusterCreateInput {
  provider: ClusterProvider;
  // Left unset so cimpl's per-provider default fires (core for kind, graduated
  // for cloud) — pinning a profile here would override that default.
  profile?: ClusterProfile;
  env?: string;
  partition?: string;
  instance?: string;
  // azure-only; ignored for other providers (mirrors cimpl-agent buildCreateInput).
  location?: string;
  privateNetwork?: boolean;
}

export function isClusterProvider(value: unknown): value is ClusterProvider {
  return typeof value === "string" && CLUSTER_PROVIDERS.includes(value as ClusterProvider);
}

export function isClusterProfile(value: unknown): value is ClusterProfile {
  return typeof value === "string" && CLUSTER_PROFILES.includes(value as ClusterProfile);
}

// Map a validated create selection to the run-workflow `args` (the run's
// `inputs`) the `osdu-cluster-create` bash node reads. Only set keys are emitted
// so a blank field stays absent and cimpl's default applies; the azure-only
// private flag rides as "1". Keys must be env-safe identifiers — the bash node
// reads each as `$KEELSON_INPUTS_<key>`.
export function clusterCreateArgs(input: ClusterCreateInput): Record<string, string> {
  const args: Record<string, string> = { provider: input.provider };
  if (input.profile) args.profile = input.profile;
  if (input.env) args.env = input.env;
  if (input.partition) args.partition = input.partition;
  if (input.instance) args.instance = input.instance;
  if (input.provider === "azure") {
    if (input.location) args.location = input.location;
    if (input.privateNetwork) args.private = "1";
  }
  return args;
}

// The `osdu-cluster-create` workflow's single bash node. It builds the `cimpl up`
// argv from the run inputs — reached through the safe env channel
// (`$KEELSON_INPUTS_<key>`), NOT `$inputs.<key>` text substitution, since bash
// nodes run their raw body for injection safety. Mirrors cimpl-agent
// _maps/lifecycle.ts TEMPLATES.create: --provider defaults to kind;
// --profile/--env/--partition/--instance/--location drop when empty so cimpl's
// per-provider defaults apply; CIMPL_AZURE_PRIVATE_NETWORK=1 only for an azure
// private-subnet create. Every interpolation is quoted; no `set -u` so an unset
// (blank) input expands to "" rather than aborting.
export const CLUSTER_CREATE_BASH = [
  "set -eo pipefail",
  'provider="$KEELSON_INPUTS_provider"',
  '[ -n "$provider" ] || provider=kind',
  'args=(up --provider "$provider")',
  '[ -n "$KEELSON_INPUTS_profile" ] && args+=(--profile "$KEELSON_INPUTS_profile")',
  '[ -n "$KEELSON_INPUTS_env" ] && args+=(--env "$KEELSON_INPUTS_env")',
  '[ -n "$KEELSON_INPUTS_partition" ] && args+=(--partition "$KEELSON_INPUTS_partition")',
  '[ -n "$KEELSON_INPUTS_instance" ] && args+=(--instance "$KEELSON_INPUTS_instance")',
  'if [ "$provider" = azure ]; then',
  '  [ -n "$KEELSON_INPUTS_location" ] && args+=(--location "$KEELSON_INPUTS_location")',
  '  [ -n "$KEELSON_INPUTS_private" ] && export CIMPL_AZURE_PRIVATE_NETWORK=1',
  "fi",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: bash array expansion, not a JS template
  'cimpl "${args[@]}"',
].join("\n");
