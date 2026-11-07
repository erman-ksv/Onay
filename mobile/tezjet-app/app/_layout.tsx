import { OnayLanguageProvider } from "../lib/onay-language-context";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    <SafeAreaProvider><OnayLanguageProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </OnayLanguageProvider></SafeAreaProvider>
  );
}