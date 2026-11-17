import { Children } from "react";
import { Text as NativeText, type TextProps } from "react-native";
import { useOnayLanguage } from "../lib/onay-language-context";
/** Translate known UI copy only; unknown API values, names and identifiers are preserved. */
export default function OnayText({ children, accessibilityLabel, ...props }: TextProps) {
 const { t } = useOnayLanguage();
 return <NativeText {...props} accessibilityLabel={accessibilityLabel ? t(accessibilityLabel) : undefined}>{Children.map(children, child => typeof child === "string" ? t(child) : child)}</NativeText>;
}
