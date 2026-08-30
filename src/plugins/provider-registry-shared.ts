// Shares provider registry normalization helpers across plugin paths.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { ProviderPlugin } from "./provider-plugin.types.js";
import type { PluginRegistry } from "./registry-types.js";

/** Normalizes provider ids used by capability-provider registries. */
export function normalizeCapabilityProviderId(providerId: string | undefined): string | undefined {
  const normalized = normalizeOptionalLowercaseString(providerId);
  return normalized && !isBlockedObjectKey(normalized) ? normalized : undefined;
}

export function matchesProviderPluginRef(
  provider: { id: string; aliases?: readonly string[]; hookAliases?: readonly string[] },
  providerId: string,
): boolean {
  const normalized = normalizeProviderId(providerId);
  return Boolean(
    normalized &&
    (normalizeProviderId(provider.id) === normalized ||
      [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
        (alias) => normalizeProviderId(alias) === normalized,
      )),
  );
}

/** Explicit API ownership suppresses unrelated aliases, while preserving literal provider ids. */
export function matchesProviderRuntimePlugin(
  plugin: ProviderPlugin,
  provider: string,
  ownerRefs: readonly string[],
): boolean {
  if (ownerRefs.length > 0) {
    const normalized = normalizeLowercaseStringOrEmpty(provider);
    return (
      (Boolean(normalized) && normalizeLowercaseStringOrEmpty(plugin.id) === normalized) ||
      ownerRefs.some((ownerRef) => matchesProviderPluginRef(plugin, ownerRef))
    );
  }
  return matchesProviderPluginRef(plugin, provider);
}

export function listProviderRuntimePluginsInRegistry(
  registry: PluginRegistry,
): Array<ProviderPlugin & { pluginId: string }> {
  return registry.providers.map((entry) => ({ ...entry.provider, pluginId: entry.pluginId }));
}

export function findProviderRuntimePluginInRegistry(params: {
  registry: PluginRegistry;
  provider: string;
  ownerRefs: readonly string[];
}): ProviderPlugin | undefined {
  const entry = params.registry.providers.find(({ provider }) =>
    matchesProviderRuntimePlugin(provider, params.provider, params.ownerRefs),
  );
  return entry ? { ...entry.provider, pluginId: entry.pluginId } : undefined;
}

/** Builds canonical and alias lookup maps for capability providers. */
export function buildCapabilityProviderMaps<T extends { id: string; aliases?: readonly string[] }>(
  providers: readonly T[],
  normalizeId: (
    providerId: string | undefined,
  ) => string | undefined = normalizeCapabilityProviderId,
): {
  canonical: Map<string, T>;
  aliases: Map<string, T>;
} {
  const canonical = new Map<string, T>();
  const aliases = new Map<string, T>();

  for (const provider of providers) {
    const id = normalizeId(provider.id);
    if (!id) {
      continue;
    }
    canonical.set(id, provider);
    aliases.set(id, provider);
    for (const alias of provider.aliases ?? []) {
      const normalizedAlias = normalizeId(alias);
      if (normalizedAlias) {
        aliases.set(normalizedAlias, provider);
      }
    }
  }

  return { canonical, aliases };
}
