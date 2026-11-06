import { OnayThemeContext } from "../lib/onay-theme-context";
import { useEffect, type ReactNode } from "react";
import { BackHandler, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { onayDark } from "../lib/onay-auth-ui";
export function onayPalette(theme: "light" | "dark") {
 return theme === "light" ? { ...onayDark, background: "#f1f7f3", card: "#ffffff", cardRaised: "#e6f0ea", border: "#d3e3d9", text: "#0a1d15", muted: "#5a7366" } : onayDark;
}
/** Shared native viewport, including connection and session recovery paths. */
export default function OnayScreenFrame({ children, title, onBack, theme = "dark", footer, testID }: {
 children: ReactNode; title?: string; onBack?: () => void; theme?: "light" | "dark"; footer?: ReactNode; testID?: string;
}) {
 const insets = useSafeAreaInsets(), c = onayPalette(theme);
 useEffect(() => {
  if (!onBack || Platform.OS !== "android") return;
  const subscription = BackHandler.addEventListener("hardwareBackPress", () => { onBack(); return true; });
  return () => subscription.remove();
 }, [onBack]);
 return <OnayThemeContext.Provider value={theme}><KeyboardAvoidingView testID={testID} style={[s.root, { backgroundColor: c.background, paddingTop: insets.top, paddingBottom: insets.bottom }]} behavior={Platform.OS === "ios" ? "padding" : undefined}>
 <StatusBar style={theme === "dark" ? "light" : "dark"} backgroundColor={c.background}/>
 <View style={s.width}>
 {title ? <View style={s.header}>{onBack ? <Pressable testID="onay-screen-back" accessibilityRole="button" accessibilityLabel="Назад" onPress={onBack} style={[s.back, { backgroundColor: c.card }]}><Text style={[s.chevron, { color: c.text }]}>‹</Text></Pressable> : null}<Text accessibilityRole="header" style={[s.title, { color: c.text }]}>{title}</Text></View> : null}
 <ScrollView style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">{children}</ScrollView>
 {footer ? <View style={s.footer}>{footer}</View> : null}
 </View></KeyboardAvoidingView></OnayThemeContext.Provider>;
}
const s = StyleSheet.create({ root: { flex: 1, minHeight: 0 }, width: { width: "100%", maxWidth: 430, alignSelf: "center", flex: 1, minHeight: 0 }, header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 }, back: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" }, chevron: { fontSize: 32, lineHeight: 36 }, title: { flex: 1, fontSize: 21, fontWeight: "700" }, scroll: { flex: 1, minHeight: 0 }, content: { paddingHorizontal: 20, paddingBottom: 24 }, footer: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24 } });
