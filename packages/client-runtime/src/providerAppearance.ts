import type { ClientSettings } from "@d4research/contracts/settings";
import type { ProviderInstanceId } from "@d4research/contracts";

export type ProviderAppearance = ClientSettings["providerAppearance"][ProviderInstanceId];

export function applyModelDisplayNames<
  T extends { slug: string; name: string; shortName?: string },
>(models: T[], names: Readonly<Record<string, string>> | undefined): T[] {
  if (!names) return models;
  return models.map((model) => {
    const name = names[model.slug]?.trim();
    return name ? { ...model, name, shortName: name } : model;
  });
}

export function setModelDisplayName(
  appearance: ProviderAppearance,
  slug: string,
  value: string,
): ProviderAppearance {
  const modelNames = { ...appearance.modelNames };
  const name = value.trim();
  if (name) modelNames[slug] = name;
  else delete modelNames[slug];
  return { ...appearance, modelNames };
}
