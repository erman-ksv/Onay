import { StyleSheet, Text, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";

type Props = { theme?: "light" | "dark" };

/**
 * Onay Passenger V2 chat-list empty state.
 * Messaging is not implemented: do not simulate driver conversations or send requests.
 */
export default function OnayPassengerChatsEmpty({ theme = "dark" }: Props) {
  const light = theme === "light";
  return <View testID="onay-chats-empty-state" style={[styles.page, light && styles.lightPage]}>
    <Text style={[styles.heading, light && styles.lightHeading]}>Чаты</Text>
    <View style={styles.empty}>
      <View style={[styles.iconCircle, light && styles.lightIconCircle]} accessible={false}>
        <View style={styles.bubble}>
          <Text style={styles.bubbleDots}>•••</Text>
        </View>
      </View>
      <Text testID="onay-chats-empty-title" style={[styles.title, light && styles.lightHeading]}>
        Чатов пока нет
      </Text>
      <Text style={[styles.explanation, light && styles.lightMuted]}>
        Переписка с водителем пока недоступна. Когда функция будет подключена, чаты появятся здесь.
      </Text>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  page: { minHeight: 300, backgroundColor: onayDark.background, marginBottom: 18, borderRadius: 20, paddingHorizontal: 16, paddingTop: 22, paddingBottom: 28 },
  lightPage: { backgroundColor: "#f4f6f4" },
  heading: { fontSize: 26, fontWeight: "800", color: onayDark.text },
  lightHeading: { color: "#0e1a14" },
  empty: { marginTop: 34, paddingHorizontal: 14, alignItems: "center", gap: 10 },
  iconCircle: { width: 72, height: 72, borderRadius: 36, backgroundColor: onayDark.card, alignItems: "center", justifyContent: "center" },
  lightIconCircle: { backgroundColor: "#e6f0ea" },
  bubble: { width: 38, height: 29, borderWidth: 2, borderColor: onayDark.accent, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  bubbleDots: { fontSize: 20, lineHeight: 21, letterSpacing: 1, color: onayDark.accent, fontWeight: "800" },
  title: { fontSize: 20, fontWeight: "800", color: onayDark.text, textAlign: "center", marginTop: 4 },
  explanation: { fontSize: 13, lineHeight: 20, color: onayDark.muted, textAlign: "center", maxWidth: 285 },
  lightMuted: { color: "#5a7366" },
});
