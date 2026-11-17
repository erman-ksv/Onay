import { useEffect } from "react";
import { Platform } from "react-native";
import * as NavigationBar from "expo-navigation-bar";
/** Gesture-area colors stay managed by Android edge-to-edge; match icon contrast. */
export function useOnaySystemUi(theme: "light" | "dark") {
 useEffect(() => {
  if (Platform.OS !== "android") return;
  void NavigationBar.setButtonStyleAsync(theme === "dark" ? "light" : "dark").catch(() => {
   // Older Android implementations may manage system button contrast themselves.
  });
 }, [theme]);
}
