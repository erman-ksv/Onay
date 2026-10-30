import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { validateApiEndpoint } from "../lib/api";
import { parsePassengerHistory, passengerHistoryDate, type PassengerHistoryRow } from "../lib/passenger-history";
import { formatFareMoney } from "../lib/fare-money";
import { isClosed, ridePickupLabel, rideDestinationLabel, statusLabels, type RideOrder } from "../lib/orders";

// The parent keys this component by endpoint/session/user and unmounts it when
// changing role. Aborting and generation checks also discard stale reads.
export default function PassengerHistory({ endpoint, token, passengerId, recentOrders }: {
  endpoint: string; token: string; passengerId: string; recentOrders: RideOrder[];
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PassengerHistoryRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(20);
  const generation = useRef(0), active = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    const ticket = ++generation.current;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    setRows(null); setLoading(true); setError(""); setLimit(20);
    try {
      const response = await fetch(validateApiEndpoint(endpoint) + "/api/orders", {
        signal: controller.signal, cache: "no-store", headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("History read failed");
      const value = parsePassengerHistory(await response.json(), passengerId);
      if (generation.current === ticket && !controller.signal.aborted) setRows(value);
    } catch {
      if (generation.current === ticket) setError("Не удалось получить историю. Проверь соединение и повтори обновление.");
    } finally { clearTimeout(timer); if (generation.current === ticket) setLoading(false); }
  }, [endpoint, token, passengerId]);
  useEffect(() => {
    if (open) void load();
    return () => { generation.current++; active.current?.abort(); };
  }, [open, load]);
  const recent = recentOrders.filter(order => order.passenger_id === passengerId && isClosed(order)).slice(0, 3);
  return <View style={s.card} testID="passenger-history">
    <Text style={s.heading}>{open ? "История поездок" : "Последние поездки"}</Text>
    {!open ? recent.map(order => <Text key={order.id} style={s.note}>{ridePickupLabel(order)} → {rideDestinationLabel(order)}: {statusLabels[order.status]}</Text>) : null}
    <Pressable accessibilityRole="button" testID="passenger-history-toggle" onPress={() => { setRows(null); setError(""); setOpen(value => !value); }} style={s.button}><Text>{open ? "Скрыть полную историю" : "Вся история поездок"}</Text></Pressable>
    {open ? <>
      {loading ? <Text testID="passenger-history-loading">Загружаем историю…</Text> : null}
      {error ? <Text testID="passenger-history-error" accessibilityRole="alert">{error}</Text> : null}
      {rows ? <View testID="passenger-history-results">
        <Text style={s.note}>Закрытых поездок: {rows.length}. Сначала новые.</Text>
        {!rows.length ? <Text testID="passenger-history-empty">Закрытых поездок пока нет.</Text> : null}
        {rows.slice(0, limit).map(({ order, money }) => <View key={order.id} style={s.row} testID={`passenger-history-row-${order.id}`}>
          <Text>{ridePickupLabel(order)} → {rideDestinationLabel(order)}</Text>
          <Text>{statusLabels[order.status]} · {order.seats} мест</Text>
          <Text>Дата заказа: {passengerHistoryDate(order.created_at)}</Text>
          <Text>Стоимость поездки: {money ? formatFareMoney(money) : "недоступна"}</Text>
          <Text style={s.note}>Заказ {order.id}</Text>
        </View>)}
        {rows.length > limit ? <Pressable accessibilityRole="button" testID="passenger-history-more" style={s.button} onPress={() => setLimit(value => value + 20)}><Text>Показать ещё</Text></Pressable> : null}
      </View> : null}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: loading }} testID="passenger-history-refresh" disabled={loading} onPress={() => { void load(); }} style={s.button}><Text>{loading ? "Обновляем…" : "Обновить историю"}</Text></Pressable>
    </> : null}
  </View>;
}
const s = StyleSheet.create({ card: { padding: 20, marginBottom: 16, backgroundColor: "#fff", borderRadius: 24, gap: 10 },
  heading: { fontSize: 20, fontWeight: "700", color: "#102D26" }, note: { color: "#53675E", lineHeight: 21 },
  button: { backgroundColor: "#EDF8F2", padding: 14, borderRadius: 12 }, row: { borderTopWidth: 1, borderColor: "#DCE5DF", paddingVertical: 12, gap: 5 } });
