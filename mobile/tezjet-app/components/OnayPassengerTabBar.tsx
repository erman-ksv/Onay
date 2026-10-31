import { Pressable, StyleSheet, Text, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";
import { ONAY_PASSENGER_TABS, type OnayPassengerTab } from "../lib/onay-passenger-tabs";

export default function OnayPassengerTabBar({ active, onSelect, theme = "dark" }: {
  active: OnayPassengerTab;
  theme?: "light" | "dark";
  onSelect: (tab: OnayPassengerTab) => void;
}) {
  return <View testID="onay-passenger-bottom-nav" style={[styles.container, theme === "light" && { backgroundColor: "#f4f6f4" }]}>
    <View accessibilityRole="tablist" style={styles.pill}>
      {ONAY_PASSENGER_TABS.map(tab => {
        const selected = active === tab.id;
        return <Pressable
          key={tab.id}
          testID={"onay-tab-" + tab.id}
          accessibilityRole="tab"
          accessibilityLabel={tab.label}
          accessibilityState={{ selected }}
          onPress={() => onSelect(tab.id)}
          style={[styles.tab, selected ? styles.activeTab : styles.inactiveTab]}
        >
          <Text style={[styles.icon, selected && styles.selectedText]}>{tab.symbol}</Text>
          {selected ? <Text style={styles.activeLabel} numberOfLines={1}>{tab.label}</Text> : null}
        </Pressable>;
      })}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  container: { backgroundColor: onayDark.background, paddingHorizontal: 12, paddingTop: 7, paddingBottom: 14 },
  pill: { flexDirection: "row", borderRadius: 40, backgroundColor: onayDark.card, borderColor: onayDark.border,
    borderWidth: 1, padding: 7, gap: 6 },
  tab: { minWidth: 0, height: 48, borderRadius: 24, alignItems: "center",
    justifyContent: "center", flexDirection: "row", gap: 5 },
  inactiveTab: { flex: 1, backgroundColor: onayDark.cardRaised },
  activeTab: { flex: 2.2, backgroundColor: onayDark.accent },
  icon: { fontSize: 20, color: "#d0e4d7", fontWeight: "700" },
  selectedText: { color: onayDark.accentInk },
  activeLabel: { fontSize: 13, fontWeight: "800", color: onayDark.accentInk, flexShrink: 1 },
});
