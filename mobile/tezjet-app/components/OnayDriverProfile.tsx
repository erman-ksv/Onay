import { useState } from "react";
import OnayLanguageSettings from "./OnayLanguageSettings";
import { useOnayLanguage } from "../lib/onay-language-context";
import { ONAY_LANGUAGES } from "../lib/onay-translations";
import Text from "./OnayText";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import Constants from "expo-constants";
import OnayIcon from "./OnayIcon";
import { onayPalette } from "./OnayScreenFrame";
import type { DriverVehicle } from "../lib/driver-vehicle";

export default function OnayDriverProfile({ fullName, vehicle, approval, theme, onTheme, onVehicle, onSupport, onAbout, onPassenger, onServer, onLogout, busy }: {
 fullName: string; vehicle?: Partial<DriverVehicle>; approval?: string; theme: "light" | "dark"; onTheme: (theme: "light" | "dark") => void;
 onVehicle: () => void; onSupport: () => void; onAbout: () => void; onPassenger: () => void; onServer: () => void; onLogout: () => void; busy: boolean;
}) {
 const c = onayPalette(theme);
 const [languageOpen, setLanguageOpen] = useState(false);
 const { language } = useOnayLanguage();
 const row = (label: string, value: string, onPress?: () => void) => <Pressable key={label} testID={label === "Язык приложения" ? "onay-driver-language" : label === "Автомобиль" ? "onay-driver-car-edit" : label === "Режим пассажира" ? "onay-switch-to-passenger" : undefined} accessibilityRole={onPress ? "button" : undefined} disabled={!onPress || busy} onPress={onPress} style={[s.row, { borderColor: c.border }]}><Text style={[s.label, { color: c.muted }]}>{label}</Text><Text style={[s.value, { color: c.text }]}>{value}</Text>{onPress ? <OnayIcon name="chev" color={c.muted}/> : null}</Pressable>;
 if (languageOpen) return <Modal visible animationType="slide" onRequestClose={() => setLanguageOpen(false)}><OnayLanguageSettings theme={theme} onBack={() => setLanguageOpen(false)}/></Modal>;
 return <View testID="onay-driver-profile-v2" style={s.root}>
  <View style={s.header}><View style={[s.avatar, { backgroundColor: c.cardRaised }]}><OnayIcon name="user" color={c.muted}/></View><Text style={[s.name, { color: c.text }]}>{fullName || "Водитель"}</Text>
  <View style={[s.themes, { backgroundColor: c.card }]}>{(["light","dark"] as const).map(value => <Pressable key={value} testID={"onay-driver-theme-"+value} accessibilityRole="button" accessibilityLabel={value === "light" ? "Светлая тема" : "Тёмная тема"} accessibilityState={{ selected: value === theme }} onPress={() => onTheme(value)} style={[s.theme, { backgroundColor: value === theme ? c.accent : c.card }]}><OnayIcon name={value === "light" ? "sun" : "moon"} color={value === theme ? c.accentInk : c.muted}/></Pressable>)}</View></View>
  <View style={[s.list, { backgroundColor: c.card }]}>
   {row("Автомобиль", vehicle ? [vehicle.make,vehicle.model].filter(Boolean).join(" ") : "Добавить",onVehicle)}
   {row("Номер",vehicle?.plate_number || "Не указан",onVehicle)}
   {row("Мест в салоне",vehicle?.seat_capacity ? String(vehicle.seat_capacity) : "Не указано",onVehicle)}
   {row("Анкета",approval === "approved" ? "Подтверждена" : approval === "blocked" ? "Заблокирована" : approval === "rejected" ? "Отклонена" : "На проверке")}
  </View>
  <View style={[s.list, { backgroundColor: c.card }]}>{row("Язык приложения", ONAY_LANGUAGES.find(item => item.code === language)?.name ?? "Русский", () => setLanguageOpen(true))}{row("Поддержка","",onSupport)}{row("О приложении","",onAbout)}{row("Режим пассажира","",onPassenger)}{row("Настройки сервера","",onServer)}</View>
  <Pressable testID="onay-driver-logout" accessibilityRole="button" accessibilityLabel="Выйти из аккаунта" disabled={busy} onPress={onLogout} style={[s.logout,{backgroundColor:c.card}]}><Text style={{color:c.danger,fontSize:16}}>Выйти</Text></Pressable>
  <Text style={[s.version,{color:c.muted}]}>Onay Driver · Версия {Constants.expoConfig?.version || "0.1.0"}</Text>
 </View>;
}
const s=StyleSheet.create({root:{gap:16},header:{flexDirection:"row",alignItems:"center",gap:12,paddingTop:10,marginBottom:8},avatar:{width:78,height:78,borderRadius:39,alignItems:"center",justifyContent:"center"},name:{flex:1,fontSize:22,fontWeight:"700"},themes:{flexDirection:"row",gap:2,padding:4,borderRadius:16},theme:{width:40,height:38,borderRadius:12,alignItems:"center",justifyContent:"center"},list:{borderRadius:20,overflow:"hidden"},row:{minHeight:58,paddingHorizontal:16,paddingVertical:10,borderTopWidth:1,flexDirection:"row",alignItems:"center",gap:8},label:{flex:1,fontSize:14},value:{maxWidth:"62%",fontSize:16,fontWeight:"600",flexShrink:1},logout:{minHeight:58,borderRadius:20,paddingHorizontal:16,justifyContent:"center"},version:{textAlign:"center",fontSize:13,marginTop:20,marginBottom:16}});
