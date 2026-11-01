import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { validateApiEndpoint } from "../lib/api";
import { parseDriverHistory, type DriverHistory as Snapshot } from "../lib/driver-history";
import { formatFareMoney } from "../lib/fare-money";
import { onayDark } from "../lib/onay-auth-ui";
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
    <Pressable accessibilityRole="button" testID="driver-history-toggle" onPress={() => setOpen(value => !value)} style={s.button}><Text style={s.buttonText}>{open ? "Скрыть историю" : "Показать историю"}</Text></Pressable>
    {open ? <>
      <Text style={s.note}>Все закрытые поездки этого водителя. Сумма тарифов завершённых поездок — без подтверждения оплаты и вычета расходов.</Text>
      {loading ? <Text style={s.note} testID="driver-history-loading">Загружаем историю…</Text> : null}
      {error ? <Text style={s.error} testID="driver-history-error" accessibilityRole="alert">{error}</Text> : null}
      {snapshot ? <>
        <View testID="driver-history-totals" style={s.totals}><Text style={s.summaryText}>Завершено поездок: {snapshot.completed}</Text>
          {snapshot.totals === null ? <Text style={s.note}>Сумма недоступна: у части завершённых поездок нет достоверной стоимости.</Text>
            : snapshot.totals.length ? snapshot.totals.map(money => <Text style={s.money} key={money.currency}>{formatFareMoney(money)}</Text>)
            : <Text style={s.note}>Завершённых поездок с заработком пока нет.</Text>}
        </View>
        {!snapshot.rows.length ? <View style={s.empty} testID="driver-history-empty"><Text style={s.emptyTitle}>Поездок пока нет</Text><Text style={s.note}>Завершённые и отменённые поездки появятся здесь после обновления истории.</Text></View> : null}
        {snapshot.rows.slice(0, limit).map(({ order, money }) => <View key={order.id} style={s.row} testID={`driver-history-row-${order.id}`}>
          <Text style={s.rowTitle}>{ridePickupLabel(order)} → {rideDestinationLabel(order)}</Text>
          <Text style={s.note}>{statusLabels[order.status]} · {order.seats} мест</Text>
          <Text style={s.rowAmount}>{money ? formatFareMoney(money) : "Стоимость недоступна"}{order.status === "cancelled" ? " · не входит в заработок" : ""}</Text>
          <Text style={s.note}>Заказ {order.id}</Text>
          <Text style={s.note}>Обновлено: {order.updated_at ?? order.created_at ?? "дата недоступна"}</Text>
        </View>)}
        {snapshot.rows.length > limit ? <Pressable accessibilityRole="button" style={s.button} onPress={() => setLimit(value => value + 20)}><Text style={s.buttonText}>Показать ещё</Text></Pressable> : null}
      </> : null}
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: loading }} testID="driver-history-refresh" disabled={loading} onPress={() => { void load(); }} style={[s.button, loading && s.disabled]}><Text style={s.buttonText}>{loading ? "Обновляем…" : "Обновить историю"}</Text></Pressable>
    </> : null}
  </View>;
}
// Driver V2 presentation only: amounts, server snapshots and request guards stay authoritative.
const s = StyleSheet.create({
  card: { padding: 20, marginBottom: 16, backgroundColor: onayDark.card, borderRadius: 24, borderWidth: 1, borderColor: onayDark.border, gap: 10 },
  heading: { fontSize: 20, fontWeight: "800", color: onayDark.text },
  note: { color: onayDark.muted, lineHeight: 21, fontSize: 13 },
  button: { backgroundColor: onayDark.cardRaised, borderWidth: 1, borderColor: onayDark.border, padding: 14, borderRadius: 12, minHeight: 44, justifyContent: "center" },
  buttonText: { color: onayDark.text, fontWeight: "700", textAlign: "center" },
  disabled: { opacity: 0.5 },
  totals: { backgroundColor: onayDark.cardRaised, padding: 16, borderRadius: 16, gap: 6 },
  summaryText: { color: onayDark.text, fontSize: 15, fontWeight: "700" },
  money: { color: onayDark.accent, fontSize: 22, fontWeight: "800" },
  empty: { backgroundColor: onayDark.cardRaised, borderColor: onayDark.border, borderWidth: 1, borderRadius: 16, alignItems: "center", padding: 22, gap: 8 },
  emptyTitle: { color: onayDark.text, fontSize: 16, fontWeight: "800" },
  error: { color: onayDark.danger, backgroundColor: onayDark.cardRaised, padding: 12, borderRadius: 12, lineHeight: 21 },
  row: { borderTopWidth: 1, borderColor: onayDark.border, paddingTop: 12, gap: 5 },
  rowTitle: { color: onayDark.text, fontSize: 15, fontWeight: "700" },
  rowAmount: { color: onayDark.text, fontWeight: "700" },
});
