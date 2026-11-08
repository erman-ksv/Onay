import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Image, Pressable, StyleSheet, View } from "react-native";
import Text from "./OnayText";
import { onayDark } from "../lib/onay-auth-ui";
import { useOnayLanguage } from "../lib/onay-language-context";

const STATUS: Record<"ru" | "kk" | "uz", string> = {
 ru: "Загрузка",
 kk: "Жүктелуде",
 uz: "Yuklanmoqda",
};
const ERRORS: Record<"ru" | "kk" | "uz", string> = {
 ru: "Не удалось загрузить настройки на устройстве.",
 kk: "Құрылғыдағы параметрлерді жүктеу мүмкін болмады.",
 uz: "Qurilma sozlamalarini yuklab bo‘lmadi.",
};
const RETRY: Record<"ru" | "kk" | "uz", string> = {
 ru: "Повторить",
 kk: "Қайталау",
 uz: "Qayta urinish",
};

/** Brand screen is visible ONLY while actual startup/session work is pending. */
export default function OnayStartupLoading({
 error = false, onRetry, onContinue,
}: { error?: boolean; onRetry?: () => void; onContinue?: () => void }) {
 const { language } = useOnayLanguage();
 const [reduceMotion, setReduceMotion] = useState(true);
 const values = useRef([new Animated.Value(0.35), new Animated.Value(0.35), new Animated.Value(0.35)]).current;
 useEffect(() => {
  let mounted = true;
  void AccessibilityInfo.isReduceMotionEnabled().then(value => {
   if (mounted) setReduceMotion(value);
  }).catch(() => { if (mounted) setReduceMotion(true); });
  const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
  return () => { mounted = false; subscription.remove(); };
 }, []);
 useEffect(() => {
  if (error || reduceMotion) {
   values.forEach(value => { value.stopAnimation(); value.setValue(1); });
   return;
  }
  const pulses = values.map((value, index) => Animated.loop(Animated.sequence([
   Animated.delay(index * 115),
   Animated.timing(value, { toValue: 1, duration: 360, useNativeDriver: true }),
   Animated.timing(value, { toValue: 0.35, duration: 360, useNativeDriver: true }),
   Animated.delay((2 - index) * 115),
  ])));
  pulses.forEach(item => item.start());
  return () => pulses.forEach(item => item.stop());
 }, [values, error, reduceMotion]);
 return <View testID="onay-startup-screen" style={styles.root}>
   <View style={styles.center}>
    <Image testID="onay-startup-logo" source={require("../assets/onay-original-logo.png")}
      resizeMode="contain" style={styles.logo} accessibilityLabel="Onay"/>
    {error ? <Text testID="onay-startup-error" accessibilityRole="alert" style={styles.error}>
      {ERRORS[language]}
     </Text> : <>
      <View testID="onay-startup-squares" style={styles.dots}>
       {values.map((value, index) => <Animated.View key={index} testID={`onay-startup-square-${index}`}
         style={[styles.square, { opacity: value, transform: [{ scale: value.interpolate({ inputRange: [0.35, 1], outputRange: [0.78, 1] }) }] }]}/>)}
      </View>
      <Text testID="onay-startup-label" style={styles.label}>{STATUS[language]}</Text>
     </>}
    {error && onRetry ? <Pressable testID="onay-startup-retry" accessibilityRole="button" onPress={onRetry} style={styles.action}>
     <Text style={styles.actionText}>{RETRY[language]}</Text>
    </Pressable> : null}
    {error && onContinue ? <Pressable testID="onay-startup-continue" accessibilityRole="button" onPress={onContinue} style={styles.secondary}>
     <Text style={styles.secondaryText}>{language === "kk" ? "Әдепкі тілмен жалғастыру" : language === "uz" ? "Standart til bilan davom etish" : "Продолжить с языком по умолчанию"}</Text>
    </Pressable> : null}
   </View>
  </View>;
}
const styles=StyleSheet.create({
 root:{flex:1, backgroundColor:onayDark.background, justifyContent:"center",alignItems:"center"},
 center:{width:"100%",alignItems:"center",justifyContent:"center",paddingHorizontal:24},
 logo:{width:96,height:96},
 dots:{flexDirection:"row",alignItems:"center",justifyContent:"center",gap:9,marginTop:26,height:14},
 square:{width:11,height:11,borderRadius:2,backgroundColor:onayDark.accent},
 label:{color:onayDark.text,textAlign:"center",fontSize:16,lineHeight:24,fontWeight:"600",marginTop:13,includeFontPadding:false},
 error:{color:onayDark.text,textAlign:"center",fontSize:15,lineHeight:23,marginTop:28},
 action:{minHeight:48,minWidth:150,backgroundColor:onayDark.accent,borderRadius:12,marginTop:20,paddingHorizontal:18,alignItems:"center",justifyContent:"center"},
 actionText:{fontSize:15,fontWeight:"700",color:onayDark.accentInk},
 secondary:{minHeight:44,marginTop:12,paddingHorizontal:12,justifyContent:"center"},
 secondaryText:{fontSize:14,color:onayDark.muted,textAlign:"center"},
});
