import Text from "./OnayText";
import OnayBuildIdentity from "./OnayBuildIdentity";
import type { OnayBuildMode } from "../lib/onay-build-identity";
import Constants from "expo-constants";
import { Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState } from "react";
import { onayDark } from "../lib/onay-auth-ui";
import { useOnayLanguage } from "../lib/onay-language-context";

type Props = {
  theme: "light" | "dark";
  onBack: () => void;
  backLabel?: string;
  mode?: OnayBuildMode;
};

const APP_VERSION = Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "недоступна";

/** Passenger About page matching the Onay V2 HTML layout; no unverified legal links. */
export default function OnayPassengerAbout({ theme, onBack, backLabel = "Назад в профиль", mode = "live" }: Props) {
  const light = theme === "light";
  const insets = useSafeAreaInsets();
  const { t } = useOnayLanguage();
  const [selectedLegalDocument, setSelectedLegalDocument] = useState<string | null>(null);
  const primaryText = light ? "#0a1d15" : onayDark.text;
  const secondaryText = light ? "#5a7366" : onayDark.muted;

  return <View testID="onay-passenger-about-screen" style={[styles.root, light && styles.rootLight, { paddingTop: insets.top }]}>
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
    <ScrollView testID="onay-about-scroll" style={styles.scroll} contentContainerStyle={[styles.content, { paddingBottom: Math.max(24, insets.bottom + 20) }]}>
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
      <OnayBuildIdentity mode={mode} color={secondaryText}/>
      <Text style={[styles.description, { color: secondaryText }]}>Междугородние поездки на такси. Выберите маршрут и остановку, затем оформите заказ. Стоимость и доступность водителей подтверждаются сервером.</Text>
    </View>
    <View style={[styles.legalCard, light && styles.companyCardLight]}>
      {(["Политика конфиденциальности", "Условия использования"] as const).map((label, index) =>
        <Pressable key={label} testID={index === 0 ? "onay-legal-privacy-unavailable" : "onay-legal-terms-unavailable"}
          accessibilityRole="button" accessibilityLabel={t(label)} accessibilityHint={t("Документ не опубликован")}
          onPress={() => setSelectedLegalDocument(label)}
          style={[styles.legalRow, index > 0 && { borderTopWidth: 1, borderTopColor: light ? "#d3e3d9" : onayDark.border }]}>
          <Text style={{ color: primaryText, fontSize: 15, fontWeight: "600" }}>{label}</Text>
          <Text style={{ color: secondaryText, fontSize: 12, marginTop: 5 }}>Документ не опубликован</Text>
        </Pressable>)}
      {selectedLegalDocument ? <Text testID="onay-about-legal-feedback" accessibilityRole="alert"
        style={[styles.legalFeedback, { color: secondaryText }]}>{t(selectedLegalDocument)}: {t("Документ не опубликован")}</Text> : null}
    </View>
    <View style={[styles.companyCard, light && styles.companyCardLight]}>
      <Text style={[styles.companyName, { color: primaryText }]}>ONAY OST E.K.K Technologies</Text>
      <Text style={[styles.tagline, { color: secondaryText }]}>One Founder. Intelligent Systems.</Text>
    </View>
    <View style={{ height: 1, backgroundColor: light ? "#d3e3d9" : onayDark.border, marginTop: 20 }}/>
    <Text style={[styles.copyright, { color: secondaryText }]}>© 2026 ONAY OST E.K.K Technologies · All rights reserved.</Text>
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, backgroundColor: onayDark.background },
  scroll: { flex: 1, minHeight: 0 },
  content: { width: "100%", maxWidth: 430, alignSelf: "center", paddingHorizontal: 20 },
  rootLight: { backgroundColor: "#f1f7f3" },
  header: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, width: "100%", maxWidth: 430, alignSelf: "center" },
  back: { height: 42, width: 42, borderRadius: 14, backgroundColor: onayDark.card, alignItems: "center", justifyContent: "center" },
  backLight: { backgroundColor: "#e6f0ea" },
  backIcon: { fontSize: 33, lineHeight: 38 },
  heading: { fontSize: 24, fontWeight: "800" },
  intro: { alignItems: "center", paddingHorizontal: 14, paddingTop: 20, gap: 12 },
  logo: { height: 96, width: 96, borderRadius: 24 },
  name: { fontSize: 28, fontWeight: "800" },
  version: { fontSize: 15 },
  description: { fontSize: 15, lineHeight: 23, textAlign: "center", marginTop: 4 },
  legalCard: { marginTop: 26, backgroundColor: onayDark.card, borderRadius: 20, overflow: "hidden", paddingHorizontal: 16 },
  legalRow: { minHeight: 66, paddingVertical: 14, justifyContent: "center" },
  legalFeedback: { fontSize: 13, lineHeight: 19, paddingVertical: 14 },
  companyCard: { marginTop: 20, backgroundColor: onayDark.card, borderRadius: 20, alignItems: "center", gap: 8, padding: 20 },
  companyCardLight: { backgroundColor: "#ffffff" },
  companyName: { fontSize: 15, fontWeight: "800", textAlign: "center" },
  tagline: { fontSize: 13, textAlign: "center" },
  copyright: { marginTop: 30, fontSize: 11, textAlign: "center" },
});
