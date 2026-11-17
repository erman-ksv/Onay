import { Image } from "react-native";
import { onayDark } from "../lib/onay-auth-ui";
/** Rasterized directly from IC in the approved published HTML, with native tint. */
const icons = {
 list: require("../assets/onay-v2/list.png"), gear: require("../assets/onay-v2/gear.png"),
 home: require("../assets/onay-v2/home.png"), trips: require("../assets/onay-v2/trips.png"), chat: require("../assets/onay-v2/chat.png"), user: require("../assets/onay-v2/user.png"),
 pin: require("../assets/onay-v2/pin.png"), city: require("../assets/onay-v2/city.png"), village: require("../assets/onay-v2/village.png"), chev: require("../assets/onay-v2/chev.png"), back: require("../assets/onay-v2/back.png"),
 seat: require("../assets/onay-v2/seat.png"), clock: require("../assets/onay-v2/clock.png"), car: require("../assets/onay-v2/car.png"), sun: require("../assets/onay-v2/sun.png"), moon: require("../assets/onay-v2/moon.png"), phone: require("../assets/onay-v2/phone.png"), check: require("../assets/onay-v2/check.png"), warn: require("../assets/onay-v2/warn.png"),
} as const;
export type OnayIconName = keyof typeof icons;
export default function OnayIcon({ name, size = 22, color = onayDark.text }: { name: OnayIconName; size?: number; color?: string }) {
 return <Image accessible={false} source={icons[name]} resizeMode="contain" style={{ width: size, height: size, tintColor: color }}/>;
}
