import Text from "./OnayText";
import { Pressable, StyleSheet, View } from "react-native";
import { useOnayLanguage } from "../lib/onay-language-context";
import { onayPalette } from "./OnayScreenFrame";

/** KZ is the display label. The persisted locale is kk. */
const options = [
  { code: "ru", caption: "RU" },
  { code: "uz", caption: "UZ" },
  { code: "kk", caption: "KZ" },
] as const;

export default function OnayInlineLanguage({ theme, testID }: { theme: "light" | "dark"; testID: string }) {
  const { language, changeLanguage, t } = useOnayLanguage();
  const c = onayPalette(theme);
  return <View testID={testID} accessibilityRole="radiogroup" accessibilityLabel={t("Язык")}
    style={[s.container, { backgroundColor: c.cardRaised, borderColor: c.border }]}>
    {options.map(item => {
      const selected = language === item.code;
      return <Pressable key={item.code} testID={"onay-language-" + item.code}
        accessibilityRole="radio" accessibilityLabel={item.caption}
        accessibilityState={{ checked: selected }} onPress={() => changeLanguage(item.code)}
        style={[s.option, { backgroundColor: selected ? c.accent : c.cardRaised }]}>
        <Text numberOfLines={1} style={{ color: selected ? c.accentInk : c.text, fontSize: 12, fontWeight: "800" }}>{item.caption}</Text>
      </Pressable>;
    })}
  </View>;
}
const s = StyleSheet.create({
  container: { flexDirection: "row", flexShrink: 0, borderWidth: 1, borderRadius: 14, padding: 3, gap: 2 },
  option: { minWidth: 34, height: 34, paddingHorizontal: 5, borderRadius: 10, alignItems: "center", justifyContent: "center" },
});
