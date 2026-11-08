import Text from "./OnayText";
import { StyleSheet, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";

type Props = { theme?: "light" | "dark"; role?: "passenger" | "driver"; showHeading?: boolean };

/**
 * Onay Passenger V2 chat-list empty state.
 * Messaging is not implemented: do not simulate driver conversations or send requests.
 */
export default function OnayPassengerChatsEmpty({ theme = "dark", role = "passenger", showHeading = true }: Props) {
  const light = theme === "light";
  return <View testID="onay-chats-empty-state" style={[styles.page, light && styles.lightPage]}>
    {showHeading ? <Text testID="onay-chats-inner-heading" style={[styles.heading, light && styles.lightHeading]}>Чаты</Text> : null}
    <View style={styles.empty}>
      <View style={[styles.iconCircle, light && styles.lightIconCircle]} accessible={false}>
        <View style={styles.bubble}>
          <View style={styles.bubbleTail} />
        </View>
      </View>
      <Text testID="onay-chats-empty-title" style={[styles.title, light && styles.lightHeading]}>
        Чатов пока нет
      </Text>
      <Text testID={role === "driver" ? "onay-driver-chats-unavailable" : "onay-passenger-chats-unavailable"}
        style={[styles.explanation, light && styles.lightMuted]}>
        {role === "driver"
          ? "Чаты с пассажирами пока недоступны. Сообщения и переписка ещё не реализованы."
          : "Переписка с водителем пока недоступна. Когда функция будет подключена, чаты появятся здесь."}
      </Text>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  page: { minHeight: 365, backgroundColor: onayDark.background, marginBottom: 18, paddingHorizontal: 0, paddingTop: 22, paddingBottom: 30 },
  lightPage: { backgroundColor: "#f1f7f3" },
  heading: { fontSize: 30, fontWeight: "700", color: onayDark.text, letterSpacing: -0.3 },
  lightHeading: { color: "#0a1d15" },
  empty: { marginTop: 90, paddingHorizontal: 12, alignItems: "center", gap: 4 },
  iconCircle: { width: 72, height: 72, borderRadius: 36, backgroundColor: onayDark.cardRaised, alignItems: "center", justifyContent: "center" },
  lightIconCircle: { backgroundColor: "#e6f0ea" },
  bubble: { width: 42, height: 28, borderWidth: 2, borderColor: onayDark.accent, borderRadius: 3, position: "relative" },
  bubbleTail: { position: "absolute", left: 1, bottom: -7, width: 10, height: 10, backgroundColor: onayDark.cardRaised, borderLeftWidth: 2, borderBottomWidth: 2, borderColor: onayDark.accent, transform: [{ skewY: "-35deg" }] },
  title: { fontSize: 17, fontWeight: "600", color: onayDark.text, textAlign: "center", marginTop: 14 },
  explanation: { fontSize: 14, lineHeight: 21, color: onayDark.muted, textAlign: "center", maxWidth: 308, marginTop: 4 },
  lightMuted: { color: "#5a7366" },
});
