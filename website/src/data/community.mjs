// Derived from the community registry — community/packages/*.json is the
// single source of truth; this page never hand-copies package metadata.
// import.meta.glob is resolved by Vite at build time relative to this source
// file, so the catalog cannot drift from the registry.

const modules = import.meta.glob('../../../community/packages/*.json', { eager: true, import: 'default' });

export const packages = Object.entries(modules)
  .map(([file, value]) => {
    if (!file.endsWith(`/${value.name}.json`)) {
      throw new Error(`community registry: ${file} does not match name "${value.name}"`);
    }
    return value;
  })
  .sort((a, b) => a.name.localeCompare(b.name));

export const typeOrder = ['skill', 'recipe', 'brand-marks', 'locale', 'wrapper'];
export const typeCounts = Object.fromEntries([
  ['all', packages.length],
  ...typeOrder.map((type) => [type, packages.filter((entry) => entry.type === type).length]),
]);
