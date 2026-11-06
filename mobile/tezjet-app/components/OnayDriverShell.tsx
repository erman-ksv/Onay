import { OnayThemeContext } from "../lib/onay-theme-context";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { BackHandler, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import OnayIcon, { type OnayIconName } from "./OnayIcon";
import { onayPalette } from "./OnayScreenFrame";

export type OnayDriverTab = "line" | "queue" | "chats" | "history" | "profile";
const tabs: { id: OnayDriverTab; label: string; icon: OnayIconName }[] = [
 { id: "line", label: "Линия", icon: "home" }, { id: "queue", label: "Очередь", icon: "list" }, { id: "chats", label: "Чаты", icon: "chat" }, { id: "history", label: "История", icon: "clock" }, { id: "profile", label: "Профиль", icon: "user" },
];
/** Native five-page Driver V2; mounting preserves in-flight API scopes and drafts. */
export default function OnayDriverShell({ active, onSelect, theme, fullName, online, onOnline, disabled, pages }: {
 active: OnayDriverTab; onSelect: (tab: OnayDriverTab) => void; theme: "light" | "dark"; fullName: string;
 online: boolean; onOnline: () => void; disabled: boolean; pages: Record<OnayDriverTab, ReactNode>;
}) {
 const insets = useSafeAreaInsets(), c = onayPalette(theme), { width } = useWindowDimensions();
 useEffect(() => {
  if (Platform.OS !== "android") return;
  const subscription = BackHandler.addEventListener("hardwareBackPress", () => { if (active === "line") return false; onSelect("line"); return true; });
  return () => subscription.remove();
 }, [active, onSelect]);
 const activeWidth = Math.min(112, Math.max(72, width - 24 - 4 * 44 - 4 * 4 - 16));
 return <OnayThemeContext.Provider value={theme}><View testID="onay-driver-v2" style={[s.root, { backgroundColor: c.background, paddingTop: insets.top }]}>
 <StatusBar style={theme === "dark" ? "light" : "dark"} backgroundColor={c.background}/>
 <View style={s.width}>
 {active === "profile" ? null : active === "line" ? <View style={s.header}>
  <Image testID="onay-driver-confirmed-logo" source={require("../assets/onay-original-logo.png")} style={s.logo} resizeMode="contain" accessibilityLabel="Логотип Onay"/>
  <View style={s.name}><Text style={[s.caption, { color: c.muted }]}>Режим водителя</Text><Text style={[s.person, { color: c.text }]} numberOfLines={1}>{fullName || "Водитель"}</Text></View>
  <Text style={[s.caption, { color: c.muted }]}>На линии</Text>
  <Pressable testID="onay-driver-online" accessibilityRole="switch" accessibilityLabel="На линии" accessibilityState={{ checked: online, disabled }} disabled={disabled} onPress={onOnline} style={[s.toggle, { backgroundColor: online ? c.accent : c.cardRaised, opacity: disabled ? .45 : 1 }]}><View style={[s.knob, { backgroundColor: online ? c.accentInk : c.text, transform: [{ translateX: online ? 20 : 0 }] }]}/></Pressable>
 </View> : <View style={s.header}><Text accessibilityRole="header" style={[s.heading, { color: c.text }]}>{tabs.find(t => t.id === active)?.label}</Text></View>}
 <View style={s.pages}>{tabs.map(tab => <View key={tab.id} testID={"onay-driver-screen-" + tab.id} style={[s.page, active !== tab.id && s.hidden]} accessibilityElementsHidden={active !== tab.id} importantForAccessibility={active === tab.id ? "auto" : "no-hide-descendants"} pointerEvents={active === tab.id ? "auto" : "none"}>
 <ScrollView style={s.page} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" scrollEnabled={active === tab.id}>{pages[tab.id]}</ScrollView>
 </View>)}</View>
 <View style={[s.navArea, { paddingBottom: Math.max(insets.bottom, 16) }]}><View accessibilityRole="tablist" style={[s.nav, { backgroundColor: c.card, borderColor: c.border }]}>{tabs.map(tab => {
 const selected = active === tab.id;
 return <Pressable key={tab.id} testID={"onay-driver-tab-" + tab.id} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{ selected }} onPress={() => onSelect(tab.id)} style={[s.tab, { width: selected ? activeWidth : 44, backgroundColor: selected ? c.accent : c.cardRaised }]}>
 <OnayIcon name={tab.icon} color={selected ? c.accentInk : c.text}/>{selected ? <Text numberOfLines={1} style={[s.tabText, { color: c.accentInk }]}>{tab.label}</Text> : null}
 </Pressable>;
 })}</View></View>
 </View></View></OnayThemeContext.Provider>;
}
const s = StyleSheet.create({ root: { flex: 1, minHeight: 0 }, width: { width: "100%", maxWidth: 430, alignSelf: "center", flex: 1, minHeight: 0 }, header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, flexDirection: "row", alignItems: "center", gap: 10 }, logo: { width: 34, height: 38 }, name: { flex: 1, minWidth: 0 }, caption: { fontSize: 13 }, person: { fontSize: 17, fontWeight: "600", marginTop: 2 }, heading: { fontSize: 30, fontWeight: "700" }, toggle: { width: 52, height: 32, borderRadius: 16, justifyContent: "center", paddingHorizontal: 4 }, knob: { width: 24, height: 24, borderRadius: 12 }, pages: { flex: 1, minHeight: 0 }, page: { flex: 1, minHeight: 0 }, hidden: { display: "none" }, content: { paddingHorizontal: 20, paddingBottom: 24, gap: 12 }, navArea: { paddingHorizontal: 12, paddingTop: 6, alignItems: "center" }, nav: { flexDirection: "row", gap: 4, padding: 8, borderRadius: 40, borderWidth: 1 }, tab: { height: 48, borderRadius: 24, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }, tabText: { fontSize: 14, fontWeight: "600", flexShrink: 1 } });
