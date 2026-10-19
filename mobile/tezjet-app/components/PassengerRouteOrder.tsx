import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import * as Location from "expo-location";
import { ApiError, errorMessage, request } from "../lib/api";
import { orderedDriverStops, parseDriverRouteCatalog, type DriverDirection, type DriverRouteOption } from "../lib/driver-routes";
import { createPassengerRouteRequestScope, passengerRouteSelection, passengerRouteSelectionKey, passengerRouteAvailabilityPath,
  parsePassengerRouteAvailability, passengerRouteOrderBody, passengerRouteCatalogStatus, isFreshPassengerRouteQuote, routeBookingOutcomeUncertain, syncConfirmedRouteBooking, type PassengerRouteAvailability } from "../lib/passenger-route-orders";

type Props = { token: string; endpoint: string; busy: boolean; activeOrder: boolean; onCreated: () => Promise<void> };
const choices: DriverDirection[] = ["a_to_b", "b_to_a"];
export default function PassengerRouteOrder({ token, endpoint, busy, activeOrder, onCreated }: Props) {
  const [routes, setRoutes] = useState<DriverRouteOption[]>([]);
  const [routeId, setRouteId] = useState("");
  const [direction, setDirection] = useState<DriverDirection>("a_to_b");
  const [seats, setSeats] = useState(1);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingSync, setPendingSync] = useState(false);
  const [uncertainBooking, setUncertainBooking] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [availability, setAvailability] = useState<{ key: string; checkedAt: number; value: PassengerRouteAvailability } | null>(null);
  const requestScope = useRef(createPassengerRouteRequestScope());
  const route = routes.find(item => item.id === routeId);
  const selection = route ? passengerRouteSelection(route, direction, seats) : null;
  const key = selection ? passengerRouteSelectionKey(selection) : "";
  const activeSelectionKey = useRef(key);
  activeSelectionKey.current = key;
  const [now, setNow] = useState(Date.now());
  const fresh = !!availability && availability.key === key && now >= availability.checkedAt && now - availability.checkedAt < 15000;
  const canOrder = isFreshPassengerRouteQuote(availability, key, now) && !busy && !activeOrder && !submitting && !checking && !pendingSync;
  const stops = route ? orderedDriverStops(route, direction) : [];
  const catalogStatus = passengerRouteCatalogStatus({ loading, error: catalogError, count: routes.length });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const version = requestScope.current.startCatalog();
    setRoutes([]); setRouteId(""); setAvailability(null); setCatalogError(""); setError(""); setMessage("");
    setLoading(false);
    if (!token || !endpoint) return;
    setLoading(true);
    request<unknown>("/api/orders/routes", token)
      .then(result => {
        if (!requestScope.current.isCurrentCatalog(version)) return;
        const items = parseDriverRouteCatalog(result);
        setRoutes(items);
        setRouteId(items[0]?.id ?? "");
      })
      .catch(cause => { if (requestScope.current.isCurrentCatalog(version)) setCatalogError(errorMessage(cause, "Не удалось загрузить маршруты.")); })
      .finally(() => { if (requestScope.current.isCurrentCatalog(version)) setLoading(false); });
    return () => { requestScope.current.cancelCatalog(); };
  }, [token, endpoint, catalogRetry]);

  useEffect(() => { setAvailability(null); setChecking(false); setMessage(""); requestScope.current.cancelAvailability(); }, [key]);
  async function check() {
    if (!selection || checking || submitting) return;
    const version = requestScope.current.startAvailability();
    const checkingKey = passengerRouteSelectionKey(selection);
    setChecking(true); setAvailability(null); setError(""); setMessage("");
    try {
      const result = parsePassengerRouteAvailability(await request<unknown>(passengerRouteAvailabilityPath(selection), token));
      if (!requestScope.current.isCurrentAvailability(version)) return;
      setAvailability({ key: checkingKey, value: result, checkedAt: Date.now() });
    } catch (cause) {
      if (requestScope.current.isCurrentAvailability(version)) setError(errorMessage(cause, "Не удалось проверить водителей."));
    } finally { if (requestScope.current.isCurrentAvailability(version)) setChecking(false); }
  }
  async function retrySync() {
    if (submitting || !pendingSync) return;
    setSubmitting(true); setError("");
    const synced = await syncConfirmedRouteBooking(onCreated);
    if (synced && !uncertainBooking) { setPendingSync(false); setMessage("Заказы обновлены. Проверь состояние поездки."); }
    else if (synced) setMessage("Список обновлён, но создание заказа не подтверждено. Не оформляй повторный заказ, пока не проверишь его статус с поддержкой.");
    else setError("Не удалось обновить заказы. Повтори проверку; не создавай ещё один заказ.");
    setSubmitting(false);
  }
  async function submit() {
    if (!selection || !canOrder) return;
    setSubmitting(true); setMessage(""); setError("");
    try {
      // The final booking request always revalidates the route, seats and FIFO on the server.
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) throw new Error("Разреши геолокацию для проверки точки посадки.");
      const coords = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (activeSelectionKey.current !== passengerRouteSelectionKey(selection)) {
        throw new Error("Маршрут или количество мест изменились. Проверь наличие заново.");
      }
      if (!isFreshPassengerRouteQuote(availability, activeSelectionKey.current, Date.now())) {
        setAvailability(null);
        throw new Error("Пока определяли местоположение, проверка цены и водителей устарела. Проверь наличие ещё раз.");
      }
      const body = passengerRouteOrderBody(selection, {
        lat: coords.coords.latitude, lng: coords.coords.longitude, timestamp: coords.timestamp, isMocked: coords.mocked === true,
      });
      await request("/api/orders/route", token, { method: "POST", body: JSON.stringify(body) });
      setAvailability(null);
      setPendingSync(true);
      const synced = await syncConfirmedRouteBooking(onCreated);
      if (synced) {
        setPendingSync(false);
        setMessage("Заказ создан. Ожидаем подтверждения водителя.");
      } else {
        setMessage("Заказ создан, но список поездок не обновился. Проверь статус; повторно заказывать не нужно.");
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "NO_DRIVERS") {
        setAvailability(null);
        setMessage("Подходящих водителей больше нет. Заказ не создан.");
      } else if (cause instanceof ApiError && ["ROUTE_CHANGED", "ROUTE_NOT_FOUND", "ROUTE_INACTIVE"].includes(cause.code ?? "")) {
        setAvailability(null);
        setError("Маршрут изменился. Обнови список маршрутов.");
      } else if (cause instanceof ApiError && routeBookingOutcomeUncertain(cause)) {
        setAvailability(null);
        setPendingSync(true);
        setUncertainBooking(true);
        setMessage("Не удалось узнать, принят ли заказ сервером. Сначала обнови список поездок; повторный заказ пока заблокирован.");
      } else setError(errorMessage(cause, "Не удалось оформить заказ."));
    } finally { setSubmitting(false); }
  }
  const button = (title: string, onPress: () => void, disabled = false, primary = false, testID?: string) =>
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled }}
      onPress={onPress} disabled={disabled}
      style={[v.button, primary ? v.buttonPrimary : v.buttonSecondary, disabled && v.disabled]}>
      <Text style={[v.buttonLabel, primary ? v.primaryText : v.secondaryText]}>{title}</Text>
    </Pressable>;

  return <View testID="configured-route-passenger" style={v.card}>
    <Text style={v.eyebrow}>ONAY · МАРШРУТНОЕ ТАКСИ</Text>
    <Text style={v.title}>Куда едем?</Text>
    <Text style={v.subtitle}>Выберите линию и количество мест. Доступность водителей и цену проверит сервер.</Text>
    {loading ? <ActivityIndicator color="#33DB9C" style={v.loader}/> : null}
    {catalogStatus === "empty" && token && endpoint ? <Text style={v.hint}>Настроенных маршрутов пока нет.</Text> : null}
    {catalogStatus === "error" ? <View><Text style={v.error}>Не удалось загрузить маршруты: {catalogError}</Text>
      {button("Повторить загрузку маршрутов", () => setCatalogRetry(value => value + 1), submitting || busy, false, "route-catalog-retry")}</View> : null}
    {routes.map(item => <Pressable key={item.id} onPress={() => setRouteId(item.id)} disabled={submitting}
      accessibilityRole="button" accessibilityState={{ selected: item.id === routeId }}
      style={[v.route, item.id === routeId && v.routeActive]}>
      <View style={[v.indicator, item.id === routeId && v.indicatorActive]}/>
      <View style={v.routeContent}>
        <Text style={v.routeName}>{item.name}</Text>
        <Text style={v.routeInfo}>Выбрать маршрут</Text>
      </View>
      <Text style={v.chevron}>›</Text>
    </Pressable>)}
    {route ? <>
      <Text style={v.sectionHeading}>НАПРАВЛЕНИЕ</Text>
      <View style={v.directions}>
        {choices.map(value => <Pressable key={value} onPress={() => setDirection(value)} disabled={submitting}
          accessibilityRole="button" accessibilityState={{ selected: direction === value }}
          style={[v.direction, direction === value && v.directionActive]}>
          <Text style={[v.directionText, direction === value && v.directionTextActive]}>
            {value === "a_to_b" ? "A → B" : "B → A"}
          </Text>
        </Pressable>)}
      </View>
      <View style={v.trip}>
        <View style={v.tripDots}><View style={v.originDot}/><View style={v.tripLine}/><View style={v.destinationDot}/></View>
        <View style={v.tripLabels}>
          <Text style={v.tripName}>{stops[0]?.name ?? "Начало маршрута"}</Text>
          <Text style={v.tripCaption}>Откуда</Text>
          <Text style={[v.tripName, v.destinationName]}>{stops[stops.length - 1]?.name ?? "Конец маршрута"}</Text>
          <Text style={v.tripCaption}>Куда</Text>
        </View>
      </View>
      <View style={v.seats}>
        <View><Text style={v.seatsTitle}>Пассажиры</Text><Text style={v.seatsDescription}>Места: от 1 до 8</Text></View>
        <View style={v.stepper}>
          <Pressable testID="route-seats-minus" accessibilityRole="button" accessibilityLabel="Уменьшить количество мест"
            disabled={seats <= 1 || submitting} onPress={() => setSeats(Math.max(1, seats - 1))}
            style={[v.step, (seats <= 1 || submitting) && v.disabled]}><Text style={v.stepText}>−</Text></Pressable>
          <Text style={v.count}>{seats}</Text>
          <Pressable testID="route-seats-plus" accessibilityRole="button" accessibilityLabel="Увеличить количество мест"
            disabled={seats >= 8 || submitting} onPress={() => setSeats(Math.min(8, seats + 1))}
            style={[v.step, (seats >= 8 || submitting) && v.disabled]}><Text style={v.stepText}>+</Text></Pressable>
        </View>
      </View>
      {button(checking ? "Проверяем…" : "Проверить цену и водителей",
        () => { void check(); }, checking || submitting || busy, false, "route-check-availability")}
      <View style={v.priceCard}>
        <Text style={v.sectionHeading}>ПОДТВЕРЖДЁННАЯ СТОИМОСТЬ</Text>
        <Text style={v.price}>{fresh && availability ? new Intl.NumberFormat("ru-RU").format(availability.value.priceKzt) + " ₸" : "—"}</Text>
        <Text style={[v.availability, fresh && availability?.value.available && v.availabilityPositive]}>
          {fresh && availability
            ? availability.value.available
              ? "Свободных водителей: " + availability.value.eligibleDriverCount
              : "Свободных водителей сейчас нет"
            : "Обновите наличие и цену перед заказом"}
        </Text>
      </View>
      {pendingSync ? button(submitting ? "Обновляем…" : "Проверить список поездок",
        () => { void retrySync(); }, submitting || busy, false, "route-refresh-after-submit") : null}
      {button(submitting ? "Оформляем…" : "Заказать поездку",
        () => { void submit(); }, !canOrder, true, "route-book-trip")}
    </> : null}
    {activeOrder ? <Text style={v.notice}>Сначала заверши или отмени текущую поездку.</Text> : null}
    {message ? <Text style={v.notice}>{message}</Text> : null}
    {error ? <Text style={v.error}>{error}</Text> : null}
  </View>;
}

const v = StyleSheet.create({
  card:{padding:20,borderRadius:24,backgroundColor:"#0B271A",marginBottom:16,borderWidth:1,borderColor:"#1F4B32"},
  eyebrow:{color:"#31DE9C",fontSize:10,fontWeight:"800",letterSpacing:1.5,marginBottom:10},
  title:{color:"#F2FFF6",fontSize:30,fontWeight:"900"},
  subtitle:{color:"#ADCCB9",fontSize:13,lineHeight:20,marginTop:6,marginBottom:18},
  loader:{marginVertical:12},hint:{color:"#C6DECE",marginBottom:10,fontSize:13},
  route:{flexDirection:"row",alignItems:"center",backgroundColor:"#153624",borderWidth:1,borderColor:"#315540",borderRadius:16,padding:13,marginBottom:8,gap:10},
  routeActive:{backgroundColor:"#195338",borderColor:"#35D99B"},
  indicator:{height:12,width:12,borderRadius:6,borderWidth:2,borderColor:"#83AA95"},
  indicatorActive:{backgroundColor:"#35DF9D",borderColor:"#35DF9D"},
  routeContent:{flex:1},routeName:{color:"#EFFFF1",fontSize:15,fontWeight:"800"},
  routeInfo:{color:"#97B8A2",fontSize:11,marginTop:3},chevron:{color:"#36DD9B",fontSize:26},
  sectionHeading:{color:"#A2C4AD",fontSize:10,fontWeight:"800",letterSpacing:1.2,marginTop:14,marginBottom:10},
  directions:{flexDirection:"row",gap:9},
  direction:{flex:1,alignItems:"center",paddingVertical:12,borderWidth:1,borderRadius:13,backgroundColor:"#153624",borderColor:"#315540"},
  directionActive:{backgroundColor:"#236C49",borderColor:"#33DC9B"},
  directionText:{color:"#ACC9B7",fontSize:15,fontWeight:"700"},directionTextActive:{color:"#F5FFF7"},
  trip:{backgroundColor:"#153624",borderRadius:16,marginTop:16,padding:15,flexDirection:"row",gap:14},
  tripDots:{alignItems:"center",width:15,paddingTop:4},
  originDot:{width:11,height:11,borderRadius:6,backgroundColor:"#37DAA1"},
  tripLine:{height:40,width:2,backgroundColor:"#3F7754"},
  destinationDot:{width:11,height:11,borderRadius:6,borderWidth:2,borderColor:"#37DAA1"},
  tripLabels:{flex:1},tripName:{color:"#F0FFF5",fontWeight:"700",fontSize:14},
  destinationName:{marginTop:16},tripCaption:{color:"#8CAD98",fontSize:11,marginTop:2},
  seats:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginTop:18},
  seatsTitle:{color:"#F3FFF7",fontSize:14,fontWeight:"800"},seatsDescription:{color:"#91B29D",fontSize:11,marginTop:3},
  stepper:{flexDirection:"row",gap:12,alignItems:"center"},
  step:{height:34,width:34,alignItems:"center",justifyContent:"center",borderRadius:17,backgroundColor:"#22583A"},
  stepText:{color:"#45E7A7",fontSize:22,fontWeight:"700"},
  count:{color:"#F5FFF7",fontWeight:"800",fontSize:17,minWidth:18,textAlign:"center"},
  button:{minHeight:49,borderRadius:14,padding:13,alignItems:"center",justifyContent:"center",marginTop:12},
  buttonPrimary:{backgroundColor:"#31DA9C"},buttonSecondary:{backgroundColor:"#1B4C32",borderWidth:1,borderColor:"#36A978"},
  buttonLabel:{fontSize:14,fontWeight:"800"},
  primaryText:{color:"#062718"},secondaryText:{color:"#E8FFF0"},disabled:{opacity:0.43},
  priceCard:{marginTop:14,padding:14,borderRadius:16,backgroundColor:"#153624"},
  price:{fontSize:26,color:"#F2FFF7",fontWeight:"900"},
  availability:{fontSize:12,color:"#B3CDBA",marginTop:6,lineHeight:19},
  availabilityPositive:{color:"#42ECA9"},
  notice:{fontSize:12,color:"#C8FAE0",backgroundColor:"#19543A",padding:11,borderRadius:12,marginTop:12},
  error:{fontSize:12,color:"#FFD8D8",backgroundColor:"#562A2A",padding:11,borderRadius:12,marginTop:12},
});
