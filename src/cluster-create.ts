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

// cimpl names the cluster after --env (defaulting to "dev"), so the provision
// preview names the cluster the operator will actually create rather than a
// phantom unsuffixed one.
export function deriveClusterName(env: string | undefined): string {
  const trimmed = (env ?? "").trim() || "dev";
  return `cimpl-stack-${trimmed}`;
}

export function isClusterProvider(value: unknown): value is ClusterProvider {
  return typeof value === "string" && CLUSTER_PROVIDERS.includes(value as ClusterProvider);
}

export function isClusterProfile(value: unknown): value is ClusterProfile {
  return typeof value === "string" && CLUSTER_PROFILES.includes(value as ClusterProfile);
}
