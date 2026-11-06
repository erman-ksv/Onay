import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { onayDark } from "../lib/onay-auth-ui";
import { ONAY_PASSENGER_TABS, type OnayPassengerTab } from "../lib/onay-passenger-tabs";
import { onayTabWidths } from "../lib/onay-tab-layout";

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
  const insets = useSafeAreaInsets();
  const { width: viewportWidth } = useWindowDimensions();
  const tabWidths = onayTabWidths(viewportWidth);
  return <View testID="onay-passenger-bottom-nav" style={[styles.container, { paddingBottom: Math.max(20, insets.bottom) }, light && { backgroundColor: "#f1f7f3" }]}>
    <View accessibilityRole="tablist" style={[styles.pill, styles.referencePill, light && styles.pillLight]}>
      {ONAY_PASSENGER_TABS.map(tab => {
        const selected = active === tab.id;
        return <Pressable
          key={tab.id}
          testID={"onay-tab-" + tab.id}
          accessibilityRole="tab"
          accessibilityLabel={tab.label}
          accessibilityState={{ selected }}
          onPress={() => onSelect(tab.id)}
          style={[styles.tab, selected ? styles.activeTab : styles.inactiveTab, light && !selected && styles.inactiveTabLight, { width: selected ? tabWidths.active : tabWidths.inactive }]}
        >
          <Image accessible={false} source={TAB_ICONS[tab.id]} resizeMode="contain" style={[styles.icon, selected && styles.selectedText, light && !selected && styles.iconLight]} />
          {selected ? <Text style={styles.activeLabel} numberOfLines={1}>{tab.label}</Text> : null}
        </Pressable>;
      })}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  pillLight: { backgroundColor: "rgba(255,255,255,0.95)", borderColor: "#d3e3d9" },
  inactiveTabLight: { backgroundColor: "#eef3ef" },
  iconLight: { tintColor: "#35594a" },
  container: { backgroundColor: onayDark.background, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20 },
  pill: { flexDirection: "row", alignSelf: "center", width: "100%", maxWidth: 336, borderRadius: 40, backgroundColor: "rgba(18,41,31,0.94)", borderColor: onayDark.border,
    borderWidth: 1, padding: 8, gap: 8 },
  // Keep the safe responsive base; this override retains the 304dp reference artwork on normal screens.
  referencePill: { width: 304, maxWidth: "100%" },
  tab: { width: 48, height: 48, borderRadius: 24, alignItems: "center",
    justifyContent: "center", flexDirection: "row", gap: 8 },
  inactiveTab: { backgroundColor: onayDark.cardRaised },
  activeTab: { width: 120, backgroundColor: onayDark.accent },
  icon: { width: 22, height: 22, tintColor: "#cfe3d8" },
  selectedText: { tintColor: onayDark.accentInk },
  activeLabel: { fontSize: 13, fontWeight: "800", color: onayDark.accentInk, flexShrink: 1 },
});
