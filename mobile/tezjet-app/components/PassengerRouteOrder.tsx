import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import * as Location from "expo-location";
import { ApiError, errorMessage, request } from "../lib/api";
import { orderedDriverStops, parseDriverRouteCatalog, type DriverDirection, type DriverRouteOption } from "../lib/driver-routes";
import { passengerRouteSelection, passengerRouteSelectionKey, passengerRouteAvailabilityPath,
  parsePassengerRouteAvailability, passengerRouteOrderBody, type PassengerRouteAvailability } from "../lib/passenger-route-orders";

type Props = { token: string; endpoint: string; busy: boolean; activeOrder: boolean; onCreated: () => Promise<void> };
const choices: DriverDirection[] = ["a_to_b", "b_to_a"];
export default function PassengerRouteOrder({ token, endpoint, busy, activeOrder, onCreated }: Props) {
  const [routes, setRoutes] = useState<DriverRouteOption[]>([]);
  const [routeId, setRouteId] = useState("");
  const [direction, setDirection] = useState<DriverDirection>("a_to_b");
  const [seats, setSeats] = useState(1);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [availability, setAvailability] = useState<{ key: string; checkedAt: number; value: PassengerRouteAvailability } | null>(null);
  const requestVersion = useRef(0);
  const route = routes.find(item => item.id === routeId);
  const selection = route ? passengerRouteSelection(route, direction, seats) : null;
  const key = selection ? passengerRouteSelectionKey(selection) : "";
  const [now, setNow] = useState(Date.now());
  const fresh = !!availability && availability.key === key && now >= availability.checkedAt && now - availability.checkedAt < 15000;
  const canOrder = fresh && availability?.value.available === true && !busy && !activeOrder && !submitting && !checking;
  const stops = route ? orderedDriverStops(route, direction) : [];

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const version = ++requestVersion.current;
    setRoutes([]); setRouteId(""); setAvailability(null); setError(""); setMessage("");
    if (!token || !endpoint) return;
    setLoading(true);
    request<unknown>("/api/orders/routes", token)
      .then(result => {
        if (version !== requestVersion.current) return;
        const items = parseDriverRouteCatalog(result);
        setRoutes(items);
        setRouteId(items[0]?.id ?? "");
      })
      .catch(cause => { if (version === requestVersion.current) setError(errorMessage(cause, "Не удалось загрузить маршруты.")); })
      .finally(() => { if (version === requestVersion.current) setLoading(false); });
    return () => { requestVersion.current += 1; };
  }, [token, endpoint]);

  useEffect(() => { setAvailability(null); setMessage(""); requestVersion.current += 1; }, [key]);
  async function check() {
    if (!selection || checking || submitting) return;
    const version = ++requestVersion.current;
    const checkingKey = passengerRouteSelectionKey(selection);
    setChecking(true); setAvailability(null); setError(""); setMessage("");
    try {
      const result = parsePassengerRouteAvailability(await request<unknown>(passengerRouteAvailabilityPath(selection), token));
      if (version !== requestVersion.current) return;
      setAvailability({ key: checkingKey, value: result, checkedAt: Date.now() });
    } catch (cause) {
      if (version === requestVersion.current) setError(errorMessage(cause, "Не удалось проверить водителей."));
    } finally { if (version === requestVersion.current) setChecking(false); }
  }
  async function submit() {
    if (!selection || !canOrder) return;
    setSubmitting(true); setMessage(""); setError("");
    try {
      // The final booking request always revalidates the route, seats and FIFO on the server.
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) throw new Error("Разреши геолокацию для проверки точки посадки.");
      const coords = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const body = passengerRouteOrderBody(selection, {
        lat: coords.coords.latitude, lng: coords.coords.longitude, timestamp: coords.timestamp, isMocked: coords.mocked === true,
      });
      await request("/api/orders/route", token, { method: "POST", body: JSON.stringify(body) });
      setAvailability(null);
      setMessage("Заказ создан. Ожидаем подтверждения водителя.");
      await onCreated();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "NO_DRIVERS") {
        setAvailability(null);
        setMessage("Подходящих водителей больше нет. Заказ не создан.");
      } else if (cause instanceof ApiError && ["ROUTE_CHANGED", "ROUTE_NOT_FOUND", "ROUTE_INACTIVE"].includes(cause.code ?? "")) {
        setAvailability(null);
        setError("Маршрут изменился. Обнови список маршрутов.");
      } else setError(errorMessage(cause, "Не удалось оформить заказ."));
    } finally { setSubmitting(false); }
  }
  const button = (title: string, onPress: () => void, disabled = false) =>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress} disabled={disabled}
      style={{ padding: 12, borderRadius: 12, backgroundColor: disabled ? "#C8D6D0" : "#0D735C", marginTop: 8 }}>
      <Text style={{ color: "#fff", fontWeight: "700", textAlign: "center" }}>{title}</Text>
    </Pressable>;
  return <View testID="configured-route-passenger" style={{ padding: 20, borderRadius: 24, backgroundColor: "#fff", marginBottom: 16 }}>
    <Text style={{ color: "#102D26", fontWeight: "800", fontSize: 21 }}>Такси по маршруту</Text>
    <Text style={{ color: "#53675E", marginVertical: 8 }}>Выбери линию и направление. Цена и свободные места проверяются сервером.</Text>
    {loading ? <ActivityIndicator /> : null}
    {!loading && routes.length === 0 ? <Text>Настроенных маршрутов пока нет.</Text> : null}
    {routes.map(item => <Pressable key={item.id} onPress={() => setRouteId(item.id)}
      accessibilityRole="button" accessibilityState={{ selected: item.id === routeId }}
      style={{ padding: 10, borderRadius: 10, borderWidth: 1, borderColor: item.id === routeId ? "#0D735C" : "#DCE5DF", marginTop: 5 }}>
      <Text>{item.name}</Text>
    </Pressable>)}
    {route ? <>
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        {choices.map(value => <Pressable key={value} onPress={() => setDirection(value)}
          accessibilityRole="button" accessibilityState={{ selected: direction === value }}
          style={{ flex: 1, padding: 10, borderWidth: 1, borderRadius: 10, borderColor: direction === value ? "#0D735C" : "#DCE5DF" }}>
          <Text style={{ textAlign: "center" }}>{value === "a_to_b" ? "A → B" : "B → A"}</Text>
        </Pressable>)}
      </View>
      <Text style={{ marginTop: 10 }}>{stops[0]?.name} → {stops[stops.length - 1]?.name}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 18, marginTop: 12 }}>
        <Text>Места: {seats}</Text>
        {button("−", () => setSeats(Math.max(1, seats - 1)), seats <= 1 || submitting)}
        {button("+", () => setSeats(Math.min(8, seats + 1)), seats >= 8 || submitting)}
      </View>
      {button(checking ? "Проверяем…" : "Проверить наличие и цену", () => { void check(); }, checking || submitting || busy)}
      {fresh && availability ? <Text style={{ marginTop: 10 }}>
        {availability.value.available ? `Подходящих водителей: ${availability.value.eligibleDriverCount}` : "Подходящих водителей сейчас нет."}
        {"\n"}Стоимость: {new Intl.NumberFormat("ru-RU").format(availability.value.priceKzt)} ₸
      </Text> : <Text style={{ marginTop: 10 }}>Для заказа нужна свежая проверка доступности.</Text>}
      {button(submitting ? "Оформляем…" : "Заказать поездку", () => { void submit(); }, !canOrder)}
    </> : null}
    {activeOrder ? <Text>Сначала заверши или отмени текущую поездку.</Text> : null}
    {message ? <Text style={{ color: "#175444", marginTop: 10 }}>{message}</Text> : null}
    {error ? <Text style={{ color: "#A42323", marginTop: 10 }}>{error}</Text> : null}
  </View>;
}
