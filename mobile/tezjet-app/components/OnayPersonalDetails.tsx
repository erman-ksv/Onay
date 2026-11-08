import Text from "./OnayText";
import TextInput from "./OnayTextInput";
import OnayScreenFrame, { onayPalette } from "./OnayScreenFrame";
import { normalizeOnayContactEmail } from "../lib/onay-contact-email";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

type Props = {
  theme: "light" | "dark";
  fullName: string;
  givenName?: string | null;
  familyName?: string | null;
  phoneNumber?: string | null;
  email?: string | null;
  demoMode?: boolean;
  onBack: () => void;
  onSaveEmail?: (email: string | null) => Promise<string | null>;
};
export default function OnayPersonalDetails({ theme, fullName, givenName, familyName, phoneNumber, email,
  demoMode = false, onBack, onSaveEmail }: Props) {
  const c = onayPalette(theme);
  const [draft, setDraft] = useState(email ?? "");
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { setDraft(email ?? ""); setError(""); }, [email]);
  const given = givenName?.trim() || null;
  const family = familyName?.trim() || null;
  const row = (label: string, value: string, id: string) => <View key={id} style={styles.row}>
    <Text style={[styles.label, { color: c.muted }]}>{label}</Text>
    <View testID={id} accessibilityLabel={label + ": " + value}
      style={[styles.readOnly, { backgroundColor: c.cardRaised, borderColor: c.border }]}>
      <Text style={[styles.value, { color: c.text }]}>{value}</Text>
    </View>
  </View>;
  async function saveEmail() {
    if (busyRef.current || demoMode || !onSaveEmail) return;
    let normalized: string | null;
    try { normalized = normalizeOnayContactEmail(draft); }
    catch (e) { setError((e as Error).message); setNotice(""); return; }
    busyRef.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const confirmed = await onSaveEmail(normalized);
      if (confirmed !== normalized) throw new Error("Сервер не подтвердил сохранение email.");
      setDraft(confirmed ?? "");
      setNotice("Email сохранён на сервере.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить email. Повтори попытку.");
    } finally { busyRef.current = false; setSaving(false); }
  }
  return <OnayScreenFrame testID="onay-personal-details-screen" title="Личные данные" theme={theme} onBack={onBack}>
    <View testID="onay-profile-personal-details" style={[styles.card, { backgroundColor: c.card }]}>
      {row("Имя", given ?? "Не хранится отдельно", "onay-profile-personal-name")}
      {row("Фамилия", family ?? "Не хранится отдельно", "onay-profile-personal-surname")}
      {row("Номер телефона", phoneNumber || "Не указан", "onay-profile-personal-phone")}
      <View style={styles.row}>
        <Text style={[styles.label, { color: c.muted }]}>Email (необязательно)</Text>
        <TextInput testID="onay-profile-personal-email" accessibilityLabel="Email"
          autoCapitalize="none" autoCorrect={false} keyboardType="email-address" maxLength={254}
          editable={!saving && !demoMode && !!onSaveEmail} value={draft} onChangeText={setDraft}
          placeholder="example@mail.com" placeholderTextColor={c.muted}
          style={[styles.input, { color: c.text, backgroundColor: c.cardRaised, borderColor: c.border }]}/>
      </View>
      {!given || !family ? <Text testID="onay-personal-name-storage-note"
        style={[styles.note, { color: c.muted }]}>
        Имя и фамилия не сохранены отдельно. Полное ФИО в аккаунте: {fullName || "Не указано"}. Мы не разделяем его автоматически, чтобы не исказить данные.
      </Text> : null}
      {demoMode ? <Text testID="onay-personal-email-demo-notice" style={[styles.note, { color: c.muted }]}>
        ДЕМО · Сохранение email на сервере недоступно.
      </Text> : null}
      {error ? <Text testID="onay-personal-email-error" accessibilityRole="alert" style={{ color: c.danger }}>{error}</Text> : null}
      {notice ? <Text testID="onay-personal-email-saved" accessibilityLiveRegion="polite" style={{ color: c.text }}>{notice}</Text> : null}
      <Pressable testID="onay-personal-email-save" accessibilityRole="button"
        accessibilityState={{ disabled: saving || demoMode || !onSaveEmail }}
        disabled={saving || demoMode || !onSaveEmail} onPress={() => { void saveEmail(); }}
        style={[styles.save, { backgroundColor: c.accent, opacity: saving || demoMode || !onSaveEmail ? .5 : 1 }]}>
        <Text style={{ color: c.accentInk, fontWeight: "700", fontSize: 16 }}>{saving ? "Сохраняем…" : "Сохранить"}</Text>
      </Pressable>
    </View>
  </OnayScreenFrame>;
}
const styles = StyleSheet.create({
  card: { marginTop: 18, padding: 16, borderRadius: 20, gap: 14, marginBottom: 24 },
  row: { gap: 7 },
  label: { fontSize: 13, fontWeight: "600" },
  readOnly: { minHeight: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, justifyContent: "center" },
  value: { fontSize: 15, fontWeight: "600" },
  input: { minHeight: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, fontSize: 15 },
  note: { fontSize: 12, lineHeight: 19 },
  save: { borderRadius: 14, minHeight: 50, alignItems: "center", justifyContent: "center", marginTop: 6 },
});
