import { useState, type ReactNode } from "react";
import { ActivityIndicator, Modal, Pressable, Text, View } from "react-native";
import { ridePickupLabel, rideDestinationLabel, statusLabels, type RideOrder } from "../lib/orders";
import { formatFareMoney, parseServerFareMoney } from "../lib/fare-money";
import OnayScreenFrame, { onayPalette } from "./OnayScreenFrame";
import OnayIcon from "./OnayIcon";
import OnayRouteSchematic from "./OnayRouteSchematic";

/** Compact Trips card and a native full-page track view, backed by the same order. */
export default function OnayPassengerRide({ order, theme, children }: { order: RideOrder; theme: "light" | "dark"; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const c = onayPalette(theme), searching = order.status === "searching";
  const label = searching && order.offered_driver_id ? "Ждём ответа водителя" : statusLabels[order.status];
  let amount = "Стоимость недоступна";
  try { amount = formatFareMoney(parseServerFareMoney(order.fare)); } catch { /* An absent quote is never zero. */ }
  return <View testID={`passenger-trip-${order.id}`}>
    <Pressable testID={`onay-ride-open-${order.id}`} accessibilityRole="button" accessibilityLabel="Открыть текущую поездку" onPress={() => setOpen(true)} style={{ padding: 16, borderRadius: 20, backgroundColor: c.card, borderWidth: 1, borderColor: c.accent, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><View style={{ backgroundColor: c.cardRaised, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, flexShrink: 1 }}><Text style={{ color: c.accent, fontSize: 13, fontWeight: "700" }}>{label}</Text></View><View style={{ flex: 1 }}/><OnayIcon name="chev" color={c.muted}/></View>
      <Text style={{ color: c.text, fontWeight: "700", fontSize: 16, lineHeight: 23 }}>{ridePickupLabel(order)} → {rideDestinationLabel(order)}</Text>
      <Text style={{ color: c.muted, fontSize: 14 }}>{amount} · Пассажиров: {order.seats}</Text>
    </Pressable>
    <Modal visible={open} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setOpen(false)}>
      <OnayScreenFrame title={label} theme={theme} onBack={() => setOpen(false)} testID={`onay-ride-details-${order.id}`}>
        {searching ? <><Text style={{ color: c.muted, fontSize: 15, lineHeight: 22, marginTop: 8 }}>Проверяем направление, места и доступность</Text><ActivityIndicator size="large" color={c.accent} style={{ marginVertical: 44 }}/></> : <View style={{ marginTop: 12 }}><OnayRouteSchematic start={ridePickupLabel(order)} end={rideDestinationLabel(order)}/></View>}
        <View style={{ backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 14, marginTop: 16 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}><OnayIcon name="pin" color={c.accent}/><View style={{ flex: 1 }}><Text style={{ color: c.muted, fontSize: 12 }}>Откуда</Text><Text style={{ color: c.text, fontWeight: "700", fontSize: 16 }}>Точка подачи: {ridePickupLabel(order)}</Text></View></View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}><OnayIcon name="city" color={c.accent}/><View style={{ flex: 1 }}><Text style={{ color: c.muted, fontSize: 12 }}>Куда</Text><Text style={{ color: c.text, fontWeight: "700", fontSize: 16 }}>Куда: {rideDestinationLabel(order)}</Text></View></View>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}><Text style={{ color: c.muted }}>Пассажиров: {order.seats}</Text><Text style={{ color: c.text, fontSize: 18, fontWeight: "700" }}>{amount}</Text></View>
        </View>
        {children}
      </OnayScreenFrame>
    </Modal>
  </View>;
}
