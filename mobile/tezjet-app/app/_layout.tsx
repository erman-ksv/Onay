import { OnayLanguageProvider, useOnayLanguage } from "../lib/onay-language-context";
import OnayStartupLoading from "../components/OnayStartupLoading";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { onayDark } from "../lib/onay-auth-ui";

// Keep Android's configured native logo visible until the translated JS UI is laid out.
void SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ fade: true, duration: 160 });

function StartupRouter() {
 const { hydration, retryLanguage, continueWithDefaultLanguage } = useOnayLanguage();
 const [laidOut, setLaidOut] = useState(false);
 useEffect(() => {
  if (laidOut && hydration !== "loading") void SplashScreen.hideAsync().catch(() => {});
 }, [laidOut, hydration]);
 return <View style={{ flex: 1, backgroundColor: onayDark.background }} onLayout={() => setLaidOut(true)}>
  <StatusBar style="light" backgroundColor={onayDark.background}/>
  {hydration === "loading" ? <View testID="onay-language-hydrating" style={{ flex: 1, backgroundColor: onayDark.background }}/> :
   hydration === "error" ? <OnayStartupLoading error onRetry={retryLanguage} onContinue={continueWithDefaultLanguage}/> :
   <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: onayDark.background } }}/>}
 </View>;
}
export default function RootLayout() {
 return <SafeAreaProvider><OnayLanguageProvider><StartupRouter/></OnayLanguageProvider></SafeAreaProvider>;
}
