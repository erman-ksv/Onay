import { Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";

type Props = {
  theme: "light" | "dark";
  onBack: () => void;
};
const SUPPORT_EMAIL = "onayost.taxi@gmail.com";

export default function OnayPassengerSupport({ theme, onBack }: Props) {
  const light = theme === "light";
  const textColor = light ? "#0a1d15" : onayDark.text;
  const mutedColor = light ? "#5a7366" : onayDark.muted;

  async function openEmail() {
    try {
      await Linking.openURL("mailto:" + SUPPORT_EMAIL);
    } catch {
      Alert.alert("Поддержка Onay", "Напишите нам: " + SUPPORT_EMAIL);
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
      <Pressable testID="onay-support-email" accessibilityRole="button" accessibilityLabel="Написать в поддержку на email" onPress={() => { void openEmail(); }} style={styles.contactRow}>
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
    <View style={styles.footer}>
      <Text style={[styles.company, { color: mutedColor }]}>© 2026 ONAY OST E.K.K Technologies</Text>
      <Text style={[styles.company, { color: mutedColor }]}>All rights reserved.</Text>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  root: { backgroundColor: onayDark.background, minHeight: 440, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24, borderRadius: 20 },
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
  footer: { marginTop: 75, gap: 8, alignItems: "center" },
  company: { fontSize: 11, textAlign: "center" },
});
