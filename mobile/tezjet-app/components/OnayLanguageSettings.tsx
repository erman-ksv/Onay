import { Pressable, View } from "react-native";
import Text from "./OnayText";
import OnayScreenFrame from "./OnayScreenFrame";
import { ONAY_LANGUAGES } from "../lib/onay-translations";
import { useOnayLanguage } from "../lib/onay-language-context";
import { onayPalette } from "./OnayScreenFrame";
export default function OnayLanguageSettings({ theme, onBack }: { theme: "light" | "dark"; onBack: () => void }) {
 const { language, changeLanguage, t } = useOnayLanguage(); const c = onayPalette(theme);
 return <OnayScreenFrame title={t("Язык приложения")} theme={theme} onBack={onBack}>
 <View accessibilityRole="radiogroup" accessibilityLabel={t("Язык приложения")} style={{ gap: 12, marginTop: 24 }}>
 {ONAY_LANGUAGES.map(item => <Pressable key={item.code} testID={"onay-language-" + item.code} accessibilityRole="radio" accessibilityState={{ checked: language === item.code }} onPress={() => changeLanguage(item.code)} style={{ padding: 20, minHeight: 60, borderRadius: 18, backgroundColor: c.card, borderWidth: 1, borderColor: language === item.code ? c.accent : c.border, flexDirection: "row", justifyContent: "space-between" }}><Text style={{ color: c.text, fontSize: 18 }}>{item.name}</Text><Text style={{ color: c.accent }}>{language === item.code ? "✓" : ""}</Text></Pressable>)}
 </View></OnayScreenFrame>;
}
