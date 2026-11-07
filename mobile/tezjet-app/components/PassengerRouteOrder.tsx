import OnayIcon from "./OnayIcon";
import OnayScreenFrame, { onayPalette } from "./OnayScreenFrame";
import { useEffect, useRef, useState } from "react";
import { formatFareMoney } from "../lib/fare-money";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API, ApiError, errorMessage, request } from "../lib/api";
import { isClosed, type RideOrder } from "../lib/orders";
import type { PassengerBookingGate } from "../lib/passenger-booking-gate";
import { orderedDriverStops, parseDriverRouteCatalog, type DriverDirection, type DriverRouteOption } from "../lib/driver-routes";
import { createPassengerRouteRequestScope, passengerRouteSelection, passengerRouteSelectionKey, passengerRouteAvailabilityPath,
  parsePassengerRouteAvailability, passengerRouteOrderBody, passengerRouteCatalogStatus, routeBookingRecoveryKey, routeBookingRequestKey, resolveRouteBookingRequest, readRouteBookingRecovery, saveRouteBookingRecovery, clearRouteBookingRecovery, clearClosedRouteBookingRecovery, discardUnsentRouteBooking, confirmedRouteBookingPresent, isFreshPassengerRouteQuote, routeBookingDefinitivelyRejected, routeBookingOutcomeUncertain, syncConfirmedRouteBooking, type PassengerRouteAvailability, type PassengerRouteSegment } from "../lib/passenger-route-orders";

export type PassengerDirectionIntent = { direction: DriverDirection; revision: number };
type Props = { token: string; endpoint: string; userId: string; busy: boolean; activeOrder: boolean; directionIntent?: PassengerDirectionIntent | null; bookingGate: PassengerBookingGate; onCreated: () => Promise<void>; onBooked?: () => void; theme?: "light" | "dark" };
const choices: DriverDirection[] = ["a_to_b", "b_to_a"];
export default function PassengerRouteOrder({ token, endpoint, userId, busy, activeOrder, directionIntent, bookingGate, onCreated, onBooked, theme = "dark" }: Props) {
  const [routePickerOpen, setRoutePickerOpen] = useState(false);
  const [routes, setRoutes] = useState<DriverRouteOption[]>([]);
  const [routeId, setRouteId] = useState("");
  const [direction, setDirection] = useState<DriverDirection>("a_to_b");
  const [seats, setSeats] = useState(1);
  const [segmentDraft, setSegmentDraft] = useState<{ context: string; value: PassengerRouteSegment } | null>(null);
  const [stopPicker, setStopPicker] = useState<"pickup" | "destination" | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingSync, setPendingSync] = useState(false);
  const [uncertainBooking, setUncertainBooking] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const recoveryKey = endpoint && userId ? routeBookingRecoveryKey(endpoint, userId) : "";
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [availability, setAvailability] = useState<{ key: string; checkedAt: number; value: PassengerRouteAvailability } | null>(null);
  const requestScope = useRef(createPassengerRouteRequestScope());
  const appliedDirectionIntent = useRef(0);
  const recoveryRevision = bookingGate.recoveryRevision();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const route = routes.find(item => item.id === routeId);
  const stops = route ? orderedDriverStops(route, direction) : [];
  // A route/direction/catalog change gets fresh endpoints immediately, before
  // effects run; IDs from another segment must never enter the next request.
  const segmentContext = route ? JSON.stringify([route.id, route.updatedAt, direction]) : "";
  const segment = route ? segmentDraft?.context === segmentContext ? segmentDraft.value : {
    pickupStopId: stops[0]!.id, destinationStopId: stops[stops.length - 1]!.id,
  } : null;
  const pickupIndex = stops.findIndex(stop => stop.id === segment?.pickupStopId);
  const destinationIndex = stops.findIndex(stop => stop.id === segment?.destinationStopId);
  const selection = route && segment ? passengerRouteSelection(route, direction, seats, segment) : null;
  const key = selection ? passengerRouteSelectionKey(selection) : "";
  const activeSelectionKey = useRef(key);
  activeSelectionKey.current = key;
  const [now, setNow] = useState(Date.now());
  const fresh = !!availability && availability.key === key && now >= availability.checkedAt && now - availability.checkedAt < 15000;
  const canOrder = isFreshPassengerRouteQuote(availability, key, now) && !busy && !activeOrder && !submitting && !checking && !pendingSync && recoveryReady && !recoveryError && bookingGate.canSubmit();
  const catalogStatus = passengerRouteCatalogStatus({ loading, error: catalogError, count: routes.length });

  const inScope = () => mounted.current && API === endpoint;
  async function scopedRequest<T>(path: string, init?: RequestInit): Promise<T> {
    if (!inScope()) throw new Error("Подключение изменилось. Вернись к исходному серверу для проверки заказа.");
    const result = await request<T>(path, token, init);
    if (!inScope()) throw new Error("Подключение изменилось. Результат заказа нужно проверить на исходном сервере.");
    return result;
  }

  useEffect(() => {
    let mounted = true;
    setRecoveryReady(false);
    bookingGate.setRecovery(false, true);
    if (!recoveryKey) {
      setRecoveryError("Сначала подключи сервер и войди в аккаунт. Создание заказа заблокировано.");
      return;
    }
    setRecoveryError("");
    readRouteBookingRecovery(AsyncStorage, recoveryKey)
      .then(state => {
        if (!mounted || recoveryRevision !== bookingGate.recoveryRevision()) return;
        bookingGate.setRecovery(true, state !== null);
        setPendingSync(state !== null);
        setUncertainBooking(state !== null && state.status !== "confirmed");
        setMessage(state?.status === "confirmed" ? "Ранее заказ был создан. Проверь список поездок перед новым заказом."
          : state ? "Предыдущий заказ мог быть создан. Проверь его статус; повторное оформление заблокировано." : "");
        setRecoveryReady(true);
      })
      .catch(() => { if (mounted && recoveryRevision === bookingGate.recoveryRevision()) setRecoveryError("Не удалось проверить предыдущие заказы на устройстве. Создание нового заказа заблокировано."); });
    return () => { mounted = false; };
  }, [recoveryKey, bookingGate, recoveryRevision]);
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

  useEffect(() => { setAvailability(null); setChecking(false); setMessage(""); setStopPicker(null); requestScope.current.cancelAvailability(); }, [key]);

  useEffect(() => {
    if (!directionIntent || directionIntent.revision <= appliedDirectionIntent.current || submitting || busy) return;
    // Never carry a quote or stop segment across a change in direction.
    appliedDirectionIntent.current = directionIntent.revision;
    requestScope.current.cancelAvailability();
    setChecking(false);
    setAvailability(null);
    setStopPicker(null);
    setSegmentDraft(null);
    setDirection(directionIntent.direction);
  }, [directionIntent?.revision, submitting, busy]);

  function chooseStop(field: "pickup" | "destination", stopId: string) {
    if (!route || !segment || submitting) return;
    const next = { ...segment, ...(field === "pickup" ? { pickupStopId: stopId } : { destinationStopId: stopId }) };
    passengerRouteSelection(route, direction, seats, next);
    setSegmentDraft({ context: segmentContext, value: next });
    setStopPicker(null);
  }
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
    if (submitting || !pendingSync || !recoveryReady || !bookingGate.tryStart("recovery")) return;
    setSubmitting(true); setError("");
    try {
      let record = await readRouteBookingRecovery(AsyncStorage, recoveryKey);
      if (!inScope()) return;
      if (!record) throw new Error("Сведения о предыдущем заказе не найдены на устройстве. Новый заказ заблокирован до проверки.");
      let closedRequestKey: string | null = null;
      if (record.status !== "confirmed" && record.requestKey) {
        const resolution = await resolveRouteBookingRequest(record,
          path => scopedRequest<unknown>(path),
          path => scopedRequest<unknown>(path, { method: "POST", body: JSON.stringify({}) }));
        if (!inScope()) return;
        if (resolution.state === "created") {
          record = resolution.record;
          await saveRouteBookingRecovery(AsyncStorage, recoveryKey, record);
          if (!inScope()) return;
          setUncertainBooking(false);
        } else closedRequestKey = resolution.requestKey;
      }
      const synced = await syncConfirmedRouteBooking(onCreated);
      if (!inScope()) return;
      let exactConfirmed = false;
      if (synced && (record.status === "confirmed" || closedRequestKey !== null)) {
        const bookingReadRevision = bookingGate.beginOrdersRead();
        const response = await scopedRequest<{orders: RideOrder[]}>("/api/orders");
        exactConfirmed = Array.isArray(response.orders) &&
          (closedRequestKey !== null || confirmedRouteBookingPresent(record, response.orders));
        // The parent may already have an older GET in flight. Admission must
        // also use this authoritative snapshot before clearing the receipt.
        if (exactConfirmed) exactConfirmed = bookingGate.applyOrdersSnapshot(bookingReadRevision, response.orders.some(order => !isClosed(order)));
      }
      if (synced && exactConfirmed) {
        if (closedRequestKey !== null) {
          const cleared = await clearClosedRouteBookingRecovery(AsyncStorage, recoveryKey, closedRequestKey, inScope);
          if (!inScope()) return;
          if (!cleared) {
            bookingGate.recoveryChanged();
            throw new Error("Сведения о предыдущем заказе изменились. Проверь его статус ещё раз.");
          }
          setAvailability(null);
        } else await clearRouteBookingRecovery(AsyncStorage, recoveryKey);
        if (!inScope()) return;
        bookingGate.setRecovery(true, false);
        setPendingSync(false);
        setUncertainBooking(false);
        setMessage(closedRequestKey !== null
          ? "Сервер подтвердил: заказ не был создан. Можно проверить водителей снова."
          : "Заказы обновлены. Проверь состояние поездки.");
        if (closedRequestKey === null) onBooked?.();
      } else if (synced) setMessage("Проверка завершена, но конкретный заказ не подтверждён. Повторная отправка заблокирована; обратись в поддержку.");
      else setError("Не удалось обновить заказы. Повтори проверку; не создавай ещё один заказ.");
    } catch (cause) {
      if (mounted.current) setError(cause instanceof ApiError && cause.status === 404
        ? "Заказ пока не найден. Предыдущая отправка ещё могла обрабатываться. Повтори проверку статуса; новый заказ заблокирован."
        : errorMessage(cause, "Не удалось проверить заказ. Повтори проверку статуса."));
    } finally { bookingGate.finish("recovery"); if (mounted.current) setSubmitting(false); }
  }
  async function submit() {
    if (!selection || !canOrder || !bookingGate.tryStart("configured")) return;
    setSubmitting(true); setMessage(""); setError("");
    let postStarted = false;
    try {
      const minted = await scopedRequest<{request_key: string}>("/api/orders/route/request-key");
      const requestKey = routeBookingRequestKey(minted?.request_key);
      // The final booking request always revalidates the route, seats and FIFO on the server.
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) throw new Error("Разреши геолокацию для проверки точки посадки.");
      const coords = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if (!inScope()) return;
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
      // Persist BEFORE the first network write; if storage fails, do not create a booking.
      await saveRouteBookingRecovery(AsyncStorage, recoveryKey, { status: "in_flight", orderId: null, requestKey });
      if (!inScope()) {
        await discardUnsentRouteBooking(AsyncStorage, recoveryKey, requestKey);
        return;
      }
      bookingGate.setRecovery(true, true);
      setPendingSync(true);
      setUncertainBooking(true);
      postStarted = true;
      const created = await scopedRequest<{ order: { id: string } }>("/api/orders/route", {
        method: "POST", headers: { "Idempotency-Key": requestKey }, body: JSON.stringify(body),
      });
      bookingGate.setActiveOrder(true);
      if (!created?.order?.id) throw new Error("Сервер не вернул идентификатор созданного заказа.");
      await saveRouteBookingRecovery(AsyncStorage, recoveryKey, { status: "confirmed", orderId: created.order.id, requestKey });
      if (!inScope()) return;
      setUncertainBooking(false);
      setAvailability(null);
      setPendingSync(true);
      const synced = await syncConfirmedRouteBooking(onCreated);
      if (synced) {
        // Do not clear the persisted receipt here: a refresh might have returned
        // successfully without containing the just-created order.
        // The explicit reconciliation button verifies the exact order ID.
        setMessage("Заказ создан. Ожидаем подтверждения водителя.");
        if (inScope()) onBooked?.();
      } else {
        setMessage("Заказ создан, но список поездок не обновился. Проверь статус; повторно заказывать не нужно.");
      }
    } catch (cause) {
      const rejected = postStarted && cause instanceof ApiError && routeBookingDefinitivelyRejected(cause);
      if (rejected) {
        try { await clearRouteBookingRecovery(AsyncStorage, recoveryKey); bookingGate.setRecovery(true, false); setPendingSync(false); setUncertainBooking(false); }
        catch { setRecoveryError("Не удалось снять блокировку заказа. Повторное оформление запрещено до проверки."); }
      }
      if (cause instanceof ApiError && cause.code === "NO_DRIVERS") {
        setAvailability(null);
        setMessage("Подходящих водителей больше нет. Заказ не создан.");
      } else if (cause instanceof ApiError && ["ROUTE_CHANGED", "ROUTE_NOT_FOUND", "ROUTE_INACTIVE"].includes(cause.code ?? "")) {
        setAvailability(null);
        setError("Маршрут изменился. Обнови список маршрутов.");
      } else if (postStarted && cause instanceof ApiError && routeBookingOutcomeUncertain(cause)) {
        setAvailability(null);
        setPendingSync(true);
        setUncertainBooking(true);
        setMessage("Не удалось узнать, принят ли заказ сервером. Сначала обнови список поездок; повторный заказ пока заблокирован.");
      } else if (postStarted && !rejected) {
        setPendingSync(true);
        setUncertainBooking(true);
        setError("Не удалось подтвердить результат предыдущей отправки. Проверь список поездок; повторное оформление заблокировано.");
      } else setError(errorMessage(cause, "Не удалось оформить заказ."));
    } finally { bookingGate.finish("configured"); if (mounted.current) setSubmitting(false); }
  }
  const themeStyles = theme === "light" ? { ...v, ...vLight } : v;
  const button = (title: string, onPress: () => void, disabled = false, primary = false, testID?: string) =>
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled }}
      onPress={onPress} disabled={disabled}
      style={[themeStyles.button, primary ? themeStyles.buttonPrimary : themeStyles.buttonSecondary, disabled && themeStyles.disabled]}>
      <Text style={[themeStyles.buttonLabel, primary ? themeStyles.primaryText : themeStyles.secondaryText]}>{title}</Text>
    </Pressable>;

  return <View testID="configured-route-passenger" style={themeStyles.card}>
    <Text style={[themeStyles.subtitle, { fontSize: 15, lineHeight: 22 }]}>Покажем водителей, которые едут по выбранному маршруту. Стоимость и свободные места подтвердит сервер.</Text>
    {loading ? <ActivityIndicator color="#5bd62f" style={themeStyles.loader}/> : null}
    {catalogStatus === "empty" && token && endpoint ? <Text style={themeStyles.hint}>Настроенных маршрутов пока нет.</Text> : null}
    {catalogStatus === "error" ? <View><Text style={themeStyles.error}>Не удалось загрузить маршруты: {catalogError}</Text>
      {button("Повторить загрузку маршрутов", () => setCatalogRetry(value => value + 1), submitting || busy, false, "route-catalog-retry")}</View> : null}
    <Modal visible={routePickerOpen} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setRoutePickerOpen(false)}>
      <OnayScreenFrame title="Маршрут и направление" theme={theme} onBack={() => setRoutePickerOpen(false)} testID="onay-booking-route-picker" footer={<Pressable accessibilityRole="button" testID="onay-booking-route-done" onPress={() => setRoutePickerOpen(false)} style={[themeStyles.button, themeStyles.buttonPrimary]}><Text style={themeStyles.primaryText}>Выбрать маршрут</Text></Pressable>}>
    {routes.map(item => <Pressable key={item.id} testID={"passenger-route-" + item.id}
      onPress={() => { if (item.id !== routeId) { setSegmentDraft(null); setRouteId(item.id); } }} disabled={submitting}
      accessibilityRole="button" accessibilityState={{ selected: item.id === routeId }}
      style={[themeStyles.route, item.id === routeId && themeStyles.routeActive]}>
      <View style={[themeStyles.indicator, item.id === routeId && themeStyles.indicatorActive]}/>
      <View style={themeStyles.routeContent}>
        <Text style={themeStyles.routeName}>{item.name}</Text>
        <Text style={themeStyles.routeInfo}>Выбрать маршрут</Text>
      </View>
      <Text style={themeStyles.chevron}>›</Text>
    </Pressable>)}
      <Text style={themeStyles.sectionHeading}>НАПРАВЛЕНИЕ</Text>
      <View style={themeStyles.directions}>
        {choices.map(value => <Pressable key={value} testID={"passenger-direction-" + value}
          onPress={() => { if (value !== direction) { setSegmentDraft(null); setDirection(value); } }} disabled={submitting}
          accessibilityRole="button" accessibilityState={{ selected: direction === value }}
          style={[themeStyles.direction, direction === value && themeStyles.directionActive]}>
          <Text style={[themeStyles.directionText, direction === value && themeStyles.directionTextActive]}>
            {value === "a_to_b" ? "A → B" : "B → A"}
          </Text>
        </Pressable>)}
      </View>
      </OnayScreenFrame>
    </Modal>
    {route ? <>
      <Pressable testID="onay-booking-route-open" accessibilityRole="button" accessibilityLabel="Изменить маршрут и направление" onPress={() => setRoutePickerOpen(true)} disabled={submitting} style={[themeStyles.route, { marginBottom: 12 }]}><View style={themeStyles.routeContent}><Text style={themeStyles.routeInfo}>Маршрут · {direction === "a_to_b" ? "A → B" : "B → A"}</Text><Text style={themeStyles.routeName}>{route.name}</Text></View><OnayIcon name="chev" color={onayPalette(theme).muted}/></Pressable>
      <View style={[themeStyles.trip, { backgroundColor: "transparent", padding: 0, marginTop: 0, flexDirection: "column", gap: 12 }]}>
        <Pressable testID="passenger-pickup-open" accessibilityRole="button" accessibilityState={{ disabled: submitting }} accessibilityLabel={"Место посадки: " + stops[pickupIndex]?.name} disabled={submitting} onPress={() => setStopPicker(stopPicker === "pickup" ? null : "pickup")} style={[themeStyles.stopField, { backgroundColor: onayPalette(theme).card, borderRadius: 20, padding: 16, flexDirection: "row", alignItems: "center", gap: 14 }]}>
          <OnayIcon name="pin" color={onayPalette(theme).accent}/><View style={{ flex: 1 }}><Text style={[themeStyles.tripCaption, { fontSize: 13 }]}>Откуда</Text><Text style={[themeStyles.tripName, { fontSize: 16, marginTop: 3 }]}>{stops[pickupIndex]?.name ?? "Выберите посадку"}</Text></View><OnayIcon name="chev" color={onayPalette(theme).muted}/>
        </Pressable>
        <Pressable testID="passenger-destination-open" accessibilityRole="button" accessibilityState={{ disabled: submitting }} accessibilityLabel={"Назначение: " + stops[destinationIndex]?.name} disabled={submitting} onPress={() => setStopPicker(stopPicker === "destination" ? null : "destination")} style={[themeStyles.stopField, { backgroundColor: onayPalette(theme).card, borderRadius: 20, padding: 16, flexDirection: "row", alignItems: "center", gap: 14 }]}>
          <OnayIcon name="city" color={onayPalette(theme).accent}/><View style={{ flex: 1 }}><Text style={[themeStyles.tripCaption, { fontSize: 13 }]}>Куда</Text><Text style={[themeStyles.tripName, { fontSize: 16, marginTop: 3 }]}>{stops[destinationIndex]?.name ?? "Выберите назначение"}</Text></View><OnayIcon name="chev" color={onayPalette(theme).muted}/>
        </Pressable>
      </View>
      {stopPicker ? <View testID="passenger-stop-picker" accessibilityRole="radiogroup" style={themeStyles.stopPicker}>
        <Text style={themeStyles.sectionHeading}>{stopPicker === "pickup" ? "ГДЕ САДИТЕСЬ?" : "КУДА ЕДЕТЕ?"}</Text>
        {stops.map((stop, index) => {
          const disabled = submitting || (stopPicker === "pickup" ? index >= destinationIndex : index <= pickupIndex);
          const selected = stop.id === (stopPicker === "pickup" ? segment?.pickupStopId : segment?.destinationStopId);
          return <Pressable key={stop.id} testID={"passenger-" + stopPicker + "-" + stop.id}
            accessibilityRole="radio" accessibilityLabel={stop.name} accessibilityState={{ checked: selected, disabled }} aria-checked={selected}
            disabled={disabled} onPress={() => chooseStop(stopPicker, stop.id)}
            style={[themeStyles.stopOption, selected && themeStyles.stopOptionSelected, disabled && themeStyles.disabled]}>
            <Text style={themeStyles.stopOptionName}>{stop.name}{selected ? " ✓" : ""}</Text>
          </Pressable>;
        })}
        <Text style={themeStyles.tripCaption}>Посадка должна быть раньше назначения по выбранному направлению.</Text>
      </View> : null}
      <View style={[themeStyles.seats, { backgroundColor: onayPalette(theme).card, borderRadius: 20, padding: 16, flexDirection: "column", alignItems: "stretch", gap: 12 }]}>
        <View><Text style={themeStyles.seatsTitle}>Пассажиры</Text><Text style={themeStyles.seatsDescription}>Места: от 1 до 8</Text></View>
        <View style={[themeStyles.stepper, { justifyContent: "space-between" }]}>
          <Pressable testID="route-seats-minus" accessibilityRole="button" accessibilityLabel="Уменьшить количество мест"
            disabled={seats <= 1 || submitting} onPress={() => setSeats(Math.max(1, seats - 1))}
            style={[themeStyles.step, { width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: onayPalette(theme).border }, (seats <= 1 || submitting) && themeStyles.disabled]}><Text style={themeStyles.stepText}>−</Text></Pressable>
          <Text style={themeStyles.count}>{seats}</Text>
          <Pressable testID="route-seats-plus" accessibilityRole="button" accessibilityLabel="Увеличить количество мест"
            disabled={seats >= 8 || submitting} onPress={() => setSeats(Math.min(8, seats + 1))}
            style={[themeStyles.step, { width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: onayPalette(theme).border }, (seats >= 8 || submitting) && themeStyles.disabled]}><Text style={themeStyles.stepText}>+</Text></Pressable>
        </View>
      </View>
      <Text style={[themeStyles.seatsTitle, { marginTop: 20 }]}>Когда</Text><View style={{ alignSelf: "flex-start", marginTop: 10, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: onayPalette(theme).accent }}><Text style={{ color: onayPalette(theme).accent, fontWeight: "700" }}>Сейчас</Text></View>
      {button(checking ? "Проверяем…" : "Найти водителей",
        () => { void check(); }, checking || submitting || busy, true, "route-check-availability")}
      {availability ? <View style={themeStyles.priceCard}>
        <Text style={themeStyles.sectionHeading}>ПОДТВЕРЖДЁННАЯ СТОИМОСТЬ</Text>
        <Text style={themeStyles.price}>{fresh && availability ? formatFareMoney({ total: availability.value.price, currency: availability.value.currency }) : "—"}</Text>
        <Text style={[themeStyles.availability, fresh && availability?.value.available && themeStyles.availabilityPositive]}>
          {fresh && availability
            ? availability.value.available
              ? "Свободных водителей: " + availability.value.eligibleDriverCount
              : "Свободных водителей сейчас нет"
            : "Обновите наличие и цену перед заказом"}
        </Text>
      </View> : null}
      {button(submitting ? "Оформляем…" : "Заказать поездку",
        () => { void submit(); }, !canOrder, true, "route-book-trip")}
    </> : null}
    {pendingSync ? button(submitting ? "Проверяем…" : "Проверить статус заказа",
      () => { void retrySync(); }, submitting || busy, false, "route-refresh-after-submit") : null}
    {activeOrder ? <Text style={themeStyles.notice}>Сначала заверши или отмени текущую поездку.</Text> : null}
    {recoveryError ? <Text style={themeStyles.error}>{recoveryError}</Text> : null}
    {message ? <Text style={themeStyles.notice}>{message}</Text> : null}
    {error ? <Text style={themeStyles.error}>{error}</Text> : null}
  </View>;
}

const v = StyleSheet.create({
  card:{padding:0,borderRadius:0,backgroundColor:"#0a1d15",marginBottom:16},
  eyebrow:{color:"#5bd62f",fontSize:10,fontWeight:"800",letterSpacing:1.5,marginBottom:10},
  title:{color:"#f2faf6",fontSize:20,fontWeight:"700"},
  subtitle:{color:"#9bb3a6",fontSize:13,lineHeight:20,marginTop:6,marginBottom:18},
  loader:{marginVertical:12},hint:{color:"#9bb3a6",marginBottom:10,fontSize:13},
  route:{flexDirection:"row",alignItems:"center",backgroundColor:"#12291f",borderWidth:1,borderColor:"#1f3d2f",borderRadius:16,padding:13,marginBottom:8,gap:10},
  routeActive:{backgroundColor:"#17332a",borderColor:"#5bd62f"},
  indicator:{height:12,width:12,borderRadius:6,borderWidth:2,borderColor:"#9bb3a6"},
  indicatorActive:{backgroundColor:"#5bd62f",borderColor:"#5bd62f"},
  routeContent:{flex:1},routeName:{color:"#f2faf6",fontSize:15,fontWeight:"800"},
  routeInfo:{color:"#9bb3a6",fontSize:11,marginTop:3},chevron:{color:"#5bd62f",fontSize:26},
  sectionHeading:{color:"#9bb3a6",fontSize:10,fontWeight:"800",letterSpacing:1.2,marginTop:14,marginBottom:10},
  directions:{flexDirection:"row",gap:9},
  direction:{flex:1,alignItems:"center",paddingVertical:12,borderWidth:1,borderRadius:13,backgroundColor:"#12291f",borderColor:"#1f3d2f"},
  directionActive:{backgroundColor:"#17332a",borderColor:"#5bd62f"},
  directionText:{color:"#9bb3a6",fontSize:15,fontWeight:"700"},directionTextActive:{color:"#f2faf6"},
  trip:{backgroundColor:"#12291f",borderRadius:16,marginTop:16,padding:15,flexDirection:"row",gap:14},
  tripDots:{alignItems:"center",width:15,paddingTop:4},
  originDot:{width:11,height:11,borderRadius:6,backgroundColor:"#5bd62f"},
  tripLine:{height:40,width:2,backgroundColor:"#1f3d2f"},
  destinationDot:{width:11,height:11,borderRadius:6,borderWidth:2,borderColor:"#5bd62f"},
  tripLabels:{flex:1},tripName:{color:"#f2faf6",fontWeight:"700",fontSize:14},
  stopField:{minHeight:48,justifyContent:"center",paddingVertical:5},
  stopPicker:{marginTop:8,padding:12,borderRadius:14,backgroundColor:"#12291f"},
  stopOption:{minHeight:44,justifyContent:"center",paddingHorizontal:10,paddingVertical:10,borderRadius:10,marginBottom:5,borderWidth:1,borderColor:"#1f3d2f"},
  stopOptionSelected:{backgroundColor:"#17332a",borderColor:"#5bd62f"},
  stopOptionName:{color:"#f2faf6",fontSize:14},
  destinationName:{marginTop:16},tripCaption:{color:"#9bb3a6",fontSize:11,marginTop:2},
  seats:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginTop:18},
  seatsTitle:{color:"#f2faf6",fontSize:14,fontWeight:"800"},seatsDescription:{color:"#9bb3a6",fontSize:11,marginTop:3},
  stepper:{flexDirection:"row",gap:12,alignItems:"center"},
  step:{height:34,width:34,alignItems:"center",justifyContent:"center",borderRadius:17,backgroundColor:"#12291f"},
  stepText:{color:"#5bd62f",fontSize:22,fontWeight:"700"},
  count:{color:"#f2faf6",fontWeight:"800",fontSize:17,minWidth:18,textAlign:"center"},
  button:{minHeight:54,borderRadius:18,padding:13,alignItems:"center",justifyContent:"center",marginTop:12},
  buttonPrimary:{backgroundColor:"#5bd62f"},buttonSecondary:{backgroundColor:"#0a1d15",borderWidth:1,borderColor:"#1f3d2f"},
  buttonLabel:{fontSize:17,fontWeight:"600"},
  primaryText:{color:"#08261a"},secondaryText:{color:"#f2faf6"},disabled:{opacity:0.43},
  priceCard:{marginTop:14,padding:14,borderRadius:16,backgroundColor:"#12291f"},
  price:{fontSize:26,color:"#f2faf6",fontWeight:"700"},
  availability:{fontSize:12,color:"#B3CDBA",marginTop:6,lineHeight:19},
  availabilityPositive:{color:"#42ECA9"},
  notice:{fontSize:12,color:"#C8FAE0",backgroundColor:"#19543A",padding:11,borderRadius:12,marginTop:12},
  error:{fontSize:12,color:"#FFD8D8",backgroundColor:"#562A2A",padding:11,borderRadius:12,marginTop:12},
});

/** Light palette changes presentation only; API and booking guards remain unchanged. */
const vLight = StyleSheet.create({
  card: { backgroundColor: "#f1f7f3", borderColor: "#dce8e1" },
  eyebrow: { color: "#176347" },
  title: { color: "#0e1a14" },
  subtitle: { color: "#5a7366" },
  hint: { color: "#5a7366" },
  route: { backgroundColor: "#f4f7f5", borderColor: "#dce8e1" },
  routeActive: { backgroundColor: "#e3f7df", borderColor: "#3d9c62" },
  indicator: { borderColor: "#759c82" },
  indicatorActive: { backgroundColor: "#1f8c5b", borderColor: "#1f8c5b" },
  routeName: { color: "#0e1a14" },
  routeInfo: { color: "#5a7366" },
  chevron: { color: "#176347" },
  sectionHeading: { color: "#5a7366" },
  direction: { backgroundColor: "#f4f7f5", borderColor: "#dce8e1" },
  directionActive: { backgroundColor: "#e3f7df", borderColor: "#3d9c62" },
  directionText: { color: "#194b34" },
  directionTextActive: { color: "#0e1a14" },
  trip: { backgroundColor: "#f4f7f5" },
  originDot: { backgroundColor: "#1f8c5b" },
  tripLine: { backgroundColor: "#94bca3" },
  destinationDot: { borderColor: "#1f8c5b" },
  tripName: { color: "#0e1a14" },
  stopPicker: { backgroundColor: "#f4f7f5" },
  stopOption: { backgroundColor: "#ffffff", borderColor: "#dce8e1" },
  stopOptionSelected: { backgroundColor: "#e3f7df", borderColor: "#3d9c62" },
  stopOptionName: { color: "#0e1a14" },
  tripCaption: { color: "#5a7366" },
  seatsTitle: { color: "#0e1a14" },
  seatsDescription: { color: "#5a7366" },
  step: { backgroundColor: "#e5f0e9" },
  stepText: { color: "#175444" },
  count: { color: "#0e1a14" },
  buttonPrimary: { backgroundColor: "#5bd62f" },
  buttonSecondary: { backgroundColor: "#edf8f2", borderColor: "#dce8e1" },
  primaryText: { color: "#08261a" },
  secondaryText: { color: "#175444" },
  priceCard: { backgroundColor: "#f4f7f5" },
  price: { color: "#0d735c" },
  availability: { color: "#5a7366" },
  availabilityPositive: { color: "#176347" },
  notice: { color: "#175444", backgroundColor: "#e9f8ef" },
  error: { color: "#962b20", backgroundColor: "#fff0ec" },
});
