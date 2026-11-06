import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
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
    {historyOpen ?
      <Pressable
        testID="onay-trips-back-to-active"
        accessibilityRole="button"
        accessibilityLabel="Назад к активным поездкам"
        onPress={onShowActive}
        style={s.back}
      ><Text style={[s.backText, light && s.lightMuted]}>‹  Назад к поездкам</Text></Pressable> : null}
    <View style={s.header}>
      <Text testID="onay-passenger-trips-title" accessibilityRole="header" style={[s.heading, light && s.lightText]}>
        {historyOpen ? "История поездок" : "Поездки"}
      </Text>
      {!historyOpen ? <Pressable
        testID="onay-trips-open-history"
        accessibilityRole="button"
        accessibilityLabel="Открыть историю поездок"
        onPress={onShowHistory}
        style={[s.historyButton, light && s.historyButtonLight]}
      ><Text style={[s.historyLink, light && s.historyLinkLight]}>История  ›</Text></Pressable> : null}
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
  back: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
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
