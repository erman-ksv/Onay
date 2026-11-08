import TextInput from "./OnayTextInput";
import Text from "./OnayText";
import { Pressable, StyleSheet, } from "react-native";
import OnayScreenFrame, { onayPalette } from "./OnayScreenFrame";
export default function OnayServerSettings({ value, onChange, onSave, onBack, busy, error, theme = "dark" }: {
 value: string; onChange: (value: string) => void; onSave: () => void; onBack: () => void; busy: boolean; error: string; theme?: "light" | "dark";
}) {
 const c = onayPalette(theme);
 return <OnayScreenFrame title="Сервер Onay" onBack={onBack} theme={theme} testID="onay-server-settings-panel" footer={<Pressable accessibilityRole="button" accessibilityLabel="Сохранить сервер" onPress={onSave} disabled={busy || !value.trim()} style={[s.button, { backgroundColor: c.accent, opacity: busy || !value.trim() ? .45 : 1 }]}><Text style={s.buttonText}>{busy ? "Подключаем…" : "Сохранить сервер"}</Text></Pressable>}>
 <Text style={[s.description, { color: c.muted }]}>Укажи адрес сервера для подключения. При смене сервера потребуется вход по телефону.</Text>
 <Text style={[s.label, { color: c.muted }]}>Адрес API</Text>
 <TextInput testID="onay-server-url" accessibilityLabel="Адрес сервера Onay" style={[s.input, { backgroundColor: c.card, borderColor: error ? c.danger : c.border, color: c.text }]} placeholderTextColor={c.muted} value={value} onChangeText={onChange} placeholder="https://api.onay…" autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy}/>
 {error ? <Text accessibilityRole="alert" style={[s.description, { color: c.danger }]}>{error}</Text> : null}
 </OnayScreenFrame>;
}
const s = StyleSheet.create({ description: { fontSize: 15, lineHeight: 22, marginTop: 16 }, label: { fontSize: 13, marginTop: 24, marginBottom: 6 }, input: { minHeight: 54, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, fontSize: 17 }, button: { minHeight: 54, borderRadius: 18, alignItems: "center", justifyContent: "center" }, buttonText: { color: "#08261a", fontSize: 17, fontWeight: "600" } });
