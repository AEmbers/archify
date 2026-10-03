// Derived from the community registry — community/packages/*.json is the
// single source of truth; this page never hand-copies package metadata.
// import.meta.glob is resolved by Vite at build time relative to this source
// file, so the catalog cannot drift from the registry.

export const PACKAGE_TYPES = ['skill', 'recipe', 'brand-marks', 'locale', 'wrapper'] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

export interface CommunityPackage {
  name: string;
  type: PackageType;
  summary: { en: string; zh: string };
  author: { name: string; url?: string };
  repository: string;
  archify: string;
  schemaVersions: number[];
  homepage?: string;
  tags?: string[];
  evidence?: { label: string; url: string }[];
}

const modules = import.meta.glob<CommunityPackage>('../../../community/packages/*.json', { eager: true, import: 'default' });

export const packages: CommunityPackage[] = Object.entries(modules)
  .map(([file, value]) => {
    if (!file.endsWith(`/${value.name}.json`)) {
      throw new Error(`community registry: ${file} does not match name "${value.name}"`);
    }
    return value;
  })
  .sort((a, b) => a.name.localeCompare(b.name));

export const typeOrder: PackageType[] = [...PACKAGE_TYPES];
export const typeCounts: Record<'all' | PackageType, number> = Object.fromEntries([
  ['all', packages.length],
  ...typeOrder.map((type) => [type, packages.filter((entry) => entry.type === type).length]),
]) as Record<'all' | PackageType, number>;
