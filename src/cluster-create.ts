export const CLUSTER_PROVIDERS = ["azure", "aws", "gcp"] as const;
export type ClusterProvider = (typeof CLUSTER_PROVIDERS)[number];

export const CLUSTER_PROFILES = ["minimal", "core", "core-plus", "graduated", "full"] as const;
export type ClusterProfile = (typeof CLUSTER_PROFILES)[number];

const CLUSTER_PROFILES_BY_PROVIDER = {
  azure: CLUSTER_PROFILES,
  aws: CLUSTER_PROFILES,
  gcp: CLUSTER_PROFILES,
} satisfies Record<ClusterProvider, readonly ClusterProfile[]>;

export const CLUSTER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface ClusterCreateInput {
  provider: ClusterProvider;
  profile: ClusterProfile;
  name: string;
}

export function validateClusterName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return CLUSTER_NAME_PATTERN.test(name) ? name : null;
}

export function isClusterProvider(value: unknown): value is ClusterProvider {
  return typeof value === "string" && CLUSTER_PROVIDERS.includes(value as ClusterProvider);
}

export function isClusterProfile(value: unknown): value is ClusterProfile {
  return typeof value === "string" && CLUSTER_PROFILES.includes(value as ClusterProfile);
}

export function isClusterProviderProfile(
  provider: ClusterProvider,
  profile: ClusterProfile,
): boolean {
  return CLUSTER_PROFILES_BY_PROVIDER[provider].includes(profile);
}
