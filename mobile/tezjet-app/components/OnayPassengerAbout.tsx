import Text from "./OnayText";
import Constants from "expo-constants";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";

type Props = {
  theme: "light" | "dark";
  onBack: () => void;
  backLabel?: string;
};

const APP_VERSION = Constants.expoConfig?.version ?? "0.1.0";
const BUILD = Constants.expoConfig?.extra?.onayBuild as { commit?: string; branch?: string; versionCode?: number } | undefined;

/** Passenger About page matching the Onay V2 HTML layout; no unverified legal links. */
export default function OnayPassengerAbout({ theme, onBack, backLabel = "Назад в профиль" }: Props) {
  const light = theme === "light";
  const primaryText = light ? "#0a1d15" : onayDark.text;
  const secondaryText = light ? "#5a7366" : onayDark.muted;

  return <View testID="onay-passenger-about-screen" style={[styles.root, light && styles.rootLight]}>
    <View style={styles.header}>
      <Pressable
        testID="onay-about-back"
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        onPress={onBack}
        style={[styles.back, light && styles.backLight]}
      >
        <Text style={[styles.backIcon, { color: primaryText }]}>‹</Text>
      </Pressable>
      <Text style={[styles.heading, { color: primaryText }]}>О приложении</Text>
    </View>
    {BUILD?.commit && BUILD.commit !== "local" ? <Text testID="onay-build-identity" style={{ color: secondaryText, textAlign: "center", fontSize: 12, marginTop: 8 }}>Тестовая сборка {BUILD.versionCode} · {BUILD.commit.slice(0, 12)}</Text> : null}
    <View style={styles.intro}>
      <Image
        testID="onay-about-confirmed-logo"
        source={require("../assets/onay-original-logo.png")}
        accessibilityLabel="Логотип Onay"
        resizeMode="contain"
        style={styles.logo}
      />
      <Text style={[styles.name, { color: primaryText }]}>Onay</Text>
      <Text testID="onay-about-real-version" style={[styles.version, { color: secondaryText }]}>Версия {APP_VERSION}</Text>
      <Text style={[styles.description, { color: secondaryText }]}>
        Междугородние поездки на такси. Выберите маршрут и остановку, затем оформите заказ.
        Стоимость и доступность водителей подтверждаются сервером.
      </Text>
    </View>
    <View style={[styles.companyCard, light && styles.companyCardLight]}>
      <Text style={[styles.companyName, { color: primaryText }]}>ONAY OST E.K.K Technologies</Text>
      <Text style={[styles.tagline, { color: secondaryText }]}>One Founder. Intelligent Systems.</Text>
    </View>
    <Text style={[styles.copyright, { color: secondaryText }]}>© 2026 ONAY OST E.K.K Technologies · All rights reserved.</Text>
  </View>;
}

const styles = StyleSheet.create({
  root: { minHeight: 440, backgroundColor: onayDark.background, padding: 0, borderRadius: 0, marginBottom: 18 },
  rootLight: { backgroundColor: "#f1f7f3" },
  header: { flexDirection: "row", alignItems: "center", gap: 14 },
  back: { height: 42, width: 42, borderRadius: 14, backgroundColor: onayDark.card, alignItems: "center", justifyContent: "center" },
  backLight: { backgroundColor: "#e6f0ea" },
  backIcon: { fontSize: 33, lineHeight: 38 },
  heading: { fontSize: 24, fontWeight: "800" },
  intro: { alignItems: "center", paddingHorizontal: 14, paddingTop: 32, gap: 12 },
  logo: { height: 96, width: 96, borderRadius: 24 },
  name: { fontSize: 28, fontWeight: "800" },
  version: { fontSize: 15 },
  description: { fontSize: 15, lineHeight: 23, textAlign: "center", marginTop: 4 },
  companyCard: { marginTop: 32, backgroundColor: onayDark.card, borderRadius: 20, alignItems: "center", gap: 8, padding: 20 },
  companyCardLight: { backgroundColor: "#ffffff" },
  companyName: { fontSize: 15, fontWeight: "800", textAlign: "center" },
  tagline: { fontSize: 13, textAlign: "center" },
  copyright: { marginTop: 30, fontSize: 11, textAlign: "center" },
});
