import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { io } from "socket.io-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { API, ApiError, errorMessage, request, setApiEndpoint, validateApiEndpoint } from "../lib/api";
import { isClosed, isLiveOffer, mergeOrder, mergeOrderSnapshot, nextTripLabel, nextTripStatus, statusLabels, type RideOrder } from "../lib/orders";
import DriverRoutePicker from "../components/DriverRoutePicker";
import { parsePassengerRouteCatalog, parsePassengerRouteAvailability, passengerRouteEndpoints, passengerRouteKey, passengerRouteAvailabilityPath, passengerRouteOrderPayload, type PassengerRoute, type PassengerRouteAvailability } from "../lib/passenger-route-orders";
import { canJoinDriverQueue, driverQueueChoiceInput, driverRouteSessionKey, type DriverQueueContext, type DriverRouteGate } from "../lib/driver-routes";

const TOKEN = "tezjet_access_token";
const API_ENDPOINT = "tezjet_api_endpoint";
type Mode = "passenger" | "driver";
type Profile = { id: string; role: string; active_role?: string; roles?: string[]; driver_approval_status?: "pending" | "approved" | "rejected"; full_name?: string };

function Button({ title, onPress, disabled = false, secondary = false, testID }: { title: string; onPress: () => void; disabled?: boolean; secondary?: boolean; testID?: string }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} testID={testID} onPress={onPress} disabled={disabled} style={[s.button, secondary && s.buttonSecondary, disabled && s.disabled]}><Text style={[s.buttonText, secondary && s.buttonSecondaryText]}>{title}</Text></Pressable>;
}

function Stepper({ value, onChange, min = 1, max = 8, disabled = false }: { value: number; onChange: (v: number) => void; min?: number; max?: number; disabled?: boolean }) {
  return <View style={s.stepper}><Pressable style={s.stepButton} disabled={disabled || value <= min} onPress={() => onChange(Math.max(min, value - 1))}><Text style={s.stepText}>−</Text></Pressable><Text style={s.stepValue}>{value}</Text><Pressable style={s.stepButton} disabled={disabled || value >= max} onPress={() => onChange(Math.min(max, value + 1))}><Text style={s.stepText}>+</Text></Pressable></View>;
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("passenger");
  const [apiBase, setApiBase] = useState(API);
  const [endpointInput, setEndpointInput] = useState(API);
  const [endpointError, setEndpointError] = useState("");
  const [showEndpointSettings, setShowEndpointSettings] = useState(!API);
  const [token, setToken] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [demoCode, setDemoCode] = useState("");
  const [requested, setRequested] = useState(false);
  const [passengerRoutes, setPassengerRoutes] = useState<PassengerRoute[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState("");
  const [passengerDirection, setPassengerDirection] = useState<"a_to_b" | "b_to_a">("a_to_b");
  const [seats, setSeats] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [driverSeats, setDriverSeats] = useState(3);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [driverInQueue, setDriverInQueue] = useState(false);
  const [driverQueueContext, setDriverQueueContext] = useState<DriverQueueContext | null>(null);
  const [driverRouteGate, setDriverRouteGate] = useState<DriverRouteGate>({ sessionKey: "", ready: false, hasChoice: false, mutating: false });
  const driverRouteGateRef = useRef(driverRouteGate);
  const updateDriverRouteGate = useCallback((next: DriverRouteGate) => {
    driverRouteGateRef.current = next;
    setDriverRouteGate(next);
  }, []);
  const [socketConnected, setSocketConnected] = useState(false);
  const [incomingOrder, setIncomingOrder] = useState<RideOrder | null>(null);
  const [orders, setOrders] = useState<RideOrder[]>([]);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [dataError, setDataError] = useState("");
  const [routeError, setRouteError] = useState("");
  const [availabilityError, setAvailabilityError] = useState("");
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [availability, setAvailability] = useState<{ key: string; available: boolean; checkedAt: number; fare: PassengerRouteAvailability["fare"] | null } | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [now, setNow] = useState(Date.now());
  const activeRole = profile?.active_role ?? profile?.role;
  const currentToken = useRef(token);
  currentToken.current = token;
  const availabilityGeneration = useRef(0);
  const ordersRequestInFlight = useRef<string | null>(null);
  const trackedOrders = useRef<RideOrder[]>([]);
  const orderRevision = useRef(0);
  const orderChanges = useRef(new Map<string, number>());
  const queueRevision = useRef(0);
  const applyOrder = useCallback((incoming: RideOrder) => {
    orderChanges.current.set(incoming.id, ++orderRevision.current);
    trackedOrders.current = mergeOrder(trackedOrders.current, incoming);
    setOrders(trackedOrders.current);
  }, []);
  const driverApproved = activeRole === "driver" && profile?.driver_approval_status === "approved";
  const driverRouteSession = driverRouteSessionKey(apiBase, token);
  const canJoinQueue = canJoinDriverQueue(driverRouteGate, driverRouteSession);
  const activeDriverOrders = orders.filter(order => !isClosed(order) && order.driver_id === profile?.id);
  const passengerOrders = orders.filter(order => order.passenger_id === profile?.id);
  const passengerHasActiveOrder = passengerOrders.some(order => !isClosed(order));
  const selectedRoute = passengerRoutes.find(route => route.id === selectedRouteId);
  const selectedEndpoints = selectedRoute ? passengerRouteEndpoints(selectedRoute, passengerDirection) : null;
  const selectedKey = selectedRoute ? passengerRouteKey(selectedRoute, passengerDirection, seats) : "";
  const availabilityFresh = !!selectedKey && availability?.key === selectedKey && now - availability.checkedAt < 15_000;
  const canOrder = activeRole === "passenger" && availabilityFresh && availability?.available === true && !passengerHasActiveOrder;
  const visibleError = dataError || routeError || (profile ? profileError : "");

  useEffect(() => {
    AsyncStorage.multiGet([API_ENDPOINT, TOKEN])
      .then(values => {
        const savedEndpoint = values[0][1];
        if (savedEndpoint) {
          try {
            const endpoint = setApiEndpoint(savedEndpoint);
            setApiBase(endpoint); setEndpointInput(endpoint); setShowEndpointSettings(false);
          } catch (e) {
            setEndpointError(errorMessage(e, "Проверь адрес сервера TezJet."));
            setShowEndpointSettings(true);
            return;
          }
        }
        const savedToken = values[1][1];
        if (savedToken) { currentToken.current = savedToken; setToken(savedToken); }
      })
      .catch(() => setProfileError("Не удалось восстановить вход на этом устройстве."))
      .finally(() => setSessionLoading(false));
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setIncomingOrder(current => current?.offer_expires_at !== undefined && current.offer_expires_at <= now ? null : current);
  }, [now]);

  const clearSession = useCallback(async () => {
    currentToken.current = "";
    trackedOrders.current = [];
    orderChanges.current.clear(); orderRevision.current += 1; queueRevision.current += 1;
    setToken(""); setProfile(null); setOrders([]); setIncomingOrder(null);
    setProfileLoading(false); setProfileError("");
    setPassengerRoutes([]); setSelectedRouteId(""); setAvailability(null); setQueuePosition(null); setDriverInQueue(false); setDriverQueueContext(null);
    setDataError(""); setRouteError(""); setAvailabilityError("");
    try { await AsyncStorage.removeItem(TOKEN); return true; }
    catch { setProfileError("Не удалось удалить сохранённый вход на устройстве. Попробуй выйти ещё раз."); return false; }
  }, []);

  async function saveEndpoint() {
    setBusy(true);
    try {
      const endpoint = validateApiEndpoint(endpointInput);
      if (!await clearSession()) throw new Error("Не удалось удалить прежний вход. Адрес сервера не изменён; повтори сохранение.");
      await AsyncStorage.setItem(API_ENDPOINT, endpoint);
      setApiEndpoint(endpoint);
      setApiBase(endpoint); setEndpointInput(endpoint); setEndpointError("");
      setRequested(false); setOtp(""); setDemoCode(""); setMessage("");
      setShowEndpointSettings(false);
    } catch (e) { setEndpointError(errorMessage(e, "Не удалось сохранить адрес сервера.")); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!token) { setProfile(null); setPassengerRoutes([]); setSelectedRouteId(""); setProfileLoading(false); return; }
    let active = true;
    setProfileLoading(true); setProfileError("");
    (async () => {
      try {
        const me = await request<{ user: Profile }>("/api/auth/me", token);
        if (!active || currentToken.current !== token) return;
        setProfile(me.user);
        setMode((me.user.active_role ?? me.user.role) === "driver" ? "driver" : "passenger");
      } catch (e) {
        if (!active || currentToken.current !== token) return;
        setProfileError(errorMessage(e, "Не удалось загрузить профиль."));
        if (e instanceof ApiError && e.status === 401) await clearSession();
      } finally {
        if (active) setProfileLoading(false);
      }
    })();
    return () => { active = false; };
  }, [token, apiBase, profileRefresh, clearSession]);

  useEffect(() => {
    if (!token || activeRole !== "passenger") { setPassengerRoutes([]); setSelectedRouteId(""); return; }
    let live = true;
    request<unknown>("/api/orders/routes", token).then(raw => {
      if (!live || currentToken.current !== token) return;
      const routes = parsePassengerRouteCatalog(raw);
      setPassengerRoutes(routes);
      setSelectedRouteId(id => routes.some(r => r.id === id) ? id : (routes[0]?.id ?? ""));
      setAvailability(null);
      setRouteError(routes.length ? "" : "Администратор пока не добавил маршрут A↔B.");
    }).catch(e => {
      if (!live || currentToken.current !== token) return;
      setPassengerRoutes([]); setSelectedRouteId(""); setAvailability(null);
      setRouteError(errorMessage(e, "Не удалось загрузить маршруты."));
    });
    return () => { live = false; };
  }, [token, apiBase, activeRole, profileRefresh]);

  const refreshOrders = useCallback(async () => {
    if (!token || !profile?.id || (activeRole !== "passenger" && !driverApproved)) return;
    if (ordersRequestInFlight.current === token) return;
    ordersRequestInFlight.current = token;
    const revisionAtStart = orderRevision.current;
    const queueRevisionAtStart = queueRevision.current;
    const results = await Promise.allSettled([
      request<{ orders: RideOrder[] }>("/api/orders", token),
      driverApproved ? request<{ your_position: number | null; your_entry: { routeContext?: DriverQueueContext } | null }>("/api/queue", token) : Promise.resolve(undefined),
    ]);
    const ordersResult = results[0];
    const queueResult = results[1];
    if (ordersRequestInFlight.current === token) ordersRequestInFlight.current = null;
    if (currentToken.current !== token) return;
    if (ordersResult.status === "fulfilled" && ordersResult.value) {
      const list = (ordersResult.value as { orders: RideOrder[] }).orders || [];
      const changedAfterRequest = new Set([...orderChanges.current].filter(([, revision]) => revision > revisionAtStart).map(([id]) => id));
      trackedOrders.current = mergeOrderSnapshot(trackedOrders.current, list, changedAfterRequest);
      setOrders(trackedOrders.current);
      if (driverApproved) {
        setIncomingOrder(trackedOrders.current.find(order => isLiveOffer(order, profile.id)) ?? null);
      }
    }
    if (queueResult.status === "fulfilled" && queueResult.value && queueRevision.current === queueRevisionAtStart) {
      const position = (queueResult.value as { your_position: number | null }).your_position;
      setQueuePosition(position); setDriverInQueue(position !== null);
      setDriverQueueContext((queueResult.value as { your_entry?: { routeContext?: DriverQueueContext } }).your_entry?.routeContext ?? null);
    }
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") {
      setDataError(errorMessage(failed.reason, "Не удалось обновить заказы."));
      if (results.some(result => result.status === "rejected" && result.reason instanceof ApiError && result.reason.status === 401)) await clearSession();
    } else setDataError("");
  }, [token, apiBase, profile?.id, activeRole, driverApproved, clearSession]);

  const refreshAvailability = useCallback(async () => {
    if (!token || activeRole !== "passenger" || !selectedRoute) {
      ++availabilityGeneration.current; setAvailability(null); setCheckingAvailability(false); return null;
    }
    const generation = ++availabilityGeneration.current;
    const key = passengerRouteKey(selectedRoute, passengerDirection, seats);
    setCheckingAvailability(true);
    try {
      const raw = await request<unknown>(passengerRouteAvailabilityPath(selectedRoute, passengerDirection, seats), token);
      const result = parsePassengerRouteAvailability(raw);
      if (currentToken.current !== token || generation !== availabilityGeneration.current) return null;
      setAvailability({ key, available: result.available, checkedAt: Date.now(), fare: result.fare });
      setAvailabilityError("");
      return result.available;
    } catch (e) {
      if (currentToken.current === token && generation === availabilityGeneration.current) {
        setAvailability(null); setAvailabilityError(errorMessage(e, "Не удалось проверить водителей."));
        if (e instanceof ApiError && e.status === 401) await clearSession();
      }
      return null;
    } finally { if (generation === availabilityGeneration.current) setCheckingAvailability(false); }
  }, [token, apiBase, activeRole, selectedRoute, passengerDirection, seats, clearSession]);

  const availabilityRef = useRef(refreshAvailability);
  useEffect(() => { availabilityRef.current = refreshAvailability; }, [refreshAvailability]);

  useEffect(() => {
    void refreshOrders();
    const timer = setInterval(() => { void refreshOrders(); }, 10_000);
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void refreshOrders(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [refreshOrders]);

  useEffect(() => {
    void refreshAvailability();
    const timer = setInterval(() => { void refreshAvailability(); }, 10_000);
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void refreshAvailability(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [refreshAvailability]);

  useEffect(() => {
    if (!token || !profile?.id || (activeRole !== "passenger" && !driverApproved) || !API) return;
    const socket = io(API, { path: "/api/socket.io", auth: { token }, transports: ["websocket"] });
    socket.on("connect", () => { setSocketConnected(true); void refreshOrders(); void availabilityRef.current(); });
    socket.on("disconnect", () => setSocketConnected(false));
    socket.on("connect_error", () => setSocketConnected(false));
    socket.on("incoming_order", (payload: { order?: RideOrder }) => {
      if (!driverApproved || !payload.order || currentToken.current !== token) return;
      applyOrder(payload.order);
      const latest = trackedOrders.current.find(order => order.id === payload.order?.id);
      if (latest && isLiveOffer(latest, profile.id)) setIncomingOrder(latest);
    });
    socket.on("order:offer_withdrawn", (payload: { order_id?: string; order?: RideOrder }) => {
      if (currentToken.current !== token) return;
      const orderId = payload.order_id ?? payload.order?.id;
      if (payload.order) applyOrder(payload.order);
      setIncomingOrder(current => current?.id === orderId ? null : current);
      void refreshOrders();
    });
    socket.on("order:status", (payload: { order?: RideOrder }) => {
      if (currentToken.current !== token) return;
      const updatedOrder = payload.order;
      if (!updatedOrder) return;
      applyOrder(updatedOrder);
      setIncomingOrder(current => current?.id === updatedOrder.id && !isLiveOffer(updatedOrder, profile.id) ? null : current);
    });
    socket.on("queue:position", (payload: { position?: number | null; route_context?: DriverQueueContext | null }) => {
      if (!driverApproved || currentToken.current !== token) return;
      queueRevision.current += 1;
      setQueuePosition(payload.position ?? null);
      setDriverInQueue(payload.position != null);
      setDriverQueueContext(payload.route_context ?? null);
    });
    socket.on("queue:update", () => { void availabilityRef.current(); });
    return () => { socket.disconnect(); setSocketConnected(false); };
  }, [token, profile?.id, activeRole, driverApproved, refreshOrders, applyOrder]);

  async function login(verify: boolean) {
    setBusy(true);
    try {
      const r = await request<{ access_token?: string; demo_code?: string }>(verify ? "/api/auth/verify-otp" : "/api/auth/request-otp", undefined, {
        method: "POST",
        body: JSON.stringify({ phone_number: phone.trim(), full_name: name.trim(), code: otp.trim(), role: mode, locale: "ru" })
      });
      if (verify && r.access_token) {
        await AsyncStorage.setItem(TOKEN, r.access_token);
        currentToken.current = r.access_token;
        setRequested(false); setOtp(""); setDemoCode(""); setToken(r.access_token);
      } else { setDemoCode(r.demo_code || ""); setRequested(true); }
    } catch (e) { Alert.alert("Авторизация", e instanceof Error ? e.message : "Попробуй ещё раз."); }
    finally { setBusy(false); }
  }

  async function switchMode(next: Mode) {
    if (!token) {
      setMode(next); setRequested(false); setOtp(""); setDemoCode(""); setMessage("");
      return;
    }
    if (activeRole === next) { setMode(next); return; }
    setBusy(true);
    try {
      const result = await request<{ access_token: string; user: Profile }>("/api/auth/switch-role", token, { method: "POST", body: JSON.stringify({ role: next }) });
      currentToken.current = result.access_token;
      setToken(result.access_token); setProfile(result.user); setMode(next);
      trackedOrders.current = []; orderChanges.current.clear(); orderRevision.current += 1; queueRevision.current += 1;
      setOrders([]); setIncomingOrder(null); setQueuePosition(null); setDriverInQueue(false); setDriverQueueContext(null); setAvailability(null); setPassengerRoutes([]); setSelectedRouteId("");
      setRequested(false); setOtp(""); setDemoCode(""); setMessage(""); setDataError("");
      try { await AsyncStorage.setItem(TOKEN, result.access_token); }
      catch { setProfileError("Вход выполнен, но не сохранён на устройстве. При следующем запуске потребуется код."); }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await clearSession();
      Alert.alert("Режим TezJet", e instanceof ApiError && e.code === "ROLE_BUSY" ? "Сначала заверши или отмени поездку. Водителю также нужно выйти из очереди." : errorMessage(e, "Не удалось переключить режим."));
    } finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try {
      try { if (token) await request<void>("/api/auth/logout", token, { method: "POST" }); } catch { /* clear local session even when offline */ }
      await clearSession();
      setMessage(""); setDataError("");
    } finally { setBusy(false); }
  }

  async function getCoordinates() {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) throw new Error("Разреши доступ к геолокации, чтобы продолжить.");
    const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: l.coords.latitude, lng: l.coords.longitude, timestamp: l.timestamp, isMocked: l.mocked === true };
  }

  async function order() {
    const route = selectedRoute, direction = passengerDirection, requestedSeats = seats, session = token;
    if (!route || !availabilityFresh || !canOrder) return Alert.alert("Маршрут", "Выбери маршрут и проверь водителей.");
    setBusy(true);
    try {
      const available = await refreshAvailability();
      if (available !== true) {
        if (available === false) setMessage("Водителей пока нет. Заказ не создан.");
        else Alert.alert("Связь с Onay", "Не удалось проверить водителей. Повтори попытку.");
        return;
      }
      const location = await getCoordinates();
      if (currentToken.current !== session) return;
      const payload = passengerRouteOrderPayload(route, direction, requestedSeats, location);
      const r = await request<{ order: RideOrder; offer?: unknown }>("/api/orders/route", session, {
        method: "POST", body: JSON.stringify(payload),
      });
      if (currentToken.current !== session) return;
      applyOrder(r.order);
      setMessage(r.offer ? "Заказ отправлен водителю. Ждём подтверждения." : "Заказ создан.");
      await refreshOrders();
    } catch (e) {
      if (currentToken.current !== session) return;
      if (e instanceof ApiError && e.code === "NO_DRIVERS") {
        setAvailability({ key: passengerRouteKey(route, direction, requestedSeats), available: false, checkedAt: Date.now(), fare: null });
        setMessage("Водителей пока нет. Заказ не создан.");
      } else if (e instanceof ApiError && ["ROUTE_CHANGED", "ROUTE_NOT_FOUND", "ROUTE_INACTIVE", "ROUTE_NOT_CONFIGURED"].includes(e.code ?? "")) {
        setAvailability(null); setRouteError("Маршрут изменился. Обнови список и выбери поездку снова.");
        setProfileRefresh(value => value + 1);
      } else if (e instanceof ApiError && e.code === "OUTSIDE_PICKUP_GEOFENCE") {
        Alert.alert("Место посадки", "Обычный заказ требует находиться рядом с выбранным питаком. Внешняя подача будет отдельным режимом.");
      } else {
        Alert.alert("Заказ", errorMessage(e, "Не удалось создать заказ."));
        await refreshOrders();
      }
    } finally { setBusy(false); }
  }

  async function refreshProfile() {
    if (!token) return;
    const requestToken = token;
    setBusy(true);
    try {
      const me = await request<{ user: Profile }>("/api/auth/me", requestToken);
      if (currentToken.current !== requestToken) return;
      setProfile(me.user); setProfileError(""); setProfileRefresh(value => value + 1);
      Alert.alert("Статус профиля", me.user.driver_approval_status === "approved" ? "Водительский профиль подтверждён." : me.user.driver_approval_status === "rejected" ? "Водительский профиль отклонён." : "Профиль ожидает подтверждения администратора.");
    } catch (e) {
      if (currentToken.current !== requestToken) return;
      if (e instanceof ApiError && e.status === 401) await clearSession();
      Alert.alert("Профиль", errorMessage(e, "Не удалось обновить статус."));
    } finally { setBusy(false); }
  }

  async function joinQueue() {
    const requestToken = token;
    const requestSession = driverRouteSession;
    if (!canJoinDriverQueue(driverRouteGateRef.current, requestSession)) return;
    const routeChoice = driverQueueChoiceInput(driverRouteGateRef.current, requestSession);
    setBusy(true);
    try {
      const location = await getCoordinates();
      if (currentToken.current !== requestToken || !canJoinDriverQueue(driverRouteGateRef.current, requestSession) ||
          JSON.stringify(driverQueueChoiceInput(driverRouteGateRef.current, requestSession)) !== JSON.stringify(routeChoice)) return;
      const queueRevisionAtStart = queueRevision.current;
      const result = await request<{ position: number | null; entry?: { routeContext?: DriverQueueContext } }>("/api/queue/join", requestToken, { method: "POST", body: JSON.stringify({ location, available_seats: driverSeats, route_choice: routeChoice }) });
      if (currentToken.current !== requestToken) return;
      if (queueRevision.current === queueRevisionAtStart) {
        queueRevision.current += 1;
        setQueuePosition(result.position); setDriverInQueue(result.position !== null);
        setDriverQueueContext(result.entry?.routeContext ?? null);
      }
      await refreshOrders();
      Alert.alert("TezJet Driver", `Ты в очереди. Позиция: ${result.position ?? "обновляется"}.`);
    } catch (e) { Alert.alert("Не удалось встать в очередь", e instanceof Error ? e.message : "Проверь геолокацию и доступность."); }
    finally { setBusy(false); }
  }

  async function updateDriverLocation() {
    const requestToken = token, requestSession = driverRouteSession;
    setBusy(true);
    try {
      const location = await getCoordinates();
      if (currentToken.current !== requestToken || driverRouteGateRef.current.sessionKey !== requestSession) return;
      await request("/api/queue/location", requestToken, { method: "PATCH", body: JSON.stringify({ location }) });
      if (currentToken.current !== requestToken) return;
      Alert.alert("Местоположение обновлено", "Координаты переданы TezJet.");
    } catch (e) { Alert.alert("Геолокация водителя", e instanceof Error ? e.message : "Не удалось обновить координаты."); }
    finally { setBusy(false); }
  }

  async function leaveQueue() {
    const requestToken = token;
    setBusy(true);
    try {
      await request<void>("/api/queue/leave", requestToken, { method: "DELETE" });
      if (currentToken.current !== requestToken) return;
      queueRevision.current += 1;
      setQueuePosition(null); setDriverInQueue(false); setDriverQueueContext(null);
    } catch (e) { Alert.alert("Очередь", e instanceof Error ? e.message : "Не удалось выйти из очереди."); }
    finally { setBusy(false); }
  }

  async function acceptOrder() {
    if (!incomingOrder) return;
    const orderId = incomingOrder.id;
    setBusy(true);
    try {
      const result = await request<{ order: RideOrder }>(`/api/orders/${orderId}/accept`, token, { method: "POST" });
      applyOrder(result.order);
      setIncomingOrder(current => current?.id === orderId ? null : current);
      await refreshOrders();
    } catch (e) {
      Alert.alert("Не удалось принять заказ", errorMessage(e, "Обнови данные и попробуй снова."));
      if (e instanceof ApiError && e.status === 409) setIncomingOrder(current => current?.id === orderId ? null : current);
      await refreshOrders();
    }
    finally { setBusy(false); }
  }

  async function rejectOrder() {
    if (!incomingOrder) return;
    const orderId = incomingOrder.id;
    setBusy(true);
    try {
      const result = await request<{ order: RideOrder }>(`/api/orders/${orderId}/reject`, token, { method: "POST" });
      applyOrder(result.order);
      setIncomingOrder(current => current?.id === orderId ? null : current);
      await refreshOrders();
    } catch (e) {
      Alert.alert("Не удалось отклонить заказ", errorMessage(e, "Повтори попытку."));
      if (e instanceof ApiError && e.status === 409) setIncomingOrder(current => current?.id === orderId ? null : current);
      await refreshOrders();
    } finally { setBusy(false); }
  }

  async function cancelOrder(orderToCancel: RideOrder) {
    setBusy(true);
    try {
      const result = await request<{ order: RideOrder }>(`/api/orders/${orderToCancel.id}/cancel`, token, { method: "POST" });
      applyOrder(result.order);
      setMessage("Заказ отменён.");
      await refreshOrders();
    } catch (e) {
      Alert.alert("Отмена заказа", errorMessage(e, "Не удалось отменить заказ."));
      await refreshOrders();
    } finally { setBusy(false); }
  }

  async function progressOrder(activeOrder: RideOrder) {
    const next = nextTripStatus(activeOrder);
    if (!next) return;
    setBusy(true);
    try {
      const result = await request<{ order: RideOrder }>(`/api/orders/${activeOrder.id}/status`, token, { method: "PATCH", body: JSON.stringify({ status: next }) });
      applyOrder(result.order);
      await refreshOrders();
    } catch (e) { Alert.alert("Статус поездки", e instanceof Error ? e.message : "Не удалось обновить поездку."); }
    finally { setBusy(false); }
  }

  return <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <View style={s.header}><Text style={s.logo}>T</Text><View style={s.brandWrap}><Text style={s.brand}>tez<Text style={s.brandAccent}>jet</Text></Text><Text style={s.tag}>ТВОЙ ГОРОД. ТВОЙ МАРШРУТ.</Text></View>{token ? <Pressable onPress={logout} disabled={busy}><Text style={s.logout}>Выйти</Text></Pressable> : null}</View>
    <View style={s.hero}><Text style={s.kicker}>ОДНО ПРИЛОЖЕНИЕ · ANDROID + IOS</Text><Text style={s.title}>{mode === "passenger" ? "Куда едем?" : "TezJet Driver"}</Text><Text style={s.desc}>{mode === "passenger" ? "Выбери маршрут — остальное сделает TezJet." : "Подтверждённый водитель может встать в очередь и получать подходящие заказы."}</Text></View>
    <View style={s.switch}><Button title="Пассажир" onPress={() => switchMode("passenger")} disabled={busy || profileLoading} secondary={mode !== "passenger"} /><Button title="Водитель" onPress={() => switchMode("driver")} disabled={busy || profileLoading} secondary={mode !== "driver"} /></View>
    {showEndpointSettings ? <View style={s.card}><Text style={s.heading}>Сервер TezJet</Text><Text style={s.descDark}>Укажи адрес сервера для подключения. При смене сервера потребуется вход по телефону.</Text><TextInput style={s.input} value={endpointInput} onChangeText={setEndpointInput} placeholder="https://api.tezjet…" autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy && !sessionLoading} />{endpointError ? <Text style={s.note}>{endpointError}</Text> : null}<Button title="Сохранить сервер" onPress={saveEndpoint} disabled={busy || sessionLoading || !endpointInput.trim()} />{apiBase ? <Button title="Закрыть настройки" onPress={() => setShowEndpointSettings(false)} secondary disabled={busy} /> : null}</View> : <Button title="Настройки сервера" onPress={() => setShowEndpointSettings(true)} secondary disabled={busy || sessionLoading} />}
    {visibleError ? <View style={s.card}><Text style={s.heading}>Нет актуальных данных</Text><Text style={s.descDark}>{visibleError}</Text><Button title="Повторить обновление" onPress={() => { void refreshOrders(); void refreshAvailability(); setProfileRefresh(value => value + 1); }} secondary disabled={busy} /></View> : null}

    {sessionLoading ? <View style={s.card}><ActivityIndicator color="#0D735C" /><Text style={s.descDark}>Восстанавливаем вход…</Text></View> : !token ? <View style={s.card}>
      <Text style={s.heading}>{mode === "driver" ? "Вход или регистрация водителя" : "Вход по телефону"}</Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Твоё имя" autoCapitalize="words" />
      <TextInput style={s.input} value={phone} onChangeText={setPhone} placeholder="+998 90 123 45 67" keyboardType="phone-pad" />
      {requested ? <>{demoCode ? <Text style={s.note}>Тестовый код: {demoCode}</Text> : <Text style={s.note}>Введи код подтверждения, полученный через настроенный сервис авторизации.</Text>}<TextInput style={s.input} value={otp} onChangeText={setOtp} placeholder="Код подтверждения" keyboardType="number-pad" /><Button title={busy ? "Проверяем…" : mode === "driver" ? "Продолжить как водитель" : "Войти как пассажир"} onPress={() => login(true)} disabled={busy || !apiBase || !otp.trim()} /></> : <Button title={busy ? "Отправляем…" : "Получить код"} onPress={() => login(false)} disabled={busy || !apiBase || !phone.trim() || !name.trim()} />}
      {profileError ? <Text style={s.note}>{profileError}</Text> : null}
      {busy ? <ActivityIndicator style={s.loader} color="#0D735C" /> : null}
      {mode === "driver" ? <Text style={s.small}>Новый водительский профиль будет ожидать подтверждения администратора. До подтверждения заказы недоступны.</Text> : null}
    </View> : !profile ? <View style={s.card}><Text style={s.heading}>{profileLoading ? "Загружаем профиль…" : "Нет связи с профилем"}</Text>{profileLoading ? <ActivityIndicator color="#0D735C" /> : null}<Text style={s.descDark}>{profileError || "Вход сохранён. Подключись к TezJet, чтобы продолжить."}</Text><Button title="Повторить" onPress={() => setProfileRefresh(value => value + 1)} disabled={profileLoading} secondary /></View> : mode === "driver" ? (
      activeRole !== "driver" ? <View style={s.card}><Text style={s.heading}>Переключение режима</Text><Text style={s.descDark}>Подключи водительский профиль к своему аккаунту.</Text><Button title="Войти в режим водителя" onPress={() => switchMode("driver")} disabled={busy} /></View>
      : profile.driver_approval_status !== "approved" ? <View style={s.card}><Text style={s.heading}>{profile.driver_approval_status === "rejected" ? "Профиль отклонён" : "Профиль на проверке"}</Text><Text style={s.descDark}>{profile.driver_approval_status === "rejected" ? "Свяжись с поддержкой TezJet, чтобы узнать причину." : "Администратор должен подтвердить водительский профиль. До этого нельзя вставать в очередь или принимать заказы."}</Text><Button title="Проверить статус" onPress={refreshProfile} secondary disabled={busy} /></View>
      : <>
        <DriverRoutePicker key={driverRouteSession} endpoint={apiBase} token={token} busy={busy} queued={driverInQueue}
          activeTrip={activeDriverOrders.length > 0} pendingOffer={!!incomingOrder} onStatusChange={updateDriverRouteGate} />
        <View style={s.card}>
          <Text style={s.heading}>Рабочая смена</Text>
          <Text style={s.descDark}>Связь: {socketConnected ? "подключена" : "переподключение…"}</Text>
          <Text style={s.descDark} testID="driver-queue-status">Очередь: {driverInQueue ? `позиция ${queuePosition ?? "—"}` : activeDriverOrders.length ? "активный маршрут" : "не в очереди"}</Text>
          {driverInQueue && driverQueueContext ? <View testID="driver-queue-context"><Text style={s.descDark}>{driverQueueContext.routeName} · питак {driverQueueContext.pitak}: {driverQueueContext.stopName}</Text><Text style={s.note}>Вступление в очередь сохранено. Заказы по этому маршруту поступают по FIFO. Ручной выезд подключим отдельно.</Text></View> : null}
          <Text style={s.label}>МЕСТА ПРИ ВХОДЕ В ОЧЕРЕДЬ</Text><Stepper value={driverSeats} onChange={setDriverSeats} disabled={busy || driverInQueue || !!incomingOrder || activeDriverOrders.length > 0} />
          {!driverInQueue && !activeDriverOrders.length ? <Button title={busy ? "Определяем местоположение…" : driverRouteGate.hasChoice ? `Встать в очередь питак ${driverRouteGate.pitak ?? "—"}` : "Встать в очередь"} testID="driver-queue-join" onPress={joinQueue} disabled={busy || !!incomingOrder || !canJoinQueue} /> : <><Button title={busy ? "Обновляем…" : "Обновить местоположение"} testID="driver-queue-location" onPress={updateDriverLocation} disabled={busy} secondary /><Button title="Выйти из очереди" testID="driver-queue-leave" onPress={leaveQueue} disabled={busy || !!incomingOrder || activeDriverOrders.length > 0} secondary /></>}
        </View>
        {incomingOrder ? <View style={s.card}><Text style={s.heading}>Новый заказ</Text><Text style={s.descDark}>Точка подачи: {incomingOrder.pickup_point}</Text><Text style={s.descDark}>Куда: {incomingOrder.destination || "смотри маршрут"}</Text><Text style={s.descDark}>Пассажиров: {incomingOrder.seats}</Text><Text style={s.note}>Ответить за {Math.max(0, Math.ceil(((incomingOrder.offer_expires_at ?? now) - now) / 1_000))} сек.</Text><Button title={busy ? "Принимаем…" : "Принять заказ"} onPress={acceptOrder} disabled={busy || !isLiveOffer(incomingOrder, profile.id, now)} /><Button title="Отклонить" onPress={rejectOrder} disabled={busy || !isLiveOffer(incomingOrder, profile.id, now)} secondary /></View> : null}
        {activeDriverOrders.map(activeOrder => <View key={activeOrder.id} style={s.card}><Text style={s.heading}>Текущая поездка</Text><Text style={s.descDark}>Статус: {statusLabels[activeOrder.status]}</Text><Text style={s.descDark}>Точка подачи: {activeOrder.pickup_point}</Text><Text style={s.descDark}>Назначение: {activeOrder.destination || "по маршруту"}</Text>{nextTripStatus(activeOrder) ? <Button title={busy ? "Обновляем…" : nextTripLabel(activeOrder)} onPress={() => progressOrder(activeOrder)} disabled={busy} /> : null}</View>)}
        {!driverRouteGate.hasChoice && !driverQueueContext && !incomingOrder && !activeDriverOrders.length ? <View style={s.card}><Text style={s.descDark}>Ожидаем подходящий заказ. Сервер выбирает водителя по очереди и доступным местам.</Text></View> : null}
      </>
    ) : <>
    {passengerOrders.filter(order => !isClosed(order)).map(passengerOrder => <View key={passengerOrder.id} style={s.card}><Text style={s.heading}>Твоя поездка</Text><Text style={s.descDark}>{statusLabels[passengerOrder.status]}</Text><Text style={s.descDark}>Точка подачи: {passengerOrder.pickup_point}</Text><Text style={s.descDark}>Куда: {passengerOrder.destination || "по маршруту"}</Text><Text style={s.descDark}>Пассажиров: {passengerOrder.seats}</Text>{passengerOrder.status === "searching" && passengerOrder.offered_driver_id ? <Text style={s.note}>Ждём ответа водителя.</Text> : null}<Button title={busy ? "Отменяем…" : "Отменить заказ"} onPress={() => cancelOrder(passengerOrder)} disabled={busy} secondary /></View>)}
    <View style={s.card}>
      <Text style={s.heading}>Заказ по маршруту A↔B</Text>
      <Text style={s.label}>ВЫБЕРИ МАРШРУТ</Text>
      {passengerRoutes.map(route => <Pressable key={route.id} testID={"passenger-route-"+route.id} disabled={busy}
        onPress={() => { setSelectedRouteId(route.id); setAvailability(null); setMessage(""); }}
        style={[s.stop, selectedRouteId === route.id && s.selected]}><Text style={s.stopText}>{route.name}</Text></Pressable>)}
      <Text style={s.label}>НАПРАВЛЕНИЕ</Text>
      {selectedRoute ? (["a_to_b", "b_to_a"] as const).map(direction => {
        const points = passengerRouteEndpoints(selectedRoute, direction);
        return <Pressable key={direction} testID={"passenger-direction-"+direction} disabled={busy}
          onPress={() => { setPassengerDirection(direction); setAvailability(null); setMessage(""); }}
          style={[s.stop, passengerDirection === direction && s.selected]}>
          <Text style={s.stopText}>{direction === "a_to_b" ? "A → B" : "B → A"}: {points.from.name} → {points.to.name}</Text>
        </Pressable>;
      }) : <Text style={s.descDark}>Нет доступных маршрутов. Обнови данные.</Text>}
      {selectedEndpoints ? <Text style={s.descDark}>Посадка: {selectedEndpoints.from.name}. Назначение: {selectedEndpoints.to.name}.</Text> : null}
      <View style={s.seatsRow}><Text style={s.descDark}>Пассажиры (до 8)</Text><Stepper value={seats} disabled={busy}
        onChange={value => { setSeats(value); setAvailability(null); }} /></View>
      <View style={s.fare}><Text style={s.label}>СТОИМОСТЬ ПО ДАННЫМ СЕРВЕРА</Text>
        <Text style={s.price}>{availabilityFresh && availability?.fare ? new Intl.NumberFormat("ru-RU").format(availability.fare.totalKzt)+" ₸" : "—"}</Text></View>
      <Text style={s.descDark}>Наличие водителей: {checkingAvailability ? "проверяем…" : !availabilityFresh ? "нет актуальных данных" : availability?.available ? "есть свободный водитель" : "Водителей пока нет"}</Text>
      {availabilityError ? <Text style={s.note}>{availabilityError}</Text> : null}
      <Button title="Проверить наличие водителей" onPress={() => { void refreshAvailability(); }} disabled={busy || checkingAvailability || !selectedRoute} secondary />
      <Button title={busy ? "Оформляем…" : "Заказать поездку"} onPress={order} disabled={busy || !canOrder || checkingAvailability} />
      {passengerHasActiveOrder ? <Text style={s.small}>Сначала заверши или отмени текущий заказ.</Text> : null}
      {message ? <Text style={s.note}>{message}</Text> : null}
      <Text style={s.small}>Для обычного заказа нужно находиться у выбранного питака. Геолокация запрашивается при оформлении. Внешняя подача с подтверждением цены — отдельный режим.</Text>
    </View>
    {availabilityFresh && availability?.available === false ? <View style={s.card}><Text style={s.heading}>Водителей пока нет</Text><Text style={s.descDark}>Для этой точки и количества пассажиров сейчас нет свободного водителя. Попробуй проверить наличие позже.</Text></View> : null}
    {passengerOrders.some(isClosed) ? <View style={s.card}><Text style={s.heading}>Последние поездки</Text>{passengerOrders.filter(isClosed).slice(0, 3).map(previous => <Text key={previous.id} style={s.descDark}>{previous.pickup_point} → {previous.destination || "по маршруту"}: {statusLabels[previous.status]}</Text>)}</View> : null}
    </>}
    <Text style={s.footer}>TEZJET · ПАССАЖИР И ВОДИТЕЛЬ В ОДНОМ ПРИЛОЖЕНИИ</Text>
  </ScrollView>;
}

const s = StyleSheet.create({
 screen:{flex:1,backgroundColor:"#F3F6F4"},content:{padding:20,paddingTop:24,paddingBottom:44,maxWidth:680,width:"100%",alignSelf:"center"},
 header:{flexDirection:"row",alignItems:"center",gap:12,marginBottom:24},logo:{backgroundColor:"#0C2B26",color:"#fff",fontSize:28,fontWeight:"900",paddingHorizontal:15,paddingVertical:7,borderRadius:14},brandWrap:{flex:1},brand:{fontSize:25,color:"#0C2B26"},brandAccent:{color:"#0D735C",fontWeight:"900"},tag:{fontSize:9,color:"#6A7D76",letterSpacing:1,fontWeight:"700"},logout:{padding:8,color:"#5A6B65",fontWeight:"700"},
 hero:{padding:22,backgroundColor:"#0C2B26",borderRadius:24,marginBottom:16},kicker:{fontSize:10,color:"#8ED8BC",fontWeight:"800",letterSpacing:1},title:{fontSize:32,color:"#fff",fontWeight:"900",marginTop:12},desc:{fontSize:14,lineHeight:21,color:"#C5D8D1",marginTop:8},descDark:{fontSize:14,lineHeight:22,color:"#53675E"},
 switch:{flexDirection:"row",gap:8,marginBottom:16},card:{padding:20,backgroundColor:"#fff",borderRadius:24,borderWidth:1,borderColor:"#E5EBE7",marginBottom:16},heading:{fontSize:21,fontWeight:"800",color:"#102D26",marginBottom:16},
 input:{borderWidth:1,borderColor:"#DCE5DF",borderRadius:13,padding:14,color:"#173A30",backgroundColor:"#FBFCFB",marginBottom:12,fontSize:15},button:{flex:1,minHeight:48,borderRadius:14,backgroundColor:"#0D735C",alignItems:"center",justifyContent:"center",paddingHorizontal:12,marginTop:8},buttonSecondary:{backgroundColor:"#F0F5F2",borderWidth:1,borderColor:"#DCE8E1"},disabled:{opacity:0.45},buttonText:{color:"#fff",fontSize:14,fontWeight:"800"},buttonSecondaryText:{color:"#175444"},
 label:{fontSize:10,fontWeight:"800",letterSpacing:1,color:"#74857D",marginTop:12,marginBottom:8},stop:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",borderWidth:1,borderColor:"#E0E8E3",borderRadius:12,padding:12,marginBottom:7},selected:{borderColor:"#0D735C",backgroundColor:"#EDF8F2"},stopText:{flex:1,color:"#344B41",fontWeight:"600"},fare:{marginTop:12,marginBottom:10,padding:16,backgroundColor:"#F3F8F4",borderRadius:16},price:{fontSize:28,fontWeight:"900",color:"#0D735C"},
 note:{color:"#175444",backgroundColor:"#E9F8EF",padding:12,borderRadius:10,marginTop:12},small:{fontSize:11,lineHeight:17,color:"#819088",textAlign:"center",marginTop:14},footer:{fontSize:9,fontWeight:"800",letterSpacing:1,color:"#9AA8A1",textAlign:"center",marginTop:12},
 stepper:{flexDirection:"row",alignItems:"center",gap:16},stepButton:{width:34,height:34,borderRadius:10,backgroundColor:"#E9F3ED",alignItems:"center",justifyContent:"center"},stepText:{fontSize:22,color:"#0D735C",fontWeight:"700"},stepValue:{minWidth:20,textAlign:"center",fontSize:16,color:"#102D26",fontWeight:"800"},seatsRow:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginTop:8},loader:{marginTop:12}
});
