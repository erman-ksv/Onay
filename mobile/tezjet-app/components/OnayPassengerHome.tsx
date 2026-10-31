import { useState } from "react";
import Constants from "expo-constants";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";
import type { OnayPassengerHomeMode } from "../lib/onay-home-modes";

type Props = {
  onChoose: (mode: OnayPassengerHomeMode) => void;
  onChooseLocation: () => void;
  activeOrder?: boolean;
  theme?: "light" | "dark";
  onThemeChange?: (value: "light" | "dark") => void;
};

function TripCard({ title, description, symbol, onPress, primary = false, testID }: {
  title: string; description: string; symbol: string; onPress: () => void; primary?: boolean; testID: string;
}) {
  return <Pressable
    testID={testID}
    accessibilityRole="button"
    onPress={onPress}
    style={[h.modeCard, primary ? h.primaryMode : h.secondaryMode]}
  >
    <View style={[h.modeIcon, primary && h.primaryIcon]}><Text style={[h.modeIconText, primary && h.primaryIconText]}>{symbol}</Text></View>
    <View style={h.modeCopy}>
      <Text style={[h.modeTitle, primary && h.modeTitlePrimary]}>{title}</Text>
      <Text style={[h.modeDescription, primary && h.modeDescriptionPrimary]}>{description}</Text>
    </View>
    {primary ? <Text style={h.arrow}>›</Text> : null}
  </Pressable>;
}

/**
 * Native version of the passenger artifact's first page (SCR.home).
 * The route drawing is a schematic, never a live map or a GPS claim.
 * The actual availability, quote and booking stay in PassengerRouteOrder.
 */
export default function OnayPassengerHome({ onChoose, onChooseLocation, activeOrder = false, theme = "dark", onThemeChange }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const light = theme === "light";
  return <View testID="onay-passenger-home" style={[h.root, light && { backgroundColor: "#f4f6f4" }]}>
    <View style={h.header}>
      <Pressable testID="onay-home-menu-open" accessibilityRole="button" accessibilityLabel="Открыть настройки"
        accessibilityState={{ expanded: menuOpen }} onPress={() => setMenuOpen(value => !value)}
        style={[h.menuToggle, light && { backgroundColor: "#e3e8e4" }]}>
        <Text style={{ fontSize: 24, color: light ? "#0e1a14" : onayDark.text }}>{menuOpen ? "×" : "☰"}</Text>
      </Pressable>
      <Image testID="onay-home-original-logo" source={require("../assets/onay-confirmed-logo.jpg")} style={h.logoImage} resizeMode="contain" accessibilityLabel="Onay" />
      <Pressable
        accessibilityRole="button" testID="onay-home-location"
        style={h.location} onPress={onChooseLocation}
      >
        <Text style={h.pin}>⌖</Text>
        <View style={h.locationCopy}>
          <Text style={h.locationCaption}>Я сейчас</Text>
          <Text style={h.locationTitle}>Выбрать маршрут</Text>
        </View>
        <Text style={h.locationChevron}>›</Text>
      </Pressable>
    </View>
    {menuOpen ? <View testID="onay-home-settings-menu" style={[h.settingsPanel, light && { backgroundColor: "#ffffff", borderColor: "#e3e8e4" }]}>
      <Text style={[h.settingsTitle, light && { color: "#0e1a14" }]}>Настройки</Text>
      <View style={h.settingsRow}><Text style={[h.settingsLabel, light && { color: "#0e1a14" }]}>Способ оплаты</Text><Text style={h.settingsMuted}>Наличными</Text></View>
      <View style={h.settingsRow}>
        <Text style={[h.settingsLabel, light && { color: "#0e1a14" }]}>Режим света</Text>
        <View style={h.themeControls}>
          {(["light", "dark"] as const).map(value => <Pressable key={value} testID={"onay-home-theme-" + value}
            accessibilityRole="button" accessibilityState={{ selected: theme === value }}
            onPress={() => onThemeChange?.(value)}
            style={[h.themeToggle, theme === value && h.themeActive]}>
            <Text style={{ color: theme === value ? onayDark.accentInk : onayDark.text }}>{value === "light" ? "☀" : "☾"}</Text>
          </Pressable>)}
        </View>
      </View>
      <Pressable accessibilityRole="button" testID="onay-home-about" onPress={() => setAboutOpen(value => !value)} style={h.settingsRow}>
        <Text style={[h.settingsLabel, light && { color: "#0e1a14" }]}>О приложении</Text>
        <Text style={h.settingsMuted}>›</Text>
      </Pressable>
      {aboutOpen ? <Text testID="onay-home-about-details" style={h.settingsMuted}>
        Onay — сервис междугородних поездок. ONAY OST E.K.K Technologies.
      </Text> : null}
      <Text style={[h.settingsVersion, light && { color: "#6a7b72" }]}>Onay · Версия {Constants.expoConfig?.version ?? "0.1.0"}</Text>
    </View> : null}
    {activeOrder ? <View style={h.activeBanner}><Text style={h.activeText}>У вас есть активная поездка. Подробности — ниже.</Text></View> : null}
    <View testID="onay-home-map-schematic" style={h.map}>
      <View style={h.gridOne}/>
      <View style={h.gridTwo}/>
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
    <Text style={h.heading}>Куда поедем?</Text>
    <View style={h.modes}>
      <TripCard testID="onay-home-to-city" title="В город" description="Из села в город"
        symbol="▤" primary onPress={() => onChoose("city")} />
      <View style={h.modeRow}>
        <View style={h.half}>
          <TripCard testID="onay-home-to-village" title="В село" description="Из города домой"
            symbol="⌂" onPress={() => onChoose("village")} />
        </View>
        <View style={h.half}>
          <TripCard testID="onay-home-to-address" title="По своему адресу" description="Машина приедет за вами"
            symbol="⌖" onPress={() => onChoose("address")} />
        </View>
      </View>
    </View>
  </View>;
}

const h = StyleSheet.create({
  logoImage: { width: 40, height: 46 },
  menuToggle: { width: 43, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: onayDark.card },
  settingsPanel: { borderWidth: 1, borderColor: onayDark.border, borderRadius: 18, backgroundColor: onayDark.card, padding: 16, marginBottom: 14, gap: 12 },
  settingsTitle: { fontSize: 19, fontWeight: "800", color: onayDark.text },
  settingsRow: { minHeight: 45, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  settingsLabel: { color: onayDark.text, fontSize: 14, fontWeight: "600" },
  settingsMuted: { color: onayDark.muted, fontSize: 12, flexShrink: 1 },
  themeControls: { flexDirection: "row", gap: 4 },
  themeToggle: { height: 35, width: 40, backgroundColor: onayDark.cardRaised, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  themeActive: { backgroundColor: onayDark.accent },
  settingsVersion: { textAlign: "center", marginTop: 25, color: onayDark.muted, fontSize: 12 },
  root: { backgroundColor: onayDark.background, paddingTop: 8, marginBottom: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 15 },
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
  map: { height: 190, borderRadius: 22, backgroundColor: "#0b2b1e",
    borderWidth: 1, borderColor: onayDark.border, overflow: "hidden", position: "relative" },
  gridOne: { position: "absolute", height: 280, width: 1, backgroundColor: "#174232",
    left: "30%", top: -43, transform: [{ rotate: "27deg" }] },
  gridTwo: { position: "absolute", height: 280, width: 1, backgroundColor: "#174232",
    left: "63%", top: -43, transform: [{ rotate: "27deg" }] },
  road: { position: "absolute", top: 103, left: "5%", height: 9, width: "92%",
    backgroundColor: "#285341", borderRadius: 6, transform: [{ rotate: "-18deg" }] },
  dot: { position: "absolute", backgroundColor: "#7d9e8e", borderColor: "#0d2d21", borderWidth: 3, width: 18, height: 18, borderRadius: 9 },
  dotStart: { left: "8%", top: "68%" },
  dotMiddle: { left: "39%", top: "46%" },
  dotFinish: { right: "12%", top: "26%" },
  mapLabel: { position: "absolute", color: "#bed0c5", fontSize: 11, fontWeight: "700" },
  labelStart: { left: "5%", top: "80%" },
  labelMiddle: { left: "32%", top: "63%" },
  labelFinish: { right: "12%", top: "16%" },
  mapCaption: { position: "absolute", left: 10, bottom: 8, flexDirection: "row", gap: 7, alignItems: "center" },
  demoBadge: { backgroundColor: "#3e3015", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  demoText: { color: "#ffc46b", fontSize: 10, fontWeight: "800" },
  mapFootnote: { flexShrink: 1, color: onayDark.muted, fontSize: 10 },
  heading: { color: onayDark.text, fontSize: 20, fontWeight: "800", marginTop: 19, marginBottom: 12 },
  modes: { gap: 10 },
  modeRow: { flexDirection: "row", gap: 10 },
  half: { flex: 1 },
  modeCard: { borderRadius: 20, padding: 14, flexDirection: "row", alignItems: "center", gap: 11, minHeight: 90 },
  primaryMode: { backgroundColor: "#55d723" },
  secondaryMode: { flexDirection: "column", alignItems: "flex-start", backgroundColor: onayDark.card, minHeight: 135 },
  modeIcon: { backgroundColor: "#1a3e30", height: 39, width: 39, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  primaryIcon: { backgroundColor: "#4ac719" },
  modeIconText: { color: onayDark.accent, fontSize: 25, fontWeight: "700" },
  primaryIconText: { color: onayDark.accentInk },
  modeCopy: { flex: 1 },
  modeTitle: { color: onayDark.text, fontWeight: "800", fontSize: 16 },
  modeTitlePrimary: { color: onayDark.accentInk },
  modeDescription: { color: onayDark.muted, fontSize: 13, lineHeight: 18, marginTop: 4 },
  modeDescriptionPrimary: { color: "#22551c" },
  arrow: { color: onayDark.accentInk, fontSize: 26 },
});
