// The providers cimpl can bring up today. cimpl-agent's PROVIDER_CARDS enables
// only `kind` and `azure` (aws/gcp render as "Soon" placeholders); `kind` is the
// default a bare `cimpl up` uses.
export const CLUSTER_PROVIDERS = ["kind", "azure"] as const;
export type ClusterProvider = (typeof CLUSTER_PROVIDERS)[number];

export const DEFAULT_CLUSTER_PROVIDER: ClusterProvider = "kind";

// Provider gallery for the create-focused empty state. `kind`/`azure` are the
// providers cimpl can bring up today (CLUSTER_PROVIDERS); `aws`/`gcp` render as
// non-selectable "Soon" placeholders so the row reads as a real choice set.
// `longName` labels the plan rail; `tagline` is the muted card sub-line.
export interface ProviderCard {
  id: string;
  label: string;
  longName: string;
  tagline: string;
  enabled: boolean;
}

export const PROVIDER_CARDS: readonly ProviderCard[] = [
  {
    id: "kind",
    label: "kind",
    longName: "Local KinD cluster",
    tagline: "Fast · no cloud cost",
    enabled: true,
  },
  {
    id: "azure",
    label: "azure",
    longName: "Azure Kubernetes Service",
    tagline: "Cloud · persistent",
    enabled: true,
  },
  {
    id: "aws",
    label: "aws",
    longName: "Elastic Kubernetes Service",
    tagline: "Cloud · persistent",
    enabled: false,
  },
  {
    id: "gcp",
    label: "gcp",
    longName: "Google Kubernetes Engine",
    tagline: "Cloud · persistent",
    enabled: false,
  },
];

export function providerLongName(id: string): string {
  return PROVIDER_CARDS.find((p) => p.id === id)?.longName ?? id;
}

export const CLUSTER_PROFILES = ["minimal", "core", "core-plus", "graduated", "full"] as const;
export type ClusterProfile = (typeof CLUSTER_PROFILES)[number];

// The exact form-field value that opts an azure create into private subnets.
// Shared by the board's select option and the selection validator so the two
// can't drift.
export const PRIVATE_NETWORK_TOKEN = "private";

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

function trimmedField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Validate + normalize the create form fields into a ClusterCreateInput.
// Provider is required (kind|azure); profile is optional (blank → cimpl's
// per-provider default); location and the private-network flag apply only to
// azure. Returns an error string the action surfaces on invalid input.
export function clusterCreateSelection(
  payload: Record<string, unknown>,
): { ok: true; selection: ClusterCreateInput } | { ok: false; error: string } {
  const { provider } = payload;
  if (!isClusterProvider(provider)) {
    return { ok: false, error: "provider must be one of kind, azure" };
  }
  const selection: ClusterCreateInput = { provider };
  const profile = payload.profile;
  if (profile !== undefined && profile !== "") {
    if (!isClusterProfile(profile)) {
      return {
        ok: false,
        error: `profile '${String(profile)}' is not one of ${CLUSTER_PROFILES.join(", ")}`,
      };
    }
    selection.profile = profile;
  }
  const env = trimmedField(payload.env);
  if (env) selection.env = env;
  const partition = trimmedField(payload.partition);
  if (partition) selection.partition = partition;
  const instance = trimmedField(payload.instance);
  if (instance) selection.instance = instance;
  if (provider === "azure") {
    const location = trimmedField(payload.location);
    if (location) selection.location = location;
    // Match the exact form token, not any truthy string, so a malformed/forged
    // payload can't silently flip the network mode.
    if (payload.private === PRIVATE_NETWORK_TOKEN) selection.privateNetwork = true;
  }
  return { ok: true, selection };
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

// cimpl defaults a blank env to "dev", so a bare create comes up as
// cimpl-stack-dev — the plan rail names the cluster the operator will actually get.
export function deriveClusterName(env?: string): string {
  const trimmed = (env ?? "").trim() || "dev";
  return `cimpl-stack-${trimmed}`;
}

// The `cimpl up` command a create selection runs — same flag order and rules as
// clusterCreateArgs / CLUSTER_CREATE_BASH, so a rendered preview matches what the
// workflow actually executes.
export function buildCreateCommand(input: ClusterCreateInput): string {
  const flags = [`--provider ${input.provider}`];
  if (input.profile) flags.push(`--profile ${input.profile}`);
  if (input.env) flags.push(`--env ${input.env}`);
  if (input.partition) flags.push(`--partition ${input.partition}`);
  if (input.instance) flags.push(`--instance ${input.instance}`);
  if (input.provider === "azure" && input.location) flags.push(`--location ${input.location}`);
  const head =
    input.provider === "azure" && input.privateNetwork
      ? "CIMPL_AZURE_PRIVATE_NETWORK=1 cimpl up"
      : "cimpl up";
  return `${head} ${flags.join(" ")}`;
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
  // The subprocess inherits the server env; clear any stray private-network flag
  // so it's enabled ONLY when this create explicitly asked for it below.
  "unset CIMPL_AZURE_PRIVATE_NETWORK",
  'provider="$KEELSON_INPUTS_provider"',
  '[ -n "$provider" ] || provider=kind',
  // Re-enforce the provider/profile allowlists at the execution boundary — the
  // workflow is runnable independently of the action's validator. Built from the
  // TS allowlists above so the two can't drift.
  `case "$provider" in ${CLUSTER_PROVIDERS.join("|")}) ;; *) echo "unsupported provider: $provider" >&2; exit 2 ;; esac`,
  `if [ -n "$KEELSON_INPUTS_profile" ]; then case "$KEELSON_INPUTS_profile" in ${CLUSTER_PROFILES.join("|")}) ;; *) echo "unsupported profile: $KEELSON_INPUTS_profile" >&2; exit 2 ;; esac; fi`,
  'args=(up --provider "$provider")',
  '[ -n "$KEELSON_INPUTS_profile" ] && args+=(--profile "$KEELSON_INPUTS_profile")',
  '[ -n "$KEELSON_INPUTS_env" ] && args+=(--env "$KEELSON_INPUTS_env")',
  '[ -n "$KEELSON_INPUTS_partition" ] && args+=(--partition "$KEELSON_INPUTS_partition")',
  '[ -n "$KEELSON_INPUTS_instance" ] && args+=(--instance "$KEELSON_INPUTS_instance")',
  'if [ "$provider" = azure ]; then',
  '  [ -n "$KEELSON_INPUTS_location" ] && args+=(--location "$KEELSON_INPUTS_location")',
  '  [ "$KEELSON_INPUTS_private" = 1 ] && export CIMPL_AZURE_PRIVATE_NETWORK=1',
  "fi",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: bash array expansion, not a JS template
  'cimpl "${args[@]}"',
].join("\n");
