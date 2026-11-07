import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { translateOnay, type OnayLanguage } from "./onay-translations";
const LANGUAGE_KEY = "onay_language_v1";
const Context = createContext<{ language: OnayLanguage; changeLanguage: (value: OnayLanguage) => void }>({ language: "ru", changeLanguage: () => {} });
export function OnayLanguageProvider({ children }: { children: ReactNode }) {
 const [language, setLanguage] = useState<OnayLanguage>("ru");
 const changed = useRef(false);
 useEffect(() => { let active = true; void AsyncStorage.getItem(LANGUAGE_KEY).then(value => { if (active && !changed.current && (value === "ru" || value === "kk" || value === "uz")) setLanguage(value); }).catch(() => {}); return () => { active = false; }; }, []);
 function changeLanguage(value: OnayLanguage) { changed.current = true; setLanguage(value); void AsyncStorage.setItem(LANGUAGE_KEY, value).catch(() => {}); }
 return <Context.Provider value={{ language, changeLanguage }}>{children}</Context.Provider>;
}
export function useOnayLanguage() { const context = useContext(Context); return { ...context, t: (text: string) => translateOnay(text, context.language) }; }
