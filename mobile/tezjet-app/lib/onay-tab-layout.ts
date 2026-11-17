/**
 * Keep the original 304dp / 120+48+48+48dp ONAY V2 pill proportions,
 * while fitting four buttons inside compact devices without horizontal
 * clipping. The 8dp pill padding, 1dp border and three 8dp gaps are real
 * layout costs, not space available for the tab widths.
 */
export function onayTabWidths(viewportWidth: number): { active: number; inactive: number; pill: number } {
  const viewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 390;
  const pill = Math.min(304, Math.max(0, viewport - 40)); // outer 20dp padding on each side
  const usable = Math.max(0, pill - 2 * (8 + 1) - 3 * 8);
  const scale = Math.min(1, usable / (120 + 3 * 48));
  return {
    active: Math.floor(120 * scale),
    inactive: Math.floor(48 * scale),
    pill,
  };
}
