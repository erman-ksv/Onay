import Text from "./OnayText";
import * as Clipboard from "expo-clipboard";
import { Alert, Linking, Pressable, StyleSheet, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";

type Props = {
  theme: "light" | "dark";
  onBack: () => void;
  previewOnly?: boolean;
};
const SUPPORT_EMAIL = "onayost.taxi@gmail.com";

export default function OnayPassengerSupport({ theme, onBack, previewOnly = false }: Props) {
  const light = theme === "light";
  const textColor = light ? "#0a1d15" : onayDark.text;
  const mutedColor = light ? "#5a7366" : onayDark.muted;

  async function openEmail() {
    if (previewOnly) return;
    try {
      await Linking.openURL("mailto:" + SUPPORT_EMAIL);
    } catch {
      Alert.alert("Поддержка Onay", "Напишите нам: " + SUPPORT_EMAIL);
    }
  }

  async function copyEmail() {
    try {
      await Clipboard.setStringAsync(SUPPORT_EMAIL);
      Alert.alert("Email скопирован", SUPPORT_EMAIL);
    } catch {
      Alert.alert("Не удалось скопировать email", SUPPORT_EMAIL);
    }
  }

  return <View testID="onay-passenger-support-screen" style={[styles.root, light && styles.rootLight]}>
    <View style={styles.header}>
      <Pressable testID="onay-support-back" accessibilityRole="button" accessibilityLabel="Назад в профиль" onPress={onBack} style={[styles.backButton, light && styles.backLight]}>
        <Text style={[styles.backText, { color: textColor }]}>‹</Text>
      </Pressable>
      <Text style={[styles.title, { color: textColor }]}>Поддержка</Text>
    </View>
    <Text style={[styles.description, { color: mutedColor }]}>
      Поможем с заказом, оплатой или работой приложения. Выберите, как вам удобнее связаться.
    </Text>
    <View style={[styles.list, light && styles.listLight]}>
      <Pressable testID="onay-support-email" accessibilityRole="button" accessibilityLabel="Написать в поддержку на email" disabled={previewOnly} onPress={() => { void openEmail(); }} style={[styles.contactRow, previewOnly && { opacity: 0.7 }]}>
        <Text style={styles.contactIcon}>✉</Text>
        <View style={styles.contactCopy}>
          <Text style={[styles.contactTitle, { color: textColor }]}>Написать на email</Text>
          <Text style={[styles.email, { color: mutedColor }]}>{SUPPORT_EMAIL}</Text>
        </View>
        <Text style={[styles.chevron, { color: mutedColor }]}>›</Text>
      </Pressable>
      <View testID="onay-support-chat-unavailable" accessibilityLabel="Чат с поддержкой пока недоступен" style={[styles.contactRow, styles.unavailable]}>
        <Text style={styles.contactIcon}>◌</Text>
        <View style={styles.contactCopy}>
          <Text style={[styles.contactTitle, { color: textColor }]}>Чат с поддержкой</Text>
          <Text style={[styles.email, { color: mutedColor }]}>Пока недоступен</Text>
        </View>
      </View>
    </View>
    <Pressable testID="onay-support-copy-email" accessibilityRole="button" onPress={() => { void copyEmail(); }}
      style={[styles.copyButton, { backgroundColor: onayDark.accent }]}>
      <Text style={{ color: onayDark.accentInk, fontWeight: "700", fontSize: 15 }}>Скопировать email</Text>
    </Pressable>
    {previewOnly ? <Text testID="onay-support-demo-no-send" style={{ color: mutedColor, marginTop: 12 }}>В деморежиме сообщения не отправляются.</Text> : null}
    <View style={styles.footer}>
      <Text style={[styles.company, { color: mutedColor }]}>© 2026 ONAY OST E.K.K Technologies</Text>
      <Text style={[styles.company, { color: mutedColor }]}>All rights reserved.</Text>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  root: { backgroundColor: onayDark.background, minHeight: 440, paddingHorizontal: 0, paddingTop: 14, paddingBottom: 24, borderRadius: 20 },
  rootLight: { backgroundColor: "#f1f7f3" },
  header: { flexDirection: "row", alignItems: "center", gap: 14 },
  backButton: { height: 42, width: 42, alignItems: "center", justifyContent: "center", backgroundColor: onayDark.card, borderRadius: 14 },
  backLight: { backgroundColor: "#e6f0ea" },
  backText: { fontSize: 33, lineHeight: 38 },
  title: { fontSize: 24, fontWeight: "800" },
  description: { fontSize: 15, lineHeight: 23, marginTop: 20, marginBottom: 24 },
  list: { backgroundColor: onayDark.card, borderRadius: 20, paddingHorizontal: 14, overflow: "hidden" },
  listLight: { backgroundColor: "#ffffff" },
  contactRow: { flexDirection: "row", minHeight: 78, alignItems: "center", gap: 13 },
  contactIcon: { fontSize: 23, color: onayDark.accent, width: 28, textAlign: "center" },
  contactCopy: { flex: 1, gap: 4 },
  contactTitle: { fontSize: 15, fontWeight: "700" },
  email: { fontSize: 13 },
  chevron: { fontSize: 28 },
  unavailable: { borderTopWidth: 1, borderTopColor: onayDark.border },
  copyButton: { marginTop: 22, borderRadius: 16, minHeight: 50, alignItems: "center", justifyContent: "center" },
  footer: { marginTop: 75, gap: 8, alignItems: "center" },
  company: { fontSize: 11, textAlign: "center" },
});
