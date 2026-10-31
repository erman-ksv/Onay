import { useState } from "react";
import Constants from "expo-constants";
import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";
import { onayProfileInitial } from "../lib/onay-profile-avatar";

type Theme = "light" | "dark";
type Props = {
  fullName: string;
  phoneNumber?: string | null;
  busy: boolean;
  theme: Theme;
  onThemeChange: (value: Theme) => void;
  onHistory: () => void;
  onDriver: () => void;
  onLogout: () => void;
};

const HELP_EMAIL = "onayost.taxi@gmail.com";
const APP_VERSION = Constants.expoConfig?.version ?? "0.1.0";

export default function OnayPassengerProfile({ fullName, phoneNumber, busy, theme, onThemeChange, onHistory, onDriver, onLogout }: Props) {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [personalOpen, setPersonalOpen] = useState(false);
  const light = theme === "light";
  const surface = light ? "#ffffff" : onayDark.card;
  const foreground = light ? "#0e1a14" : onayDark.text;
  const muted = light ? "#6a7b72" : onayDark.muted;
  const row = (id: string, label: string, action: () => void, trailing = "") => (
    <Pressable testID={"onay-profile-" + id} accessibilityRole="button" disabled={busy}
      onPress={action} style={[s.linkRow, { borderColor: light ? "#e3e8e4" : onayDark.border }]}>
      <Text style={{ color: foreground, fontWeight: "600" }}>{label}</Text>
      <Text style={{ color: muted }}>{trailing ? trailing + "  ›" : "›"}</Text>
    </Pressable>
  );
  async function support() {
    try {
      await Linking.openURL("mailto:" + HELP_EMAIL);
    } catch {
      Alert.alert("Поддержка Onay", "Напишите нам: " + HELP_EMAIL);
    }
  }
  return <View testID="onay-passenger-profile-panel" style={[s.root, { backgroundColor: light ? "#f4f6f4" : onayDark.background }]}>
    <View style={[s.identity, { backgroundColor: surface }]}>
      <View style={[s.avatar, { backgroundColor: light ? "#e3f7df" : onayDark.cardRaised }]}>
        <Text testID="onay-profile-avatar-initial" style={{ color: light ? "#5a7366" : onayDark.muted, fontSize: 30, fontWeight: "700" }}>{onayProfileInitial(fullName)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.personName, { color: foreground }]}>{fullName || "Пассажир Onay"}</Text>
        <Text style={{ color: muted, marginTop: 5 }}>Аккаунт пассажира</Text>
      </View>
    </View>

    <View style={[s.group, { backgroundColor: surface }]}>
      <Pressable
        testID="onay-profile-personal-data"
        accessibilityRole="button"
        accessibilityState={{ expanded: personalOpen }}
        onPress={() => setPersonalOpen(previous => !previous)}
        style={[s.linkRow, { borderColor: light ? "#e3e8e4" : onayDark.border }]}
      >
        <Text style={{ color: foreground, fontWeight: "600" }}>Личные данные</Text>
        <Text style={{ color: muted }}>{personalOpen ? "⌃" : "›"}</Text>
      </Pressable>
      {personalOpen ? <View testID="onay-profile-personal-details" style={s.personalDetails}>
        <Text style={[s.detailCaption, { color: muted }]}>ФИО</Text>
        <Text testID="onay-profile-personal-name" style={[s.detailValue, { color: foreground }]}>{fullName || "Не указано"}</Text>
        {phoneNumber ? <>
          <Text style={[s.detailCaption, { color: muted }]}>Номер телефона</Text>
          <Text testID="onay-profile-personal-phone" style={[s.detailValue, { color: foreground }]}>{phoneNumber}</Text>
        </> : null}
        <Text style={[s.detailCaption, { color: muted }]}>Режим аккаунта</Text>
        <Text style={[s.detailValue, { color: foreground }]}>Пассажир</Text>
      </View> : null}
      {row("history", "История поездок", onHistory)}
      <View style={s.themeRow}>
        <Text style={{ color: foreground, fontWeight: "600" }}>Режим света</Text>
        <View style={s.themeButtons}>
          {(["light", "dark"] as const).map(value => <Pressable key={value} accessibilityRole="button"
            testID={"onay-profile-theme-" + value}
            accessibilityState={{ selected: theme === value }}
            onPress={() => onThemeChange(value)}
            style={[s.themeButton, theme === value && s.themeSelected]}>
            <Text style={{ color: theme === value ? onayDark.accentInk : muted, fontWeight: "700" }}>
              {value === "light" ? "☀" : "☾"}
            </Text>
          </Pressable>)}
        </View>
      </View>
    </View>

    <View style={[s.group, { backgroundColor: surface }]}>
      {row("driver", "Режим водителя", onDriver)}
      {row("support", "Поддержка", () => { void support(); })}
      {row("about", "О приложении", () => setAboutOpen(value => !value))}
      {aboutOpen ? <View testID="onay-profile-about" style={s.about}>
        <Text style={[s.aboutTitle, { color: foreground }]}>Onay · версия {APP_VERSION}</Text>
        <Text style={{ color: muted, lineHeight: 20 }}>Приложение для поездок между населёнными пунктами. Стоимость и наличие водителей подтверждает сервер.</Text>
        <Text style={{ color: muted, marginTop: 10 }}>ONAY OST E.K.K Technologies</Text>
        <Text style={{ color: muted }}>One Founder. Intelligent Systems.</Text>
      </View> : null}
    </View>

    <View style={[s.group, { backgroundColor: surface }]}>
      <Pressable accessibilityRole="button" testID="onay-profile-logout" onPress={onLogout}
        disabled={busy} style={s.exit}>
        <Text style={{ color: onayDark.danger, fontWeight: "700" }}>Выйти</Text>
      </Pressable>
    </View>

    <Text style={[s.version, { color: muted }]}>Onay · Версия {APP_VERSION}</Text>
    <Text style={[s.copyright, { color: muted }]}>© 2026 ONAY OST E.K.K Technologies</Text>
  </View>;
}

const s = StyleSheet.create({
  root: { marginBottom: 18, gap: 14, paddingTop: 14, paddingHorizontal: 2, borderRadius: 20 },
  identity: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 20, gap: 12 },
  personalDetails: { paddingVertical: 15, gap: 5 },
  detailCaption: { fontSize: 12, fontWeight: "600", marginTop: 6 },
  detailValue: { fontSize: 15, fontWeight: "600" },
  avatar: { width: 78, height: 78, borderRadius: 39, alignItems: "center", justifyContent: "center" },
  personName: { fontSize: 21, fontWeight: "800" },
  group: { borderRadius: 19, paddingHorizontal: 14, overflow: "hidden" },
  linkRow: { minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1 },
  themeRow: { minHeight: 57, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  themeButtons: { flexDirection: "row", padding: 4, borderRadius: 12, backgroundColor: onayDark.cardRaised, gap: 3 },
  themeButton: { height: 34, width: 42, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  themeSelected: { backgroundColor: onayDark.accent },
  exit: { minHeight: 56, justifyContent: "center" },
  about: { gap: 5, paddingVertical: 16 },
  aboutTitle: { fontWeight: "800", fontSize: 17, marginBottom: 5 },
  version: { textAlign: "center", fontSize: 12, marginTop: 14 },
  copyright: { textAlign: "center", fontSize: 11, marginBottom: 12 },
});
