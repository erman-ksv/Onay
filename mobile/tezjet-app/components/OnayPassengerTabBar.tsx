import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";
import { ONAY_PASSENGER_TABS, type OnayPassengerTab } from "../lib/onay-passenger-tabs";

// Source icons are traced from the four tabs in the user's Onay.html reference.
const TAB_ICONS = {
  home: require("../assets/onay-nav-home.png"),
  trips: require("../assets/onay-nav-trips.png"),
  chats: require("../assets/onay-nav-chat.png"),
  profile: require("../assets/onay-nav-user.png"),
} as const;

export default function OnayPassengerTabBar({ active, onSelect, theme = "dark" }: {
  active: OnayPassengerTab;
  theme?: "light" | "dark";
  onSelect: (tab: OnayPassengerTab) => void;
}) {
  const light = theme === "light";
  return <View testID="onay-passenger-bottom-nav" style={[styles.container, light && { backgroundColor: "#f4f6f4" }]}>
    <View accessibilityRole="tablist" style={[styles.pill, light && styles.pillLight]}>
      {ONAY_PASSENGER_TABS.map(tab => {
        const selected = active === tab.id;
        return <Pressable
          key={tab.id}
          testID={"onay-tab-" + tab.id}
          accessibilityRole="tab"
          accessibilityLabel={tab.label}
          accessibilityState={{ selected }}
          onPress={() => onSelect(tab.id)}
          style={[styles.tab, selected ? styles.activeTab : styles.inactiveTab, light && !selected && styles.inactiveTabLight]}
        >
          <Image accessible={false} source={TAB_ICONS[tab.id]} resizeMode="contain" style={[styles.icon, selected && styles.selectedText, light && !selected && styles.iconLight]} />
          {selected ? <Text style={styles.activeLabel} numberOfLines={1}>{tab.label}</Text> : null}
        </Pressable>;
      })}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  pillLight: { backgroundColor: "rgba(255,255,255,0.95)", borderColor: "#e3e8e4" },
  inactiveTabLight: { backgroundColor: "#eef3ef" },
  iconLight: { tintColor: "#35594a" },
  container: { backgroundColor: onayDark.background, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 16 },
  pill: { flexDirection: "row", alignSelf: "center", width: 304, maxWidth: "100%", borderRadius: 40, backgroundColor: "rgba(18,41,31,0.94)", borderColor: onayDark.border,
    borderWidth: 1, padding: 8, gap: 8 },
  tab: { width: 48, height: 48, borderRadius: 24, alignItems: "center",
    justifyContent: "center", flexDirection: "row", gap: 8 },
  inactiveTab: { backgroundColor: onayDark.cardRaised },
  activeTab: { width: 120, backgroundColor: onayDark.accent },
  icon: { width: 22, height: 22, tintColor: "#cfe3d8" },
  selectedText: { tintColor: onayDark.accentInk },
  activeLabel: { fontSize: 13, fontWeight: "800", color: onayDark.accentInk, flexShrink: 1 },
});
