import { OnayThemeContext } from "../lib/onay-theme-context";
import type { ReactNode, RefObject } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { onayDark } from "../lib/onay-auth-ui";
import type { OnayPassengerTab } from "../lib/onay-passenger-tabs";

type Props = {
  active: OnayPassengerTab;
  theme: "light" | "dark";
  homeScroll: RefObject<ScrollView | null>;
  home: ReactNode;
  trips: ReactNode;
  chats: ReactNode;
  profile: ReactNode;
};

// Four mounted, independent scroll containers keep the passenger's form drafts
// and tab positions, rather than using anchor jumps in a shared long page.
export default function OnayPassengerScreens({ active, theme, homeScroll, home, trips, chats, profile }: Props) {
  const insets = useSafeAreaInsets();
  const pages = [
    { id: "home", content: home }, { id: "trips", content: trips },
    { id: "chats", content: chats }, { id: "profile", content: profile },
  ] as const;
  return <OnayThemeContext.Provider value={theme}><View style={styles.root} testID="onay-passenger-four-screens">
    {pages.map(page => {
      const selected = active === page.id;
      return <View key={page.id} testID={"onay-screen-" + page.id}
        style={[styles.page, !selected && styles.inactive]}
        accessibilityElementsHidden={!selected}
        importantForAccessibility={selected ? "auto" : "no-hide-descendants"}
        pointerEvents={selected ? "auto" : "none"}>
        <ScrollView ref={page.id === "home" ? homeScroll : undefined}
          style={{ backgroundColor: theme === "light" ? "#f1f7f3" : onayDark.background }}
          contentContainerStyle={[styles.content, { paddingTop: Math.max(insets.top, 16) }]}
          keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
          scrollEnabled={selected}>{page.content}</ScrollView>
      </View>;
    })}
  </View></OnayThemeContext.Provider>;
}
const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  page: { flex: 1, minHeight: 0 },
  inactive: { display: "none" },
  content: { paddingHorizontal: 20, paddingBottom: 24, maxWidth: 430, width: "100%", alignSelf: "center" },
});
