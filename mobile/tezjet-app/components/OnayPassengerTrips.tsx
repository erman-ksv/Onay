import Text from "./OnayText";
import OnayIcon from "./OnayIcon";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";

type Props = {
  theme: "light" | "dark";
  activeCount: number;
  historyOpen: boolean;
  onShowHistory: () => void;
  onShowActive: () => void;
  onBook: () => void;
  activeContent: ReactNode;
  historyContent: ReactNode;
};

/**
 * Real passenger Trips / History screen of ONAY V2.
 * The parent provides only server-derived orders and the actual API-backed
 * PassengerHistory, so the view never invents rides, drivers or prices.
 */
export default function OnayPassengerTrips({
  theme, activeCount, historyOpen, onShowHistory, onShowActive, onBook, activeContent, historyContent,
}: Props) {
  const light = theme === "light";
  return <View testID="onay-passenger-trips-screen" style={[s.page, light && s.lightPage]}>
    <View style={s.header}>
    {historyOpen ?
      <Pressable
        testID="onay-trips-back-to-active"
        accessibilityRole="button"
        accessibilityLabel="Назад"
        onPress={onShowActive}
        style={[s.back, { backgroundColor: light ? "#ffffff" : onayDark.card }]}
      ><OnayIcon name="back" color={light ? "#0a1d15" : onayDark.text}/></Pressable> : null}
      <Text testID="onay-passenger-trips-title" accessibilityRole="header" style={[s.heading, light && s.lightText, historyOpen && { fontSize: 21, flex: 1 }]}>
        {historyOpen ? "История поездок" : "Поездки"}
      </Text>

    </View>
    {historyOpen ? historyContent : activeCount > 0 ? activeContent :
      <View testID="onay-trips-empty" style={s.empty}>
        <View style={[s.emptyIcon, light && s.emptyIconLight]} accessible={false}>
          <Text style={s.emptyIconText}>◷</Text>
        </View>
        <Text style={[s.emptyTitle, light && s.lightText]}>Активных поездок нет</Text>
        <Text style={[s.emptyDescription, light && s.lightMuted]}>
          Здесь появится текущая поездка после подтверждения заказа.
        </Text>
        <Pressable
          testID="onay-trips-book"
          accessibilityRole="button"
          accessibilityLabel="Выбрать маршрут"
          onPress={onBook}
          style={s.bookButton}
        ><Text style={s.bookText}>Выбрать маршрут</Text></Pressable>
      </View>}
  </View>;
}

const s = StyleSheet.create({
  page: { minHeight: 320, marginBottom: 16, backgroundColor: onayDark.background, paddingTop: 18, paddingHorizontal: 4 },
  lightPage: { backgroundColor: "#f1f7f3" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, paddingBottom: 12 },
  heading: { fontSize: 30, fontWeight: "700", letterSpacing: -0.3, color: onayDark.text },
  lightText: { color: "#0a1d15" },
  lightMuted: { color: "#5a7366" },
  historyButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 10, borderRadius: 12 },
  historyButtonLight: { backgroundColor: "#e7f1e9" },
  historyLink: { color: onayDark.accent, fontWeight: "700", fontSize: 14 },
  historyLinkLight: { color: "#135e39" },
  back: { height: 46, width: 46, borderRadius: 23, justifyContent: "center", alignItems: "center" },
  backText: { fontSize: 14, color: onayDark.muted },
  empty: { paddingTop: 58, paddingHorizontal: 24, alignItems: "center", gap: 10 },
  emptyIcon: { height: 72, width: 72, borderRadius: 36, backgroundColor: onayDark.cardRaised, alignItems: "center", justifyContent: "center" },
  emptyIconLight: { backgroundColor: "#e5f0e8" },
  emptyIconText: { color: onayDark.accent, fontSize: 32 },
  emptyTitle: { fontSize: 17, fontWeight: "700", textAlign: "center", marginTop: 12, color: onayDark.text },
  emptyDescription: { color: onayDark.muted, textAlign: "center", fontSize: 14, lineHeight: 21, maxWidth: 280 },
  bookButton: { backgroundColor: onayDark.accent, minHeight: 48, borderRadius: 16, marginTop: 16, paddingHorizontal: 22, alignItems: "center", justifyContent: "center" },
  bookText: { color: onayDark.accentInk, fontSize: 15, fontWeight: "800" },
});
