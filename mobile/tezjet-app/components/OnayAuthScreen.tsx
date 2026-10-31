import { useState } from "react";
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable,
  Image, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { isCompleteOnayPhone, onayDark, onayPhoneFromInput, onayPhoneInput, onayPhonePrefix } from "../lib/onay-auth-ui";
import { registrationFullName } from "../lib/registration";

type Mode = "passenger" | "driver";

type Props = {
  mode: Mode;
  registering: boolean;
  requested: boolean;
  busy: boolean;
  phone: string;
  name: string;
  surname: string;
  otp: string;
  demoCode: string;
  error?: string;
  onPhone: (phone: string) => void;
  onName: (name: string) => void;
  onSurname: (surname: string) => void;
  onOtp: (code: string) => void;
  onRegisterMode: (registering: boolean) => void;
  onMode: (mode: Mode) => void;
  onBackToPhone: () => void;
  onSubmit: (verify: boolean) => void;
  onServerSettings: () => void;
};

/**
 * Native first-step implementation of the ONAY V2 auth artifact.
 * All requests and tokens still flow through the existing app's login().
 */
export default function OnayAuthScreen(props: Props) {
  const [consent, setConsent] = useState(true);
  const phoneReady = isCompleteOnayPhone(props.phone);
  const nameReady = !props.registering || !!registrationFullName(props.name, props.surname);
  const canSubmit = !props.busy && (props.requested ? !!props.otp.trim() : phoneReady && nameReady && consent);

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        style={s.scroller}
        contentContainerStyle={s.screen}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel="Вход в Onay"
      >
        <View style={s.logoWrap}>
          <Image testID="onay-auth-original-logo" source={require("../assets/onay-original-logo.png")} style={s.brandImage} resizeMode="contain" accessibilityLabel="Onay" />
          <Text style={s.subtitle}>
            {props.mode === "passenger" ? "Сельское такси между селом и городом" : "Режим водителя"}
          </Text>
        </View>

        <View style={s.form}>
          <Text style={s.heading}>
            {props.requested ? "Подтвердить номер телефона" :
              props.registering ? (props.mode === "driver" ? "Регистрация водителя" : "Регистрация пассажира") : "Войти по номеру телефона"}
          </Text>

          {!props.requested ? (
            <>
              {props.registering ? (
                <>
                  <Text style={s.label}>Имя</Text>
                  <TextInput
                    testID="registration-given-name"
                    style={s.input}
                    value={props.name}
                    onChangeText={props.onName}
                    editable={!props.busy}
                    placeholder="Имя"
                    placeholderTextColor={onayDark.muted}
                    autoCapitalize="words"
                  />
                  <Text style={s.label}>Фамилия</Text>
                  <TextInput
                    testID="registration-family-name"
                    style={s.input}
                    value={props.surname}
                    onChangeText={props.onSurname}
                    editable={!props.busy}
                    placeholder="Фамилия"
                    placeholderTextColor={onayDark.muted}
                    autoCapitalize="words"
                  />
                </>
              ) : null}
              <Text style={s.label}>Номер телефона</Text>
              <View style={s.phoneRow}>
                <View style={s.country}><Text style={s.countryText}>{onayPhonePrefix(props.phone)}</Text></View>
                <TextInput
                  testID="onay-auth-phone"
                  style={[s.input, s.phoneInput]}
                  value={onayPhoneInput(props.phone)}
                  onChangeText={v => props.onPhone(onayPhoneFromInput(props.phone, v))}
                  placeholder="+998 90 123 45 67"
                  placeholderTextColor="#70857a"
                  keyboardType="phone-pad"
                  textContentType="telephoneNumber"
                  autoComplete="tel"
                  editable={!props.busy}
                  maxLength={14}
                />
              </View>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: consent }}
                onPress={() => setConsent(value => !value)}
                style={s.consentRow}
              >
                <View style={[s.checkbox, !consent && s.checkboxOff]}>
                  {consent ? <Text style={s.checkboxTick}>✓</Text> : null}
                </View>
                <Text style={s.consentText}>
                  Я принимаю условия использования и политику конфиденциальности
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={s.muted}>Код подтверждения отправляется на {props.phone}</Text>
              <TextInput
                testID="onay-auth-otp"
                style={s.input}
                value={props.otp}
                onChangeText={props.onOtp}
                editable={!props.busy}
                placeholder="Код подтверждения"
                placeholderTextColor="#70857a"
                keyboardType="number-pad"
                autoComplete="one-time-code"
              />
              {props.demoCode ? <Text style={s.demo}>Тестовый код: {props.demoCode}</Text> : null}
              <Pressable onPress={props.onBackToPhone} disabled={props.busy}>
                <Text style={s.inlineLink}>Изменить номер телефона</Text>
              </Pressable>
            </>
          )}
          {props.error ? <Text style={s.error}>{props.error}</Text> : null}
        </View>

        <View style={s.bottom}>
          <Pressable
            testID="onay-auth-submit"
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSubmit }}
            disabled={!canSubmit}
            style={[s.primary, !canSubmit && s.primaryOff]}
            onPress={() => props.onSubmit(props.requested)}
          >
            {props.busy ? <ActivityIndicator color={onayDark.accentInk}/> :
              <Text style={[s.primaryText, !canSubmit && s.primaryTextOff]}>
                {props.requested ? (props.mode === "driver" ? "Продолжить как водитель" : "Войти как пассажир") : "Получить код"}
              </Text>}
          </Pressable>
          <Text style={s.info}>
            {props.demoCode ? "Демо-код доступен только в тестовой среде" :
              props.mode === "driver" ? "Профиль водителя требует одобрения администратора" :
              "Код отправляется через настроенный SMS-сервис"}
          </Text>

          <View style={s.links}>
            <Pressable
              testID={props.registering ? "auth-signin-mode" : "auth-signup-mode"}
              onPress={() => props.onRegisterMode(!props.registering)}
              disabled={props.busy}
            >
              <Text style={s.link}>
                {props.registering ? "Уже зарегистрирован? Войти" : "Нет аккаунта? Регистрация"}
              </Text>
            </Pressable>
            <View style={s.roleModes}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: props.mode === "passenger", disabled: props.busy }}
                testID="onay-auth-role-passenger"
                onPress={() => props.onMode("passenger")}
                disabled={props.busy}
                style={[s.roleButton, props.mode === "passenger" && s.roleButtonActive]}
              >
                <Text style={[s.roleButtonLabel, props.mode === "passenger" && s.roleButtonLabelActive]}>Пассажир</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                testID="onay-auth-role-switch"
                accessibilityState={{ selected: props.mode === "driver", disabled: props.busy }}
                onPress={() => props.onMode("driver")}
                disabled={props.busy}
                style={[s.roleButton, props.mode === "driver" && s.roleButtonActive]}
              >
                <Text style={[s.roleButtonLabel, props.mode === "driver" && s.roleButtonLabelActive]}>Водитель</Text>
              </Pressable>
            </View>
            <Pressable testID="onay-auth-server-settings" onPress={props.onServerSettings} disabled={props.busy}>
              <Text style={s.serverLink}>Настройки сервера</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  brandImage: { height: 118, width: 118 },
  root: { flex: 1, backgroundColor: onayDark.background },
  scroller: { flex: 1 },
  screen: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 44, paddingBottom: 20, minHeight: 720 },
  logoWrap: { alignItems: "center", marginBottom: 12 },
  symbol: { height: 76, width: 76, borderWidth: 5, borderColor: onayDark.accent, borderRadius: 38, alignItems: "center", justifyContent: "center" },
  symbolText: { fontSize: 37, color: onayDark.accent, fontWeight: "700" },
  wordmark: { color: onayDark.accent, fontSize: 38, fontWeight: "800", letterSpacing: -2, marginTop: 3 },
  subtitle: { fontSize: 14, color: onayDark.muted, marginTop: 14, textAlign: "center" },
  form: { marginTop: 6 },
  heading: { fontSize: 21, fontWeight: "700", color: onayDark.text, marginBottom: 12 },
  label: { fontSize: 13, color: onayDark.muted, marginBottom: 6, marginTop: 8 },
  input: { height: 54, borderRadius: 16, backgroundColor: onayDark.card, borderWidth: 1, borderColor: onayDark.border, color: onayDark.text, fontSize: 17, paddingHorizontal: 15 },
  phoneRow: { flexDirection: "row", gap: 8 },
  phoneInput: { flex: 1, minWidth: 0 },
  country: { height: 54, borderRadius: 16, borderColor: onayDark.border, borderWidth: 1, backgroundColor: onayDark.card, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  countryText: { fontSize: 17, fontWeight: "700", color: onayDark.text },
  consentRow: { flexDirection: "row", alignItems: "flex-start", marginTop: 20, gap: 12 },
  checkbox: { height: 26, width: 26, backgroundColor: onayDark.accent, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  checkboxOff: { backgroundColor: "transparent", borderWidth: 2, borderColor: onayDark.muted },
  checkboxTick: { color: onayDark.accentInk, fontSize: 17, fontWeight: "800" },
  consentText: { flex: 1, fontSize: 14, color: onayDark.muted, lineHeight: 21 },
  muted: { color: onayDark.muted, fontSize: 14, marginBottom: 12 },
  demo: { color: onayDark.accent, fontSize: 13, paddingVertical: 8 },
  inlineLink: { marginTop: 14, color: onayDark.accent, fontSize: 14 },
  error: { color: onayDark.danger, marginTop: 12 },
  bottom: { marginTop: "auto", paddingTop: 35 },
  primary: { minHeight: 54, borderRadius: 18, backgroundColor: onayDark.accent, alignItems: "center", justifyContent: "center" },
  primaryOff: { backgroundColor: "#17372c" },
  primaryText: { color: onayDark.accentInk, fontSize: 17, fontWeight: "700" },
  primaryTextOff: { color: "#849a8c" },
  info: { textAlign: "center", color: onayDark.muted, fontSize: 12, marginTop: 12 },
  links: { flexDirection: "row", justifyContent: "center", gap: 17, flexWrap: "wrap", marginTop: 18 },
  link: { color: onayDark.accent, fontSize: 13, fontWeight: "600" },
  roleModes: { flexDirection: "row", borderWidth: 1, borderColor: onayDark.border, borderRadius: 14, padding: 4, backgroundColor: onayDark.card, gap: 4 },
  roleButton: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, minHeight: 42, justifyContent: "center" },
  roleButtonActive: { backgroundColor: onayDark.accent },
  roleButtonLabel: { color: onayDark.muted, fontWeight: "600", fontSize: 13 },
  roleButtonLabelActive: { color: onayDark.accentInk },
  serverLink: { color: onayDark.muted, fontSize: 12 },
});
