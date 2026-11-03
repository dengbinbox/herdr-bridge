export type Tab = { id: string; observe: boolean };
export type Layout = {
  tabs: Tab[];
  split: boolean;
  active: string;
  sizes?: number[];
};
// Layout documents are user-owned opaque JSON on the server; validate before rendering.
export function readLayout(value: unknown): Layout | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<Layout>;
  if (
    !Array.isArray(v.tabs) ||
    v.tabs.length > 8 ||
    typeof v.split !== "boolean" ||
    typeof v.active !== "string"
  )
    return null;
  const seen = new Set<string>();
  for (const tab of v.tabs) {
    if (
      !tab ||
      typeof tab.id !== "string" ||
      !tab.id ||
      tab.id.length > 512 ||
      typeof tab.observe !== "boolean" ||
      seen.has(tab.id)
    )
      return null;
    seen.add(tab.id);
  }
  if (
    v.sizes !== undefined &&
    (!Array.isArray(v.sizes) ||
      v.sizes.length > 8 ||
      v.sizes.some((n) => !Number.isFinite(n) || n <= 0 || n > 100))
  )
    return null;
  return {
    tabs: v.tabs.map((t) => ({ id: t.id, observe: t.observe })),
    split: v.split,
    active: seen.has(v.active) ? v.active : v.tabs[0]?.id || "",
    sizes: v.sizes || [],
  };
}
