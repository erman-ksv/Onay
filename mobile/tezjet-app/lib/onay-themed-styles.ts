import { StyleSheet } from "react-native";
import { onayDark } from "./onay-auth-ui";
const light: Record<string, string> = {
 [onayDark.background]: "#f1f7f3", [onayDark.card]: "#ffffff", [onayDark.cardRaised]: "#e6f0ea", [onayDark.border]: "#d3e3d9", [onayDark.text]: "#0a1d15", [onayDark.muted]: "#5a7366",
};
/** Translate the shared token palette; preserve layout and semantic state styles. */
export function onayThemedStyles<T extends Record<string, object>>(styles: T, theme: "light" | "dark"): T {
 if (theme === "dark") return styles;
 return Object.fromEntries(Object.entries(styles).map(([key, style]) => [key, Object.fromEntries(Object.entries(StyleSheet.flatten(style)).map(([property, value]) => [property, typeof value === "string" && light[value] ? light[value] : value]))])) as T;
}
