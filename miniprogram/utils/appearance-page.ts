import { getAppearance, applyNavigation } from "./appearance";
type ThemePage = { setData(data: Record<string, unknown>): void; data?: unknown; route?: string; refreshPreview?: () => void };
function artwork(value: unknown, prefix: string): unknown {
  if (typeof value === "string") {
    if (value.startsWith("/assets/location-artwork/")) return value.replace(/^\/assets\/location-artwork\/[^/]+\//, `/assets/location-artwork/${getAppearance().settings.palette}/`);
    return value.replace(/^\/assets\/(?:rooms|items|themes\/[^/]+)\/(living|bedroom|study|kitchen|storage|key|medicine|book|generic)(-dark)?\.png$/, (_, name: string, dark: string) => prefix + name + (dark || "") + ".png");
  }
  if (Array.isArray(value)) return value.map(v => artwork(v, prefix));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, artwork(v,prefix)]));
  return value;
}
export function applyPageAppearance(page: ThemePage): void {
  const state = getAppearance();
  const patch: Record<string, unknown> = { themeStyle: state.themeStyle, effectiveMode: state.effectiveMode, artPrefix: state.artPrefix, appearanceRecent: state.settings.recent, appearanceExpiry: state.settings.expiry };
  const data = page.data as Record<string, unknown> | undefined;
  for (const key of ["rooms","directItems","queryResults","recentItems","artworkLight","artworkDark","artworkOptions","artworkAutoLight","artworkAutoDark"]) if (data?.[key] !== undefined) patch[key] = artwork(data[key],state.artPrefix);
  page.setData(patch);
  applyNavigation(state);
}
export function refreshVisibleAppearance(): void {
  if (typeof getCurrentPages !== "function") return;
  const pages = getCurrentPages();
  for (const page of pages) applyPageAppearance(page);
  const top = pages[pages.length-1] as unknown as ThemePage | undefined;
  if (top?.route === "pages/appearance/appearance") top.refreshPreview?.();
}
