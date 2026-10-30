import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { validateApiEndpoint } from "../lib/api";
import { parseDriverHistory, type DriverHistory as Snapshot } from "../lib/driver-history";
import { formatFareMoney } from "../lib/fare-money";
import { ridePickupLabel, rideDestinationLabel, statusLabels } from "../lib/orders";

// Parent keys this component by endpoint/session/user and unmounts it on role
// change. Generation + abort also discard superseded responses and teardown.
export default function DriverHistory({ endpoint, token, driverId }: { endpoint: string; token: string; driverId: string }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(20);
  const generation = useRef(0), active = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    const ticket = ++generation.current;
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    setSnapshot(null); setLoading(true); setError(""); setLimit(20);
    try {
      const response = await fetch(validateApiEndpoint(endpoint) + "/api/orders", {
        signal: controller.signal, cache: "no-store", headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error("History read failed");
      const value = parseDriverHistory(await response.json(), driverId);
      if (generation.current === ticket && !controller.signal.aborted) setSnapshot(value);
    } catch {
      if (generation.current === ticket) setError("Не удалось получить историю. Проверь соединение и повтори обновление.");
    } finally { clearTimeout(timer); if (generation.current === ticket) setLoading(false); }
  }, [endpoint, token, driverId]);
  useEffect(() => {
    if (open) void load();
    return () => { generation.current++; active.current?.abort(); };
  }, [open, load]);
  return <View style={s.card} testID="driver-history">
    <Text style={s.heading}>История и заработок</Text>
    <Pressable accessibilityRole="button" testID="driver-history-toggle" onPress={() => setOpen(value => !value)} style={s.button}><Text>{open ? "Скрыть историю" : "Показать историю"}</Text></Pressable>
    {open ? <>
      <Text style={s.note}>Все закрытые поездки этого водителя. Сумма тарифов завершённых поездок — без подтверждения оплаты и вычета расходов.</Text>
      {loading ? <Text testID="driver-history-loading">Загружаем историю…</Text> : null}
      {error ? <Text testID="driver-history-error" accessibilityRole="alert">{error}</Text> : null}
      {snapshot ? <>
        <View testID="driver-history-totals"><Text>Завершено поездок: {snapshot.completed}</Text>
          {snapshot.totals === null ? <Text>Сумма недоступна: у части завершённых поездок нет достоверной стоимости.</Text>
            : snapshot.totals.length ? snapshot.totals.map(money => <Text key={money.currency}>{formatFareMoney(money)}</Text>)
            : <Text>Завершённых поездок с заработком пока нет.</Text>}
        </View>
        {!snapshot.rows.length ? <Text testID="driver-history-empty">Закрытых поездок пока нет.</Text> : null}
        {snapshot.rows.slice(0, limit).map(({ order, money }) => <View key={order.id} style={s.row} testID={`driver-history-row-${order.id}`}>
          <Text>{ridePickupLabel(order)} → {rideDestinationLabel(order)}</Text>
          <Text>{statusLabels[order.status]} · {order.seats} мест</Text>
          <Text>{money ? formatFareMoney(money) : "Стоимость недоступна"}{order.status === "cancelled" ? " · не входит в заработок" : ""}</Text>
          <Text style={s.note}>Заказ {order.id}</Text>
          <Text style={s.note}>Обновлено: {order.updated_at ?? order.created_at ?? "дата недоступна"}</Text>
        </View>)}
        {snapshot.rows.length > limit ? <Pressable accessibilityRole="button" style={s.button} onPress={() => setLimit(value => value + 20)}><Text>Показать ещё</Text></Pressable> : null}
      </> : null}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: loading }} testID="driver-history-refresh" disabled={loading} onPress={() => { void load(); }} style={s.button}><Text>{loading ? "Обновляем…" : "Обновить историю"}</Text></Pressable>
    </> : null}
  </View>;
}
const s = StyleSheet.create({ card: { padding: 20, marginBottom: 16, backgroundColor: "#fff", borderRadius: 24, gap: 10 },
  heading: { fontSize: 20, fontWeight: "700", color: "#102D26" }, note: { color: "#53675E", lineHeight: 21 },
  button: { backgroundColor: "#EDF8F2", padding: 14, borderRadius: 12 }, row: { borderTopWidth: 1, borderColor: "#DCE5DF", paddingTop: 12, gap: 5 } });
