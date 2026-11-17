import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { translateOnay, type OnayLanguage } from "./onay-translations";
import { hydrateOnayStartupLanguage } from "./onay-startup-language";

const LANGUAGE_KEY = "onay_language_v1";
type LanguageHydration = "loading" | "ready" | "error";
type LanguageState = {
 language: OnayLanguage;
 hydration: LanguageHydration;
 changeLanguage: (value: OnayLanguage) => void;
 retryLanguage: () => void;
 continueWithDefaultLanguage: () => void;
};
const Context = createContext<LanguageState>({
 language: "ru", hydration: "loading", changeLanguage: () => {}, retryLanguage: () => {},
 continueWithDefaultLanguage: () => {},
});

export function OnayLanguageProvider({ children }: { children: ReactNode }) {
 const [language, setLanguage] = useState<OnayLanguage>("ru");
 const [hydration, setHydration] = useState<LanguageHydration>("loading");
 const [revision, setRevision] = useState(0);
 const changed = useRef(false);
 useEffect(() => {
  let active = true;
  // Keep the translated startup label hidden until this read has completed.
  void hydrateOnayStartupLanguage(() => AsyncStorage.getItem(LANGUAGE_KEY)).then(value => {
   if (!active) return;
   if (!changed.current) setLanguage(value);
   setHydration("ready");
  }).catch(() => { if (active) setHydration("error"); });
  return () => { active = false; };
 }, [revision]);
 const retryLanguage = useCallback(() => { setHydration("loading"); setRevision(v => v + 1); }, []);
 const continueWithDefaultLanguage = useCallback(() => { changed.current = true; setHydration("ready"); }, []);
 const changeLanguage = useCallback((value: OnayLanguage) => {
  changed.current = true;
  setLanguage(value);
  setHydration("ready");
  void AsyncStorage.setItem(LANGUAGE_KEY, value).catch(() => {});
 }, []);
 return <Context.Provider value={{ language, hydration, changeLanguage, retryLanguage, continueWithDefaultLanguage }}>{children}</Context.Provider>;
}
export function useOnayLanguage() {
 const context = useContext(Context);
 return { ...context, t: (text: string) => translateOnay(text, context.language) };
}
