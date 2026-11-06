import { useEffect, useState } from "react";
import Constants from "expo-constants";
import { BackHandler, Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";
import type { OnayPassengerHomeMode } from "../lib/onay-home-modes";
import OnayPassengerAbout from "./OnayPassengerAbout";

type Props = {
  onChoose: (mode: OnayPassengerHomeMode) => void;
  onChooseLocation: () => void;
  activeOrder?: boolean;
  active?: boolean;
  onViewActiveOrder: () => void;
  theme?: "light" | "dark";
  onThemeChange?: (value: "light" | "dark") => void;
};

function TripCard({ title, description, symbol, onPress, primary = false, testID, light = false }: {
  title: string; description: string; symbol: string; onPress: () => void; primary?: boolean; testID: string; light?: boolean;
}) {
  return <Pressable
    testID={testID}
    accessibilityRole="button"
    onPress={onPress}
    style={[h.modeCard, primary ? h.primaryMode : h.secondaryMode, light && !primary && h.secondaryModeLight]}
  >
    <View style={[h.modeIcon, primary && h.primaryIcon, light && !primary && h.modeIconLight]}><Text style={[h.modeIconText, primary && h.primaryIconText, light && !primary && h.modeIconTextLight]}>{symbol}</Text></View>
    <View style={h.modeCopy}>
      <Text style={[h.modeTitle, primary && h.modeTitlePrimary, light && !primary && h.modeTitleLight]}>{title}</Text>
      <Text style={[h.modeDescription, primary && h.modeDescriptionPrimary, light && !primary && h.modeDescriptionLight]}>{description}</Text>
    </View>
    {primary ? <Text style={h.arrow}>›</Text> : null}
  </Pressable>;
}

/**
 * Native version of the passenger artifact's first page (SCR.home).
 * The route drawing is a schematic, never a live map or a GPS claim.
 * The actual availability, quote and booking stay in PassengerRouteOrder.
 */
export default function OnayPassengerHome({ onChoose, onChooseLocation, activeOrder = false, active = true, onViewActiveOrder, theme = "dark", onThemeChange }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  // Home remains mounted when another passenger tab is selected. Only the visible
  // Home page may consume Android Back, and nested pages take priority.
  useEffect(() => {
    if (!active || Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (aboutOpen) {
        setAboutOpen(false);
        setMenuOpen(false);
        return true;
      }
      if (menuOpen) {
        setMenuOpen(false);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [active, aboutOpen, menuOpen]);
  const light = theme === "light";
  if (aboutOpen) {
    return <OnayPassengerAbout theme={theme} onBack={() => { setAboutOpen(false); setMenuOpen(false); }} backLabel="Назад на главную" />;
  }
  return <View testID="onay-passenger-home" style={[h.root, light && { backgroundColor: "#f4f6f4" }]}>
    <View style={h.header}>
      <Pressable testID="onay-home-menu-open" accessibilityRole="button" accessibilityLabel={menuOpen ? "Закрыть настройки" : "Открыть настройки"}
        accessibilityState={{ expanded: menuOpen }} onPress={() => setMenuOpen(value => !value)}
        style={[h.menuToggle, light && { backgroundColor: "#e3e8e4" }]}>
        <Text style={{ fontSize: 24, color: light ? "#0e1a14" : onayDark.text }}>{menuOpen ? "×" : "☰"}</Text>
      </Pressable>
      <Image testID="onay-home-original-logo" source={require("../assets/onay-confirmed-logo.jpg")} style={h.logoImage} resizeMode="contain" accessibilityLabel="Onay" />
      <Pressable
        accessibilityRole="button" testID="onay-home-location"
        style={[h.location, light && h.locationLight]} onPress={onChooseLocation}
      >
        <Text style={[h.pin, light && h.lightText]}>⌖</Text>
        <View style={h.locationCopy}>
          <Text style={[h.locationCaption, light && h.lightMuted]}>Точка отправления</Text>
          <Text style={[h.locationTitle, light && h.lightText]}>Выбрать остановку</Text>
        </View>
        <Text style={[h.locationChevron, light && h.lightMuted]}>›</Text>
      </Pressable>
    </View>
    {menuOpen ? <View testID="onay-home-settings-menu" style={[h.settingsPanel, light && { backgroundColor: "#ffffff", borderColor: "#e3e8e4" }]}>
      <Text style={[h.settingsTitle, light && { color: "#0e1a14" }]}>Настройки</Text>
      <View style={h.settingsRow}><Text style={[h.settingsLabel, light && { color: "#0e1a14" }]}>Способ оплаты</Text><Text style={[h.settingsMuted, light && h.settingsMutedLight]}>Наличными</Text></View>
      <View style={h.settingsRow}>
        <Text style={[h.settingsLabel, light && { color: "#0e1a14" }]}>Режим света</Text>
        <View style={h.themeControls}>
          {(["light", "dark"] as const).map(value => <Pressable key={value} testID={"onay-home-theme-" + value}
            accessibilityRole="button" accessibilityLabel={value === "light" ? "Светлая тема" : "Тёмная тема"} accessibilityState={{ selected: theme === value }}
            onPress={() => onThemeChange?.(value)}
            style={[h.themeToggle, light && h.themeToggleLight, theme === value && h.themeActive]}>
            <Text style={{ color: theme === value ? onayDark.accentInk : (light ? "#0e1a14" : onayDark.text) }}>{value === "light" ? "☀" : "☾"}</Text>
          </Pressable>)}
        </View>
      </View>
      <Pressable accessibilityRole="button" testID="onay-home-about" onPress={() => setAboutOpen(true)} style={h.settingsRow}>
        <Text style={[h.settingsLabel, light && { color: "#0e1a14" }]}>О приложении</Text>
        <Text style={[h.settingsMuted, light && h.settingsMutedLight]}>›</Text>
      </Pressable>
      <Text style={[h.settingsVersion, light && { color: "#6a7b72" }]}>Onay · Версия {Constants.expoConfig?.version ?? "0.1.0"}</Text>
    </View> : null}
    {activeOrder ? <Pressable
      testID="onay-home-active-trip"
      accessibilityRole="button"
      accessibilityLabel="Посмотреть активную поездку"
      onPress={onViewActiveOrder}
      style={[h.activeBanner, light && h.activeBannerLight]}
    >
      <Text style={[h.activeText, light && h.lightText]}>У вас есть активная поездка</Text>
      <Text style={[h.activeText, light && h.lightText, { fontWeight: "700", marginTop: 5 }]}>Посмотреть детали ›</Text>
    </Pressable> : null}
    <View testID="onay-home-map-schematic" style={h.map}>
      {/* Reference-based route artwork: angled grid, three stops, road. No invented live cars. */}
      {[-135, -55, 25, 105, 185, 265, 345, 425].map(offset => <View key={"slope-" + offset} style={[h.gridSlope, { left: offset }]} />)}
      {[-170, -90, -10, 70, 150, 230, 310].map(offset => <View key={"cross-" + offset} style={[h.gridCross, { top: offset }]} />)}
      <View style={h.road}/>
      <View style={[h.dot, h.dotStart]}/>
      <View style={[h.dot, h.dotMiddle]}/>
      <View style={[h.dot, h.dotFinish]}/>
      <Text style={[h.mapLabel, h.labelStart]}>Shaxsham</Text>
      <Text style={[h.mapLabel, h.labelMiddle]}>Qoramazor</Text>
      <Text style={[h.mapLabel, h.labelFinish]}>Gazalkent</Text>
      <View style={h.mapCaption}>
        <View style={h.demoBadge}><Text style={h.demoText}>СХЕМА</Text></View>
        <Text style={h.mapFootnote}>Не GPS · данные и наличие водителей — в форме заказа</Text>
      </View>
    </View>
    <Text style={[h.heading, light && h.lightText]}>Куда поедем?</Text>
    <View style={h.modes}>
      <TripCard testID="onay-home-to-city" title="В город" description="Из села в город"
        symbol="▤" primary light={light} onPress={() => onChoose("city")} />
      <View style={h.modeRow}>
        <View style={h.half}>
          <TripCard testID="onay-home-to-village" title="В село" description="Из города домой"
            symbol="⌂" light={light} onPress={() => onChoose("village")} />
        </View>
        <View style={h.half}>
          <TripCard testID="onay-home-to-address" title="По своему адресу" description="Уточнение подачи на маршруте C/D"
            symbol="⌖" light={light} onPress={() => onChoose("address")} />
        </View>
      </View>
    </View>
  </View>;
}

const h = StyleSheet.create({
  lightText: { color: "#0e1a14" },
  lightMuted: { color: "#63776c" },
  locationLight: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e3e8e4" },
  activeBannerLight: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e3e8e4" },
  secondaryModeLight: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e3e8e4" },
  modeIconLight: { backgroundColor: "#e7f5e8" },
  modeIconTextLight: { color: "#116339" },
  modeTitleLight: { color: "#0e1a14" },
  modeDescriptionLight: { color: "#63776c" },
  logoImage: { width: 34, height: 38 },
  menuToggle: { width: 38, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: onayDark.card },
  settingsPanel: { borderWidth: 1, borderColor: onayDark.border, borderRadius: 18, backgroundColor: onayDark.card, padding: 16, marginBottom: 14, gap: 12 },
  settingsTitle: { fontSize: 19, fontWeight: "800", color: onayDark.text },
  settingsRow: { minHeight: 45, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  settingsLabel: { color: onayDark.text, fontSize: 14, fontWeight: "600" },
  settingsMuted: { color: onayDark.muted, fontSize: 12, flexShrink: 1 },
  settingsMutedLight: { color: "#546b5e" },
  themeControls: { flexDirection: "row", gap: 4 },
  themeToggle: { height: 35, width: 40, backgroundColor: onayDark.cardRaised, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  themeToggleLight: { backgroundColor: "#e6f0ea" },
  themeActive: { backgroundColor: onayDark.accent },
  settingsVersion: { textAlign: "center", marginTop: 25, color: onayDark.muted, fontSize: 12 },
  root: { backgroundColor: onayDark.background, paddingTop: 8, marginBottom: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 15 },
  logo: { width: 38, alignItems: "center", justifyContent: "center" },
  logoGlyph: { color: onayDark.accent, fontWeight: "800", fontSize: 25, lineHeight: 25 },
  logoName: { color: onayDark.accent, fontWeight: "800", fontSize: 10, marginTop: -2 },
  location: { flex: 1, minHeight: 50, borderRadius: 18, backgroundColor: onayDark.card,
    paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  pin: { color: onayDark.text, fontSize: 24 },
  locationCopy: { flex: 1 },
  locationCaption: { color: onayDark.muted, fontSize: 12, fontWeight: "600" },
  locationTitle: { color: onayDark.text, fontSize: 15, fontWeight: "700" },
  locationChevron: { color: onayDark.muted, fontSize: 26, lineHeight: 30 },
  activeBanner: { padding: 12, backgroundColor: onayDark.cardRaised, borderRadius: 14, marginBottom: 12 },
  activeText: { color: onayDark.text, fontSize: 13 },
  map: { height: 190, borderRadius: 22, backgroundColor: "#0d2a1f",
    borderWidth: 1, borderColor: onayDark.border, overflow: "hidden", position: "relative" },
  gridSlope: { position: "absolute", width: 1, height: 480, top: -150, backgroundColor: "#123826", transform: [{ rotate: "25deg" }] },
  gridCross: { position: "absolute", width: 670, height: 1, left: -160, backgroundColor: "#123826", transform: [{ rotate: "25deg" }] },
  road: { position: "absolute", top: 101, left: "7%", height: 9, width: "82%",
    backgroundColor: "#244b39", borderRadius: 6, transform: [{ rotate: "-18deg" }] },
  dot: { position: "absolute", backgroundColor: onayDark.background, borderColor: onayDark.muted, borderWidth: 2, width: 13, height: 13, borderRadius: 7 },
  dotStart: { left: "5%", top: "75%" },
  dotMiddle: { left: "37%", top: "56%" },
  dotFinish: { right: "13%", top: "26%" },
  mapLabel: { position: "absolute", color: "#bed0c5", fontSize: 11, fontWeight: "700" },
  labelStart: { left: "5%", top: "88%" },
  labelMiddle: { left: "31%", top: "70%" },
  labelFinish: { right: "12%", top: "39%" },
  mapCaption: { position: "absolute", left: 10, bottom: 8, flexDirection: "row", gap: 7, alignItems: "center" },
  demoBadge: { backgroundColor: "#3e3015", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  demoText: { color: "#ffc46b", fontSize: 10, fontWeight: "800" },
  mapFootnote: { flexShrink: 1, color: onayDark.muted, fontSize: 10 },
  heading: { color: onayDark.text, fontSize: 20, fontWeight: "800", marginTop: 19, marginBottom: 12 },
  modes: { gap: 10 },
  modeRow: { flexDirection: "row", gap: 10 },
  half: { flex: 1 },
  modeCard: { borderRadius: 20, padding: 14, flexDirection: "row", alignItems: "center", gap: 11, minHeight: 90 },
  primaryMode: { backgroundColor: onayDark.accent },
  secondaryMode: { flexDirection: "column", alignItems: "flex-start", backgroundColor: onayDark.card, minHeight: 154 },
  modeIcon: { backgroundColor: "#1a3e30", height: 39, width: 39, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  primaryIcon: { backgroundColor: "rgba(8,38,26,0.14)" },
  modeIconText: { color: onayDark.accent, fontSize: 25, fontWeight: "700" },
  primaryIconText: { color: onayDark.accentInk },
  modeCopy: { flex: 1 },
  modeTitle: { color: onayDark.text, fontWeight: "700", fontSize: 17 },
  modeTitlePrimary: { color: onayDark.accentInk },
  modeDescription: { color: onayDark.muted, fontSize: 13, lineHeight: 18, marginTop: 4 },
  modeDescriptionPrimary: { color: onayDark.accentInk },
  arrow: { color: onayDark.accentInk, fontSize: 26 },
});
