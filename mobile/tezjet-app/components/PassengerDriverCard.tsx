import { useEffect, useRef, useState } from "react";
import { AppState, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { canReadDriverContact, createPassengerDriverClient, createPassengerDriverScope, type PassengerDriver } from "../lib/passenger-driver";

type Props = { endpoint: string; token: string; order: { id: string; status: string; driver_id?: string } };

export default function PassengerDriverCard({ endpoint, token, order }: Props) {
  const [driver, setDriver] = useState<PassengerDriver | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const scope = useRef(createPassengerDriverScope());
  const eligible = canReadDriverContact(order);
  useEffect(() => {
    setDriver(null); setError(""); setLoading(true);
    if (!eligible || !order.driver_id) { setLoading(false); return; }
    const ticket = scope.current.start();
    const timeout = setTimeout(() => {
      if (!scope.current.isCurrent(ticket)) return;
      scope.current.cancel(); setDriver(null); setLoading(false); setError("Сервер не ответил вовремя. Повтори обновление.");
    }, 15_000);
    (async () => {
      try {
        const load = createPassengerDriverClient(endpoint, token);
        const next = await load(order.id, order.driver_id!, ticket.signal);
        if (scope.current.isCurrent(ticket)) setDriver(next);
      } catch (reason) {
        if (scope.current.isCurrent(ticket)) setError(reason instanceof Error ? reason.message : "Нет связи с Onay. Повтори обновление.");
      } finally {
        clearTimeout(timeout);
        if (scope.current.isCurrent(ticket)) setLoading(false);
      }
    })();
    return () => { clearTimeout(timeout); scope.current.cancel(); };
  }, [endpoint, token, order.id, order.driver_id, order.status, eligible, retry]);

  useEffect(() => {
    const listener = AppState.addEventListener("change", state => { if (state === "active") setRetry(value => value + 1); });
    return () => listener.remove();
  }, []);

  if (!eligible) return null;
  return <View style={s.card} testID="passenger-driver-card">
    <Text style={s.heading}>Твой водитель</Text>
    {loading ? <Text style={s.text}>Получаем данные водителя…</Text> : null}
    {driver && !loading ? <><Text style={s.text} testID="passenger-driver-name">{driver.fullName || "Имя водителя не указано"}</Text>
      <Pressable accessibilityRole="link" testID="passenger-driver-phone" onPress={() => {
        void Linking.openURL(`tel:${driver.phoneNumber}`).catch(() => setError("Не удалось открыть звонок. Набери номер вручную."));
      }}><Text style={s.phone}>Позвонить: {driver.phoneNumber}</Text></Pressable>
      <Text style={s.text}>Данные автомобиля пока не указаны.</Text></> : null}
    {error ? <><Text style={s.text} testID="passenger-driver-error">{error}</Text><Pressable accessibilityRole="button" testID="passenger-driver-retry" onPress={() => setRetry(value => value + 1)}><Text style={s.phone}>Повторить получение данных</Text></Pressable></> : null}
  </View>;
}

const s = StyleSheet.create({ card: { marginTop: 12, gap: 8 }, heading: { color: "#102D26", fontSize: 16, fontWeight: "700" },
  text: { color: "#53675E", fontSize: 14, lineHeight: 21 }, phone: { color: "#0D735C", fontSize: 14, paddingVertical: 12, fontWeight: "700" } });
