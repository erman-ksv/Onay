import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onayEntryScreen, onayDark } from "../lib/onay-auth-ui.ts";
import { hydrateOnayStartupLanguage, parseOnayStartupLanguage } from "../lib/onay-startup-language.ts";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("native Onay splash and Android adaptive icon share the real logo and dark background", () => {
 const config=JSON.parse(read("../app.json")).expo;
 const plugin=config.plugins.find(p=>Array.isArray(p) && p[0]==="expo-splash-screen");
 assert.ok(plugin, "Expo prebuild must generate a native splash");
 const props=plugin[1];
 assert.equal(props.image,"./assets/onay-original-logo.png");
 assert.equal(props.backgroundColor,onayDark.background);
 assert.equal(props.dark.backgroundColor,onayDark.background);
 assert.equal(config.android.adaptiveIcon.foregroundImage,"./assets/onay-original-logo.png");
 assert.equal(config.android.adaptiveIcon.backgroundColor,onayDark.background);
 assert.equal(config.android.package,"uz.tezjet.app");
});
test("brand startup uses saved language, not a speculative first Russian frame", () => {
 const context=read("../lib/onay-language-context.tsx");
 const layout=read("../app/_layout.tsx");
 const startup=read("../components/OnayStartupLoading.tsx");
 assert.match(read("../lib/onay-startup-language.ts"),/onay_language_v1/);
 assert.match(context,/hydration: "loading"/);
 assert.match(context,/AsyncStorage\.getItem\(LANGUAGE_KEY\)/);
 assert.match(context,/setHydration\("ready"\)/);
 assert.match(context,/setHydration\("error"\)/);
 assert.match(layout,/SplashScreen\.preventAutoHideAsync\(\)/);
 assert.match(layout,/SplashScreen\.hideAsync\(\)/);
 assert.match(layout,/hydration === "loading"/);
 assert.match(layout,/hydration === "error"/);
 assert.match(startup,/ru: "Загрузка"/);
 assert.match(startup,/kk: "Жүктелуде"/);
 assert.match(startup,/uz: "Yuklanmoqda"/);
 assert.match(startup,/onay-startup-label/);
 assert.match(startup,/onay-startup-squares/);
 assert.match(startup,/onay-original-logo\.png/);
 assert.doesNotMatch(startup,/setTimeout\(|setInterval\(/);
});
test("animation stops on unmount, honors reduce motion, initialization errors can retry", () => {
 const startup=read("../components/OnayStartupLoading.tsx");
 const index=read("../app/index.tsx");
 assert.match(startup,/AccessibilityInfo\.isReduceMotionEnabled\(\)/);
 assert.match(startup,/reduceMotionChanged/);
 assert.match(startup,/pulses\.forEach\(item => item\.stop\(\)\)/);
 assert.match(startup,/onay-startup-error/);
 assert.match(startup,/onay-startup-retry/);
 assert.match(index,/setSessionRestoreRevision\(v => v \+ 1\)/);
 assert.match(index,/onContinue=\{\(\) => setSessionRestoreError\(false\)\}/);
 assert.match(index,/if \(entryScreen === "loading"\) return <OnayStartupLoading\/>/);
});
test("restore must resolve before auth; server remains optional for demo", () => {
 const params={token:"",apiBase:"https://demo.invalid",showEndpointSettings:false};
 assert.equal(onayEntryScreen({...params,sessionLoading:true}),"loading");
 assert.equal(onayEntryScreen({...params,sessionLoading:false}),"auth");
 assert.equal(onayEntryScreen({...params,sessionLoading:false,token:"saved"}),"application");
 const index=read("../app/index.tsx");
 assert.match(index,/demoRole && enabled/);
 assert.match(index,/onDemo=\{enabled \? setDemoRole : undefined\}/);
 assert.match(index,/AsyncStorage\.multiGet\(\[API_ENDPOINT, TOKEN\]\)/);
 assert.match(index,/setMode\(\(me\.user\.active_role \?\? me\.user\.role\) === "driver"/);
});

test("persisted RU UZ KK resolve before loading label; transient storage error retries",async()=>{
 for (const lang of ["ru","uz","kk"]) {
  assert.equal(await hydrateOnayStartupLanguage(async()=>lang),lang);
 }
 assert.equal(parseOnayStartupLanguage(null),"ru");
 assert.equal(parseOnayStartupLanguage("invalid"),"ru");
 let calls=0;
 const read=async()=>{calls++;if(calls===1)throw new Error("storage temporarily unavailable");return "uz";};
 await assert.rejects(()=>hydrateOnayStartupLanguage(read),/storage temporarily unavailable/);
 assert.equal(await hydrateOnayStartupLanguage(read),"uz");
 assert.equal(calls,2);
});
