import OnayInlineLanguage from "./OnayInlineLanguage";
import OnayBuildIdentity from "./OnayBuildIdentity";
import Text from "./OnayText";
import OnayIcon from "./OnayIcon";
import OnayScreenFrame from "./OnayScreenFrame";
import { useEffect, useState } from "react";
import Constants from "expo-constants";
import { BackHandler, Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";
import { onayProfileInitial } from "../lib/onay-profile-avatar";
import OnayPassengerSupport from "./OnayPassengerSupport";
import OnayPassengerAbout from "./OnayPassengerAbout";
import OnayDriverModeOverview from "./OnayDriverModeOverview";
import OnayPersonalDetails from "./OnayPersonalDetails";
import type { DriverModeVehicle } from "../lib/onay-driver-mode-status";

type Theme = "light" | "dark";
type Props = {
  fullName: string;
  phoneNumber?: string | null;
  busy: boolean;
  theme: Theme;
  active: boolean;
  onBackToHome: () => void;
  onThemeChange: (value: Theme) => void;
  onHistory: () => void;
  onDriver: () => void;
  onLogout: () => void;
  onSupportPreview?: () => void;
  demoMode?: boolean;
  email?: string | null;
  onSaveEmail?: (email: string | null) => Promise<string | null>;
  onLoadDriverVehicle?: () => Promise<{ driver_vehicle: DriverModeVehicle | null; approval_status: "pending" | "approved" | "rejected" | "blocked" | null; route_name?: string | null; review_reason?: string | null }>;
  onOpenDriverVehicle?: () => void;
  driverApprovalStatus?: "pending" | "approved" | "rejected" | "blocked" | null;
  driverVehicle?: DriverModeVehicle | null;
  driverRouteName?: string | null;
  driverQueueReady?: boolean;
  driverEnrolled?: boolean;
};

const APP_VERSION = Constants.expoConfig?.version ?? "0.1.0";

export default function OnayPassengerProfile({ fullName, phoneNumber, busy, theme, active, onBackToHome, onThemeChange, onHistory, onDriver, onLogout, onSupportPreview, demoMode = false, email, onSaveEmail, onLoadDriverVehicle, onOpenDriverVehicle, driverApprovalStatus, driverVehicle,
  driverRouteName, driverQueueReady = false, driverEnrolled = false }: Props) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [driverModeOpen, setDriverModeOpen] = useState(false);
  useEffect(() => {
    if (!active || Platform.OS === "web") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (driverModeOpen) { setDriverModeOpen(false); return true; }
      if (supportOpen) { setSupportOpen(false); return true; }
      if (aboutOpen) { setAboutOpen(false); return true; }
      if (personalOpen) { setPersonalOpen(false); return true; }
      onBackToHome();
      return true;
    });
    return () => subscription.remove();
  }, [active, driverModeOpen, supportOpen, aboutOpen, personalOpen, onBackToHome]);
  const light = theme === "light";
  const surface = light ? "#ffffff" : onayDark.card;
  const foreground = light ? "#0a1d15" : onayDark.text;
  const muted = light ? "#6a7b72" : onayDark.muted;
  const row = (id: string, label: string, action: () => void, trailing = "") => (
    <Pressable testID={"onay-profile-" + id} accessibilityRole="button" disabled={busy}
      onPress={id === "support" && onSupportPreview ? onSupportPreview : action} style={[s.linkRow, { borderColor: light ? "#d3e3d9" : onayDark.border }]}>
      <Text style={{ color: foreground, fontWeight: "600" }}>{label}</Text>
      <Text style={{ color: muted }}>{trailing ? trailing + "  ›" : "›"}</Text>
    </Pressable>
  );
  if (driverModeOpen) return <Modal visible animationType="slide" presentationStyle="fullScreen"
    onRequestClose={() => setDriverModeOpen(false)}>
    <OnayDriverModeOverview theme={theme} demoMode={demoMode} approval={driverApprovalStatus}
      vehicle={driverVehicle} routeName={driverRouteName} queueReady={driverQueueReady}
      enrolled={driverEnrolled} busy={busy} onLoadVehicle={onLoadDriverVehicle} onOpenVehicle={onOpenDriverVehicle}
      onBack={() => setDriverModeOpen(false)}
      onOpenDriver={() => { setDriverModeOpen(false); onDriver(); }}
      onSupport={() => { setDriverModeOpen(false); if (onSupportPreview) onSupportPreview(); else setSupportOpen(true); }}/>
  </Modal>;
  if (supportOpen) {
    return <OnayPassengerSupport theme={theme} onBack={() => setSupportOpen(false)} />;
  }
  if (aboutOpen) {
    return <OnayPassengerAbout theme={theme} mode={demoMode ? "demo" : "live"} onBack={() => setAboutOpen(false)} />;
  }
  if (personalOpen) return <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setPersonalOpen(false)}>
    <OnayPersonalDetails theme={theme} fullName={fullName} phoneNumber={phoneNumber} email={email}
      demoMode={demoMode} onSaveEmail={onSaveEmail} onBack={() => setPersonalOpen(false)}/>
  </Modal>;
  return <View testID="onay-passenger-profile-panel" style={[s.root, { backgroundColor: light ? "#f1f7f3" : onayDark.background }]}>
    <View style={s.identity}>
      <View style={[s.avatar, { backgroundColor: light ? "#e3f7df" : onayDark.cardRaised }]}>
        <Text testID="onay-profile-avatar-initial" style={{ color: light ? "#5a7366" : onayDark.muted, fontSize: 30, fontWeight: "700" }}>{onayProfileInitial(fullName)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.personName, { color: foreground }]}>{fullName || "Пассажир Onay"}</Text>
        <Text testID="onay-profile-header-phone" style={{ color: muted, marginTop: 5 }}>{phoneNumber || "Аккаунт пассажира"}</Text>
      </View>
      <View testID="onay-profile-header-theme" accessibilityLabel="Режим света" style={s.headerTheme}>
        <View style={[s.themeButtons, light && s.themeButtonsLight]}>
          {(["light", "dark"] as const).map(value => <Pressable key={value} accessibilityRole="button"
            testID={"onay-profile-theme-" + value}
            accessibilityLabel={value === "light" ? "Светлая тема" : "Тёмная тема"}
            accessibilityState={{ selected: theme === value }}
            onPress={() => onThemeChange(value)}
            style={[s.themeButton, light && s.themeButtonLight, theme === value && s.themeSelected]}>
            <OnayIcon name={value === "light" ? "sun" : "moon"} color={theme === value ? onayDark.accentInk : (light ? "#194b34" : muted)}/>
          </Pressable>)}
        </View>
      </View>
    </View>

    <View style={[s.group, { backgroundColor: surface }]}>
      <Pressable
        testID="onay-profile-personal-data"
        accessibilityRole="button"
        accessibilityState={{ expanded: personalOpen }}
        onPress={() => setPersonalOpen(previous => !previous)}
        style={[s.linkRow, { borderColor: light ? "#d3e3d9" : onayDark.border }]}
      >
        <Text style={{ color: foreground, fontWeight: "600" }}>Личные данные</Text>
        <Text style={{ color: muted }}>{personalOpen ? "⌃" : "›"}</Text>
      </Pressable>
      {row("history", "История поездок", onHistory)}
      <View testID="onay-profile-language-row" style={[s.linkRow, { borderBottomWidth: 0, gap: 8, flexWrap: "wrap", paddingVertical: 9 }]}>
        <Text style={{ color: foreground, fontWeight: "600", flexShrink: 1 }}>Язык</Text>
        <OnayInlineLanguage theme={theme} testID="onay-profile-language"/>
      </View>
    </View>

    <View style={[s.group, { backgroundColor: surface }]}>
      {row("driver", "Режим водителя", () => setDriverModeOpen(true))}
      {row("support", "Поддержка", () => setSupportOpen(true))}
      {row("about", "О приложении", () => setAboutOpen(true))}
    </View>

    <View style={[s.group, { backgroundColor: surface }]}>
      <Pressable accessibilityRole="button" testID="onay-profile-logout" onPress={onLogout}
        disabled={busy} style={s.exit}>
        <Text style={{ color: onayDark.danger, fontWeight: "700" }}>Выйти</Text>
      </Pressable>
    </View>

    <Text style={[s.version, { color: muted }]}>Onay · Версия {APP_VERSION}</Text>
    <OnayBuildIdentity mode={demoMode ? "demo" : "live"} compact color={muted}/>
    <Text style={[s.copyright, { color: muted }]}>© 2026 ONAY OST E.K.K Technologies</Text>
  </View>;
}

const s = StyleSheet.create({
  root: { marginBottom: 18, gap: 16, paddingTop: 2, paddingHorizontal: 2, borderRadius: 20 },
  identity: { flexDirection: "row", alignItems: "center", paddingHorizontal: 0, paddingVertical: 4, gap: 12, minHeight: 88 },
  headerTheme: { flexShrink: 0 },
  personalDetails: { paddingVertical: 15, gap: 5 },
  detailCaption: { fontSize: 12, fontWeight: "600", marginTop: 6 },
  detailValue: { fontSize: 15, fontWeight: "600" },
  avatar: { width: 78, height: 78, borderRadius: 39, alignItems: "center", justifyContent: "center" },
  personName: { fontSize: 22, fontWeight: "700" },
  group: { borderRadius: 20, paddingHorizontal: 16, overflow: "hidden" },
  linkRow: { minHeight: 58, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1 },
  themeButtons: { flexDirection: "row", padding: 4, borderRadius: 16, backgroundColor: onayDark.card, gap: 4 },
  themeButtonsLight: { backgroundColor: "#e6f0ea" },
  themeButton: { height: 34, width: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  themeButtonLight: { backgroundColor: "#f8fbf9" },
  themeSelected: { backgroundColor: onayDark.accent },
  exit: { minHeight: 56, justifyContent: "center" },
  version: { textAlign: "center", fontSize: 12, marginTop: 14 },
  copyright: { textAlign: "center", fontSize: 11, marginBottom: 12 },
});
