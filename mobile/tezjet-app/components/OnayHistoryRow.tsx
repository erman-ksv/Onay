import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { ridePickupLabel, rideDestinationLabel, statusLabels, type RideOrder } from "../lib/orders";
import { passengerHistoryDate } from "../lib/passenger-history";
import OnayScreenFrame, { onayPalette } from "./OnayScreenFrame";
import OnayIcon from "./OnayIcon";

/** Reference history card; details contain only the frozen authorized API order. */
export default function OnayHistoryRow({ order, amount, theme, testID, driver = false }: {
  order: RideOrder; amount: string; theme: "light" | "dark"; testID: string; driver?: boolean;
}) {
  const [details, setDetails] = useState(false);
  const c = onayPalette(theme), cancelled = order.status === "cancelled";
  const route = `${ridePickupLabel(order)} → ${rideDestinationLabel(order)}`;
  return <>
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={route + ", " + statusLabels[order.status]}
      onPress={() => setDetails(true)} style={[s.card, { backgroundColor: c.card }]}>
      <View style={s.line}>
        <View style={[s.badge, { backgroundColor: c.cardRaised }]}><Text style={{ color: cancelled ? c.danger : c.accent, fontSize: 12, fontWeight: "700" }}>{statusLabels[order.status]}</Text></View>
        <Text style={[s.small, { color: c.muted, flexShrink: 1 }]}>{passengerHistoryDate(order.created_at)}</Text>
      </View>
      <Text style={[s.route, { color: c.text }]}>{route}</Text>
      <View style={s.line}><Text style={[s.small, { color: c.muted, flex: 1 }]}>Пассажиров: {order.seats}</Text><Text style={{ color: c.text, fontWeight: "700", fontSize: 15 }}>{amount}</Text><OnayIcon name="chev" size={18} color={c.muted}/></View>
      {driver && cancelled ? <Text style={[s.small, { color: c.muted }]}>Не входит в заработок</Text> : null}
    </Pressable>
    <Modal visible={details} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setDetails(false)}>
      <OnayScreenFrame title="Поездка" theme={theme} onBack={() => setDetails(false)} testID={`onay-${driver ? "driver" : "passenger"}-history-details-${order.id}`}>
        <View style={[s.card, { backgroundColor: c.card }]}>
          <Text style={[s.route, { color: c.text }]}>{route}</Text>
          {[['Статус', statusLabels[order.status]], ['Дата заказа', passengerHistoryDate(order.created_at)], ['Пассажиров', String(order.seats)], ['Стоимость поездки', amount], ['Заказ', order.id]].map(([label, value]) => <View key={label} style={{ gap: 4, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.border }}><Text style={[s.small, { color: c.muted }]}>{label}</Text><Text selectable style={{ color: c.text, fontSize: 16 }}>{value}</Text></View>)}
        </View>
      </OnayScreenFrame>
    </Modal>
  </>;
}
const s = StyleSheet.create({ card: { padding: 16, borderRadius: 20, gap: 10, marginTop: 10 }, line: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }, badge: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 14 }, route: { fontSize: 16, fontWeight: "700", lineHeight: 23 }, small: { fontSize: 13, lineHeight: 19 } });
