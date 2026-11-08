import Constants from "expo-constants";
import { View } from "react-native";
import Text from "./OnayText";
import { getOnayBuildIdentity, type OnayBuildMode } from "../lib/onay-build-identity";

export default function OnayBuildIdentity({ mode, compact = false, color }: {
  mode: OnayBuildMode;
  compact?: boolean;
  color: string;
}) {
  const info = getOnayBuildIdentity(
    Constants.expoConfig?.version,
    Constants.nativeAppVersion,
    Constants.nativeBuildVersion,
    Constants.expoConfig?.extra?.onayBuild,
    mode,
  );
  const code = info.versionCode === null ? "недоступен" : String(info.versionCode);
  if (compact) return <Text testID="onay-profile-build-identity" style={{
    color, fontSize: 11, textAlign: "center", lineHeight: 17,
  }}>APK {code} · SHA {info.shortSha} · {info.mode}</Text>;
  return <View testID="onay-about-build-details" style={{ alignItems: "center", gap: 5, marginTop: 9 }}>
    <Text testID="onay-about-version-code" style={{ color, fontSize: 12 }}>Android versionCode: {code}</Text>
    <Text testID="onay-about-source-sha" style={{ color, fontSize: 12 }}>SHA исходников: {info.shortSha}</Text>
    <Text testID="onay-about-runtime-mode" style={{ color, fontSize: 12 }}>Режим: {info.mode}</Text>
    {info.versionMismatch ? <Text testID="onay-about-build-mismatch" style={{ color: "#e69c62", textAlign: "center", fontSize: 12 }}>
      Внимание: версия APK и метаданные сборки не совпадают
    </Text> : null}
  </View>;
}
