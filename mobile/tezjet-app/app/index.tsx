import AsyncStorage from "@react-native-async-storage/async-storage";
import { parseServerFareMoney, formatFareMoney, type FareMoney } from "../lib/fare-money";
import * as Location from "expo-location";
import { io } from "socket.io-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { API, ApiError, errorMessage, request, setApiEndpoint, validateApiEndpoint, type Availability } from "../lib/api";
import { isClosed, isLiveOffer, mergeOrder, mergeOrderSnapshot, nextDriverTripStatus, nextTripLabel, ridePickupLabel, rideDestinationLabel, statusLabels, type RideOrder } from "../lib/orders";
import { registrationFullName } from "../lib/registration";
import OnayAuthScreen from "../components/OnayAuthScreen";
import { onayDark, onayEntryScreen } from "../lib/onay-auth-ui";
import DriverRoutePicker from "../components/DriverRoutePicker";
import PassengerRouteOrder from "../components/PassengerRouteOrder";
import { createPassengerBookingGate } from "../lib/passenger-booking-gate";
import { routeBookingRecoveryKey, saveRouteBookingRecovery, clearRouteBookingRecovery, routeBookingDefinitivelyRejected } from "../lib/passenger-route-orders";
import PassengerDriverCard from "../components/PassengerDriverCard";
import DriverVehicleForm from "../components/DriverVehicleForm";
import DriverHistory from "../components/DriverHistory";
import PassengerHistory from "../components/PassengerHistory";
import type { DriverVehicleSnapshot } from "../lib/driver-vehicle";
import { canBoardLinePassenger, canDepartLine, lineDepartBody, parseLineCollectionState, type LineCollectionState } from "../lib/driver-line";
import { createQueueMutationGuard, driverQueueMembership, parseDriverQueueMembership, type DriverQueueSnapshot } from "../lib/driver-queue";
import { DRIVER_SEATS_MAX_AGE_MS, driverSeatView, parseDriverSeatSnapshot, type DriverSeatSnapshot } from "../lib/driver-free-seats";
import { passengerAvailabilityDisplay, verifiedDriverCount, type PassengerAvailability } from "../lib/passenger-availability";
import { canJoinDriverQueue, driverQueueChoiceInput, driverRouteSessionKey, type DriverQueueContext, type DriverRouteGate } from "../lib/driver-routes";

const TOKEN = "tezjet_access_token";
const API_ENDPOINT = "tezjet_api_endpoint";
type Mode = "passenger" | "driver";
type Stop = { id: string; code: string; name: string; sequence: number; position: number };
type Fare = FareMoney;
type Profile = { id: string; role: string; active_role?: string; roles?: string[]; driver_approval_status?: "pending" | "approved" | "rejected" | "blocked"; full_name?: string; driver_vehicle?: { seat_capacity: number } };

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
  const [surname, setSurname] = useState("");
  const [registering, setRegistering] = useState(false);
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [demoCode, setDemoCode] = useState("");
  const [requested, setRequested] = useState(false);
  const [stops, setStops] = useState<Stop[]>([]);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [fare, setFare] = useState<(Fare & { pickup: string; destination: string }) | null>(null);
  const [address, setAddress] = useState("");
  const [seats, setSeats] = useState(1);
  const [actionBusy, setActionBusy] = useState(false);
  const [vehicleBusySession, setVehicleBusySession] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [driverSeats, setDriverSeats] = useState(3);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [driverInQueue, setDriverInQueue] = useState(false);
  const [driverQueueContext, setDriverQueueContext] = useState<DriverQueueContext | null>(null);
  const [lineState, setLineState] = useState<LineCollectionState | null>(null);
  const [queueSnapshot, setQueueSnapshot] = useState<DriverQueueSnapshot | null>(null);
  const queueSnapshotRef = useRef<DriverQueueSnapshot | null>(null);
  const [departureConfirmation, setDepartureConfirmation] = useState<{ sessionKey: string; enrollmentId: string } | null>(null);
  const [driverRouteGate, setDriverRouteGate] = useState<DriverRouteGate>({ sessionKey: "", ready: false, hasChoice: false, mutating: false });
  const driverRouteGateRef = useRef(driverRouteGate);
  const updateDriverRouteGate = useCallback((next: DriverRouteGate) => {
    driverRouteGateRef.current = next;
    setDriverRouteGate(next);
  }, []);
  const [socketConnected, setSocketConnected] = useState(false);
  const [incomingOrder, setIncomingOrder] = useState<RideOrder | null>(null);
  const [orders, setOrders] = useState<RideOrder[]>([]);
  const [driverSeatSnapshot, setDriverSeatSnapshot] = useState<DriverSeatSnapshot | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [dataError, setDataError] = useState("");
  const [routeError, setRouteError] = useState("");
  const [availabilityError, setAvailabilityError] = useState("");
  const [profileRefresh, setProfileRefresh] = useState(0);
  const [availability, setAvailability] = useState<PassengerAvailability | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);
  const [now, setNow] = useState(Date.now());
  const activeRole = profile?.active_role ?? profile?.role;
  const currentToken = useRef(token);
  currentToken.current = token;
  const driverRouteSession = driverRouteSessionKey(apiBase, token);
  const [, updateBookingAdmission] = useState(0);
  const bookingGate = useMemo(() => createPassengerBookingGate(() => updateBookingAdmission(value => value + 1)), [driverRouteSession]);
  const availabilityGeneration = useRef(0);
  const ordersRequestInFlight = useRef<string | null>(null);
  const trackedOrders = useRef<RideOrder[]>([]);
  const orderRevision = useRef(0);
  const orderChanges = useRef(new Map<string, number>());
  const queueRevision = useRef(0);
  // Position events do not prove that an enrollment was removed. Local write
  // acknowledgements invalidate older GET snapshots independently of sockets.
  const queueEnrollmentRevision = useRef(0);
  const queuePresenceRevision = useRef(0);
  const queueMutationGuard = useRef(createQueueMutationGuard());
  const seatRevision = useRef(0);
  const invalidateDriverSeats = useCallback(() => {
    seatRevision.current++;
    setDriverSeatSnapshot(null);
  }, []);
  // Invalidate synchronously at both ends of a mutation: a GET received during
  // a lost or delayed write cannot become visible when the action finishes.
  const setBusy = useCallback((value: boolean) => { invalidateDriverSeats(); setActionBusy(value); }, [invalidateDriverSeats]);
  const updateQueueSnapshot = useCallback((next: DriverQueueSnapshot | null, acknowledgedWrite = false) => {
    if (acknowledgedWrite) { queueEnrollmentRevision.current += 1; invalidateDriverSeats(); }
    queueSnapshotRef.current = next;
    setQueueSnapshot(next);
  }, [invalidateDriverSeats]);
  const applyOrder = useCallback((incoming: RideOrder) => {
    invalidateDriverSeats();
    orderChanges.current.set(incoming.id, ++orderRevision.current);
    trackedOrders.current = mergeOrder(trackedOrders.current, incoming);
    bookingGate.setActiveOrder(trackedOrders.current.some(order => order.passenger_id === profile?.id && !isClosed(order)));
    setOrders(trackedOrders.current);
  }, [bookingGate, profile?.id, invalidateDriverSeats]);
  const driverApproved = activeRole === "driver" && profile?.driver_approval_status === "approved";
  const busy = actionBusy || vehicleBusySession === driverRouteSession;
  const vehicleBusyChange = useCallback((value: boolean) => {
    invalidateDriverSeats();
    setVehicleBusySession(previous => value ? driverRouteSession : previous === driverRouteSession ? null : previous);
  }, [driverRouteSession, invalidateDriverSeats]);
  const queueMembership = driverQueueMembership(queueSnapshot, driverRouteSession);
  const freeSeats = driverSeatView(driverSeatSnapshot, { sessionKey: driverRouteSession, driverId: profile?.id ?? "", revision: seatRevision.current }, now, queueMembership);
  const canJoinQueue = canJoinDriverQueue(driverRouteGate, driverRouteSession);
  const maxDriverSeats = profile?.driver_vehicle?.seat_capacity ?? 8;
  const vehicleSaved = useCallback((value: DriverVehicleSnapshot) => {
    setProfile(current => current ? { ...current, driver_approval_status: value.approval_status, driver_vehicle: value.driver_vehicle ?? undefined } : current);
  }, []);
  useEffect(() => { if (queueMembership === "absent") setDriverSeats(value => Math.min(value, maxDriverSeats)); }, [maxDriverSeats, queueMembership]);
  const activeDriverOrders = orders.filter(order => !isClosed(order) && order.driver_id === profile?.id);
  const passengerOrders = orders.filter(order => order.passenger_id === profile?.id);
  const passengerHasActiveOrder = passengerOrders.some(order => !isClosed(order));
  const availabilityFresh = availability?.pickup === a && availability?.seats === seats && now >= availability.checkedAt && now - availability.checkedAt < 15_000;
  const availabilityDisplay = passengerAvailabilityDisplay({ availability, pickup: a, seats, now, checking: checkingAvailability, error: availabilityError });
  const canOrder = activeRole === "passenger" && availabilityFresh && availability?.available === true;
  const fareFresh = fare?.pickup === a && fare?.destination === b;
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
            setEndpointError(errorMessage(e, "Проверь адрес сервера Onay."));
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
    updateQueueSnapshot(null, true); setDepartureConfirmation(null);
    setToken(""); setProfile(null); setOrders([]); setIncomingOrder(null);
    setProfileLoading(false); setProfileError("");
    setStops([]); setFare(null); setAvailability(null); setQueuePosition(null); setDriverInQueue(false); setDriverQueueContext(null); setLineState(null);
    setDataError(""); setRouteError(""); setAvailabilityError("");
    try { await AsyncStorage.removeItem(TOKEN); return true; }
    catch { setProfileError("Не удалось удалить сохранённый вход на устройстве. Попробуй выйти ещё раз."); return false; }
  }, [updateQueueSnapshot]);

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
    if (!token) { setProfile(null); setStops([]); setFare(null); setProfileLoading(false); return; }
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
    if (!token || activeRole !== "passenger") { setStops([]); setFare(null); return; }
    let active = true;
    request<{ stops: Stop[] }>("/api/fares/stops?route_id=pyatak", token)
      .then(route => {
        if (!active) return;
        const list = route.stops || [];
        setRouteError("");
        setStops(list);
        const pickups = list.filter(stop => stop.code === "C" || stop.code === "D");
        if (pickups.length) {
          setA(value => pickups.some(stop => stop.code === value) ? value : pickups[0].code);
          setB(value => list.some(stop => stop.code === value) ? value : (list.find(stop => stop.code !== pickups[0].code)?.code ?? ""));
        } else { setA(""); setB(""); setRouteError("На маршруте нет доступных точек подачи C или D."); }
      })
      .catch(e => { if (active) setRouteError(errorMessage(e, "Не удалось загрузить маршрут.")); });
    return () => { active = false; };
  }, [token, activeRole, profileRefresh]);

  useEffect(() => {
    if (!token || activeRole !== "passenger" || !a || !b || a === b) { setFare(null); return; }
    let active = true;
    setFare(null);
    request<{ fare: unknown }>("/api/fares/estimate", token, { method: "POST", body: JSON.stringify({ route_id: "pyatak", pickup_stop: a, destination_stop: b }) })
      .then(r => { if (active) { setFare({ ...parseServerFareMoney(r.fare), pickup: a, destination: b }); setRouteError(""); } })
      .catch(e => { if (active) { setFare(null); setRouteError(errorMessage(e, "Не удалось рассчитать цену.")); } });
    return () => { active = false; };
  }, [token, activeRole, a, b, profileRefresh]);

  const refreshOrders = useCallback(async function readOrders(): Promise<void> {
    if (!token || !profile?.id || (activeRole !== "passenger" && !driverApproved)) return;
    if (currentToken.current !== token || API !== apiBase) return;
    if (ordersRequestInFlight.current === token) return;
    ordersRequestInFlight.current = token;
    const bookingReadRevision = bookingGate.beginOrdersRead();
    const revisionAtStart = orderRevision.current;
    const queueRevisionAtStart = queueRevision.current;
    const enrollmentRevisionAtStart = queueEnrollmentRevision.current;
    const presenceRevisionAtStart = queuePresenceRevision.current;
    const seatRevisionAtStart = seatRevision.current;
    let queueReceivedAt: number | undefined;
    const results = await Promise.allSettled([
      request<{ orders: RideOrder[] }>("/api/orders", token),
      driverApproved ? request<{ your_position: number | null; your_entry: { routeContext?: DriverQueueContext; collectionState?: unknown } | null }>("/api/queue", token).then(value => { queueReceivedAt = Date.now(); return value; }) : Promise.resolve(undefined),
    ]);
    const ordersResult = results[0];
    const queueResult = results[1];
    if (ordersRequestInFlight.current === token) ordersRequestInFlight.current = null;
    if (currentToken.current !== token || API !== apiBase) return;
    if (ordersResult.status === "fulfilled" && ordersResult.value) {
      const list = (ordersResult.value as { orders: RideOrder[] }).orders || [];
      const changedAfterRequest = new Set([...orderChanges.current].filter(([, revision]) => revision > revisionAtStart).map(([id]) => id));
      trackedOrders.current = mergeOrderSnapshot(trackedOrders.current, list, changedAfterRequest);
      bookingGate.applyOrdersSnapshot(bookingReadRevision, trackedOrders.current.some(order => order.passenger_id === profile.id && !isClosed(order)));
      setOrders(trackedOrders.current);
      if (driverApproved) {
        setIncomingOrder(trackedOrders.current.find(order => isLiveOffer(order, profile.id)) ?? null);
      }
    }
    if (queueResult.status === "fulfilled" && queueResult.value && queueEnrollmentRevision.current === enrollmentRevisionAtStart) {
      try {
        const membership = parseDriverQueueMembership(queueResult.value);
        const line = parseLineCollectionState(queueResult.value.your_entry);
        // An older GET cannot erase a newer positive socket proof. Enrolled
        // snapshots may still hydrate the line receipt after a position event.
        if (membership !== "absent" || queuePresenceRevision.current === presenceRevisionAtStart) {
          updateQueueSnapshot({ sessionKey: driverRouteSessionKey(apiBase, token), membership });
          setLineState(line);
          if (queueRevision.current === queueRevisionAtStart) {
            const position = queueResult.value.your_position;
            setQueuePosition(position); setDriverInQueue(position !== null);
            setDriverQueueContext(queueResult.value.your_entry?.routeContext ?? null);
          }
          setRouteError("");
          if (seatRevision.current === seatRevisionAtStart && queueReceivedAt !== undefined) {
            try {
              setDriverSeatSnapshot(parseDriverSeatSnapshot(queueResult.value, { sessionKey: driverRouteSessionKey(apiBase, token), driverId: profile.id, revision: seatRevisionAtStart }, queueReceivedAt));
              setNow(Date.now());
            } catch { setDriverSeatSnapshot(null); }
          }
        }
      } catch {
        updateQueueSnapshot({ sessionKey: driverRouteSessionKey(apiBase, token), membership: "unknown" });
        setLineState(null); setRouteError("Не удалось подтвердить состояние очереди. Повтори обновление.");
        if (seatRevision.current === seatRevisionAtStart) setDriverSeatSnapshot(null);
      }
    }
    if (driverApproved && (queueResult.status === "rejected" || !queueResult.value) && seatRevision.current === seatRevisionAtStart) setDriverSeatSnapshot(null);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") {
      setDataError(errorMessage(failed.reason, "Не удалось обновить заказы."));
      if (results.some(result => result.status === "rejected" && result.reason instanceof ApiError && result.reason.status === 401)) await clearSession();
    } else setDataError("");
    // Coalesce events into one fresh follow-up after an older pair settles.
    // Never accept an old queue receipt or wait for the next ten-second poll.
    if (driverApproved && currentToken.current === token && API === apiBase &&
      (seatRevision.current !== seatRevisionAtStart || (queueReceivedAt !== undefined && Date.now() - queueReceivedAt >= DRIVER_SEATS_MAX_AGE_MS))) void readOrders();
  }, [token, apiBase, profile?.id, activeRole, driverApproved, clearSession, updateQueueSnapshot, bookingGate]);

  useEffect(() => { if (driverApproved && !busy) void refreshOrders(); }, [busy, driverApproved, refreshOrders]);

  const refreshAvailability = useCallback(async () => {
    if (!token || activeRole !== "passenger" || !a) return null;
    const generation = ++availabilityGeneration.current;
    setCheckingAvailability(true);
    try {
      const result = await request<Availability>(`/api/orders/availability?pickup_point=${encodeURIComponent(a)}&seats=${seats}`, token);
      if (typeof result?.available !== "boolean") throw new ApiError("Не удалось проверить наличие водителей. Повтори обновление.", undefined, "INVALID_RESPONSE");
      if (currentToken.current !== token) return null;
      if (availabilityGeneration.current === generation) {
        setAvailability({ pickup: a, seats, available: result.available === true,
          eligibleDriverCount: verifiedDriverCount(result.eligible_driver_count), checkedAt: Date.now() });
        setAvailabilityError("");
      }
      return result.available === true;
    } catch (e) {
      if (currentToken.current === token && availabilityGeneration.current === generation) {
        setAvailability(null);
        setAvailabilityError(errorMessage(e, "Не удалось проверить наличие водителей."));
        if (e instanceof ApiError && e.status === 401) await clearSession();
      }
      return null;
    } finally { if (availabilityGeneration.current === generation) setCheckingAvailability(false); }
  }, [token, apiBase, activeRole, a, seats, clearSession]);

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
    socket.on("disconnect", () => { setSocketConnected(false); invalidateDriverSeats(); });
    socket.on("connect_error", () => { setSocketConnected(false); invalidateDriverSeats(); });
    socket.on("incoming_order", (payload: { order?: RideOrder }) => {
      if (!driverApproved || !payload.order || currentToken.current !== token) return;
      applyOrder(payload.order);
      const latest = trackedOrders.current.find(order => order.id === payload.order?.id);
      if (latest && isLiveOffer(latest, profile.id)) setIncomingOrder(latest);
      void refreshOrders();
    });
    socket.on("order:offer_withdrawn", (payload: { order_id?: string; order?: RideOrder }) => {
      if (currentToken.current !== token) return;
      const orderId = payload.order_id ?? payload.order?.id;
      if (!payload.order) invalidateDriverSeats();
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
      if (driverApproved) void refreshOrders();
    });
    socket.on("queue:position", (payload: { position?: number | null; route_context?: DriverQueueContext | null }) => {
      if (!driverApproved || currentToken.current !== token) return;
      invalidateDriverSeats();
      queueRevision.current += 1;
      setQueuePosition(payload.position ?? null);
      setDriverInQueue(payload.position != null);
      setDriverQueueContext(payload.route_context ?? null);
      if (payload.position != null || payload.route_context != null) {
        queuePresenceRevision.current += 1;
        updateQueueSnapshot({ sessionKey: driverRouteSessionKey(apiBase, token), membership: "enrolled" });
      }
      void refreshOrders();
    });
    socket.on("queue:update", () => { void availabilityRef.current(); if (driverApproved) { invalidateDriverSeats(); void refreshOrders(); } });
    return () => { socket.disconnect(); setSocketConnected(false); };
  }, [token, apiBase, profile?.id, activeRole, driverApproved, refreshOrders, applyOrder, updateQueueSnapshot, invalidateDriverSeats]);

  async function login(verify: boolean) {
    const fullName = registering ? registrationFullName(name, surname) : null;
    if (registering && !fullName) {
      Alert.alert("Имя и фамилия", "Укажи имя и фамилию. Общая длина — не более 120 символов.");
      return;
    }
    setBusy(true);
    try {
      const r = await request<{ access_token?: string; demo_code?: string }>(verify ? "/api/auth/verify-otp" : "/api/auth/request-otp", undefined, {
        method: "POST",
        body: JSON.stringify({ phone_number: phone.trim(), ...(registering ? { full_name: fullName } : {}), code: otp.trim(), role: mode, locale: "ru" })
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
      updateQueueSnapshot(null, true); setDepartureConfirmation(null);
      setOrders([]); setIncomingOrder(null); setQueuePosition(null); setDriverInQueue(false); setDriverQueueContext(null); setLineState(null); setAvailability(null); setFare(null);
      setRequested(false); setOtp(""); setDemoCode(""); setMessage(""); setDataError("");
      try { await AsyncStorage.setItem(TOKEN, result.access_token); }
      catch { setProfileError("Вход выполнен, но не сохранён на устройстве. При следующем запуске потребуется код."); }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) await clearSession();
      Alert.alert("Режим Onay", e instanceof ApiError && e.code === "ROLE_BUSY" ? "Сначала заверши или отмени поездку. Водителю также нужно выйти из очереди." : errorMessage(e, "Не удалось переключить режим."));
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
    const from = stops.find(v => v.code === a), to = stops.find(v => v.code === b);
    if (!from || !to || a === b) return Alert.alert("Маршрут", "Выбери разные точки А и Б.");
    if (!fareFresh) return Alert.alert("Стоимость", "Дождись расчёта стоимости выбранного маршрута.");
    if (busy || activeRole !== "passenger" || passengerHasActiveOrder || !bookingGate.tryStart("legacy")) return;
    const requestToken = token, requestEndpoint = apiBase;
    const recoveryKey = routeBookingRecoveryKey(requestEndpoint, profile!.id);
    let recoveryPrepared = false, postStarted = false;
    setBusy(true);
    try {
      const available = await refreshAvailability();
      if (available !== true) {
        if (available === false) setMessage("Водителей пока нет. Попробуй проверить наличие позже.");
        else Alert.alert("Связь с Onay", "Не удалось проверить наличие водителей. Проверь интернет и повтори попытку.");
        return;
      }
      const coords = await getCoordinates();
      if (currentToken.current !== requestToken || API !== requestEndpoint) return;
      // Both booking forms share this durable record. Legacy has no request-key
      // receipt API: an uncertain POST remains fail-closed, never guessed from404.
      recoveryPrepared = true;
      await saveRouteBookingRecovery(AsyncStorage, recoveryKey, { status: "in_flight", orderId: null });
      bookingGate.recoveryChanged();
      if (currentToken.current !== requestToken || API !== requestEndpoint) throw new Error("Подключение изменилось до отправки заказа.");
      postStarted = true;
      const r = await request<{ order: RideOrder; offer?: unknown }>("/api/orders", requestToken, { method: "POST", body: JSON.stringify({
        route_id: "pyatak", pickup_point: from.code, pickup_stop: from.code, destination_stop: to.code,
        pickup_location: coords, pickup_address: address.trim() || from.name, destination: to.name, seats
      }) });
      bookingGate.setActiveOrder(true);
      await saveRouteBookingRecovery(AsyncStorage, recoveryKey, { status: "confirmed", orderId: r.order.id });
      bookingGate.recoveryChanged();
      if (currentToken.current !== requestToken || API !== requestEndpoint) return;
      applyOrder(r.order);
      setMessage(r.offer ? "Заказ отправлен водителю. Ждём подтверждения." : "Заказ создан. Ищем водителя.");
      await refreshOrders();
    } catch (e) {
      const rejected = postStarted && e instanceof ApiError && routeBookingDefinitivelyRejected(e);
      if (recoveryPrepared && (!postStarted || rejected)) {
        try { await clearRouteBookingRecovery(AsyncStorage, recoveryKey); } catch { /* Keep admission closed until storage can be read. */ }
        bookingGate.recoveryChanged();
      }
      if (currentToken.current !== requestToken || API !== requestEndpoint) return;
      if (e instanceof ApiError && e.code === "NO_DRIVERS") {
        setAvailability({ pickup: a, seats, available: false, eligibleDriverCount: 0, checkedAt: Date.now() });
        setMessage("Водителей пока нет. Заказ не создан. Проверь наличие позже.");
      } else {
        Alert.alert("Заказ", postStarted && !rejected
          ? "Не удалось подтвердить результат заказа. Проверь его статус; повторное оформление заблокировано."
          : errorMessage(e, "Не удалось создать заказ."));
        await refreshOrders();
      }
    } finally { bookingGate.finish("legacy"); setBusy(false); }
  }

  async function refreshProfile() {
    if (!token) return;
    const requestToken = token;
    setBusy(true);
    try {
      const me = await request<{ user: Profile }>("/api/auth/me", requestToken);
      if (currentToken.current !== requestToken) return;
      setProfile(me.user); setProfileError(""); setProfileRefresh(value => value + 1);
      Alert.alert("Статус профиля", me.user.driver_approval_status === "approved" ? "Водительский профиль подтверждён." : me.user.driver_approval_status === "blocked" ? "Работа водителем заблокирована администратором." : me.user.driver_approval_status === "rejected" ? "Водительский профиль отклонён." : "Профиль ожидает подтверждения администратора.");
    } catch (e) {
      if (currentToken.current !== requestToken) return;
      if (e instanceof ApiError && e.status === 401) await clearSession();
      Alert.alert("Профиль", errorMessage(e, "Не удалось обновить статус."));
    } finally { setBusy(false); }
  }

  async function joinQueue() {
    const requestToken = token;
    const requestSession = driverRouteSession;
    if (busy || driverQueueMembership(queueSnapshotRef.current, requestSession) !== "absent" ||
        incomingOrder || activeDriverOrders.length || !canJoinDriverQueue(driverRouteGateRef.current, requestSession)) return;
    const routeChoice = driverQueueChoiceInput(driverRouteGateRef.current, requestSession);
    if (!queueMutationGuard.current.tryStart()) return;
    setBusy(true);
    try {
      const location = await getCoordinates();
      if (currentToken.current !== requestToken || !canJoinDriverQueue(driverRouteGateRef.current, requestSession) ||
          JSON.stringify(driverQueueChoiceInput(driverRouteGateRef.current, requestSession)) !== JSON.stringify(routeChoice)) return;
      const queueRevisionAtStart = queueRevision.current;
      const result = await request<{ position: number | null; entry?: { routeContext?: DriverQueueContext } }>("/api/queue/join", requestToken, { method: "POST", body: JSON.stringify({ location, available_seats: driverSeats, route_choice: routeChoice }) });
      if (currentToken.current !== requestToken) return;
      updateQueueSnapshot({ sessionKey: requestSession, membership: "enrolled" }, true);
      setLineState(parseLineCollectionState(result.entry));
      if (queueRevision.current === queueRevisionAtStart) {
        queueRevision.current += 1;
        setQueuePosition(result.position); setDriverInQueue(result.position !== null);
        setDriverQueueContext(result.entry?.routeContext ?? null);
      }
      await refreshOrders();
      Alert.alert("Onay Driver", `Ты в очереди. Позиция: ${result.position ?? "обновляется"}.`);
    } catch (e) {
      if (currentToken.current === requestToken) {
        updateQueueSnapshot({ sessionKey: requestSession, membership: "unknown" }, true);
        await refreshOrders();
        Alert.alert("Не удалось встать в очередь", e instanceof Error ? e.message : "Проверь геолокацию и доступность.");
      }
    }
    finally { queueMutationGuard.current.finish(); setBusy(false); }
  }

  async function joinLine() {
    const requestToken = token;
    const requestSession = driverRouteSession;
    const gate = driverRouteGateRef.current;
    if (busy || driverQueueMembership(queueSnapshotRef.current, requestSession) !== "absent" || lineState || incomingOrder || activeDriverOrders.length > 0 ||
        !canJoinDriverQueue(gate, requestSession) || !gate.hasChoice) return;
    const routeChoice = driverQueueChoiceInput(gate, requestSession);
    if (!routeChoice || !queueMutationGuard.current.tryStart()) return;
    setBusy(true);
    try {
      const location = await getCoordinates();
      const refreshedGate = driverRouteGateRef.current;
      if (currentToken.current !== requestToken || !canJoinDriverQueue(refreshedGate, requestSession) ||
          JSON.stringify(driverQueueChoiceInput(refreshedGate, requestSession)) !== JSON.stringify(routeChoice)) return;
      const queueRevisionAtStart = queueRevision.current;
      const result = await request<{ position: number | null; entry: {
        routeContext?: DriverQueueContext; collectionState?: unknown;
      } }>("/api/queue/line", requestToken, { method: "POST",
        body: JSON.stringify({ location, available_seats: driverSeats, route_choice: routeChoice }) });
      if (currentToken.current !== requestToken) return;
      const enrolled = parseLineCollectionState(result.entry);
      if (!enrolled || enrolled.phase !== "collecting") throw new Error("Сервер не подтвердил начало сбора пассажиров.");
      updateQueueSnapshot({ sessionKey: requestSession, membership: "enrolled" }, true);
      setLineState(enrolled); setDepartureConfirmation(null);
      if (queueRevision.current === queueRevisionAtStart) {
        queueRevision.current += 1;
        setQueuePosition(result.position); setDriverInQueue(result.position !== null);
        setDriverQueueContext(result.entry?.routeContext ?? null);
      }
      await refreshOrders();
      Alert.alert("Сбор пассажиров", "Линия активна. Можно принимать пассажиров до отправления.");
    } catch (e) {
      if (currentToken.current === requestToken) {
        updateQueueSnapshot({ sessionKey: requestSession, membership: "unknown" }, true);
        await refreshOrders();
        Alert.alert("Сбор пассажиров", errorMessage(e, "Не удалось начать сбор пассажиров."));
      }
    }
    finally { queueMutationGuard.current.finish(); setBusy(false); }
  }

  async function boardLinePassenger(order: RideOrder) {
    if (busy || !canBoardLinePassenger(lineState, order) || order.driver_id !== profile?.id) return;
    const requestToken = token;
    setBusy(true);
    try {
      const result = await request<{ order: RideOrder }>(`/api/orders/${order.id}/board`, requestToken,
        { method: "POST", body: JSON.stringify({}) });
      if (currentToken.current !== requestToken) return;
      applyOrder(result.order);
      await refreshOrders();
    } catch (e) {
      Alert.alert("Посадка пассажира", errorMessage(e, "Не удалось подтвердить посадку."));
      await refreshOrders();
    } finally { setBusy(false); }
  }

  function confirmLineDeparture() {
    if (busy || incomingOrder || queueMembership !== "enrolled" || !canDepartLine(lineState)) return;
    const receipt = lineDepartBody(lineState);
    setDepartureConfirmation({ sessionKey: driverRouteSession, enrollmentId: receipt.expected_enrollment_id });
  }

  async function departLine(enrollmentId: string) {
    if (busy || incomingOrder || queueMembership !== "enrolled" || !canDepartLine(lineState) || lineState?.enrollmentId !== enrollmentId ||
        departureConfirmation?.sessionKey !== driverRouteSession || departureConfirmation.enrollmentId !== enrollmentId ||
        !queueMutationGuard.current.tryStart()) return;
    const requestToken = token;
    setBusy(true);
    try {
      const result = await request<{ entry: { collectionState?: unknown }; orders: RideOrder[] }>(
        "/api/queue/depart", requestToken, { method: "POST",
          body: JSON.stringify({ expected_enrollment_id: enrollmentId }) });
      if (currentToken.current !== requestToken) return;
      queueRevision.current += 1;
      updateQueueSnapshot({ sessionKey: driverRouteSession, membership: "enrolled" }, true);
      setDepartureConfirmation(null);
      setLineState(parseLineCollectionState(result.entry));
      setDriverInQueue(false); setQueuePosition(null);
      for (const order of result.orders ?? []) applyOrder(order);
      await refreshOrders();
      Alert.alert("Линия", "Отправление подтверждено сервером.");
    } catch (e) {
      Alert.alert("Отправление", errorMessage(e, "Не удалось отправиться. Обнови очередь."));
      await refreshOrders();
    } finally { queueMutationGuard.current.finish(); setBusy(false); }
  }

  async function updateDriverLocation() {
    const requestToken = token, requestSession = driverRouteSession;
    if (busy || driverQueueMembership(queueSnapshotRef.current, requestSession) !== "enrolled" ||
        !queueMutationGuard.current.tryStart()) return;
    setBusy(true);
    try {
      const location = await getCoordinates();
      if (currentToken.current !== requestToken || driverRouteGateRef.current.sessionKey !== requestSession) return;
      await request("/api/queue/location", requestToken, { method: "PATCH", body: JSON.stringify({ location }) });
      if (currentToken.current !== requestToken) return;
      Alert.alert("Местоположение обновлено", "Координаты переданы Onay.");
    } catch (e) { Alert.alert("Геолокация водителя", e instanceof Error ? e.message : "Не удалось обновить координаты."); }
    finally { queueMutationGuard.current.finish(); setBusy(false); }
  }

  async function leaveQueue() {
    const requestToken = token;
    const requestSession = driverRouteSession;
    if (busy || incomingOrder || activeDriverOrders.length ||
        driverQueueMembership(queueSnapshotRef.current, requestSession) !== "enrolled" ||
        !queueMutationGuard.current.tryStart()) return;
    setBusy(true);
    try {
      await request<void>("/api/queue/leave", requestToken, { method: "DELETE" });
      if (currentToken.current !== requestToken) return;
      queueRevision.current += 1;
      updateQueueSnapshot({ sessionKey: requestSession, membership: "absent" }, true);
      setDepartureConfirmation(null);
      setQueuePosition(null); setDriverInQueue(false); setDriverQueueContext(null); setLineState(null);
    } catch (e) { Alert.alert("Очередь", e instanceof Error ? e.message : "Не удалось выйти из очереди."); }
    finally { queueMutationGuard.current.finish(); setBusy(false); }
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
    const next = nextDriverTripStatus(lineState?.phase ?? null, activeOrder);
    if (!next) return;
    setBusy(true);
    try {
      const result = await request<{ order: RideOrder }>(`/api/orders/${activeOrder.id}/status`, token, { method: "PATCH", body: JSON.stringify({ status: next }) });
      applyOrder(result.order);
      await refreshOrders();
    } catch (e) { Alert.alert("Статус поездки", e instanceof Error ? e.message : "Не удалось обновить поездку."); }
    finally { setBusy(false); }
  }

  // Auth UI is native React Native; the original backend OTP flow remains in login().
  // Do not hide the existing API setup and session-recovery screens.
  const entryScreen = onayEntryScreen({ sessionLoading, token, apiBase, showEndpointSettings });
  if (entryScreen === "loading") {
    return <View style={{ flex: 1, backgroundColor: onayDark.background, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator color={onayDark.accent} />
      <Text style={{ color: onayDark.muted, marginTop: 12 }}>Восстанавливаем вход…</Text>
    </View>;
  }
  if (entryScreen === "auth") {
    return <OnayAuthScreen
      mode={mode}
      registering={registering}
      requested={requested}
      busy={busy || sessionLoading}
      phone={phone}
      name={name}
      surname={surname}
      otp={otp}
      demoCode={demoCode}
      error={profileError}
      onPhone={setPhone}
      onName={setName}
      onSurname={setSurname}
      onOtp={setOtp}
      onRegisterMode={(value) => { setRegistering(value); setRequested(false); setOtp(""); setDemoCode(""); }}
      onMode={(value) => { void switchMode(value); }}
      onBackToPhone={() => { setRequested(false); setOtp(""); setDemoCode(""); }}
      onSubmit={(verify) => { void login(verify); }}
      onServerSettings={() => setShowEndpointSettings(true)}
    />;
  }

  return <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <View style={s.header}><Text style={s.logo}>O</Text><View style={s.brandWrap}><Text style={s.brand}>Onay</Text><Text style={s.tag}>ТВОЙ ГОРОД. ТВОЙ МАРШРУТ.</Text></View>{token ? <Pressable onPress={logout} disabled={busy}><Text style={s.logout}>Выйти</Text></Pressable> : null}</View>
    <View style={s.hero}><Text style={s.kicker}>ОДНО ПРИЛОЖЕНИЕ · ANDROID + IOS</Text><Text style={s.title}>{mode === "passenger" ? "Куда едем?" : "Onay Driver"}</Text><Text style={s.desc}>{mode === "passenger" ? "Выбери маршрут — остальное сделает Onay." : "Подтверждённый водитель может встать в очередь и получать подходящие заказы."}</Text></View>
    <View style={s.switch}><Button title="Пассажир" onPress={() => switchMode("passenger")} disabled={busy || profileLoading} secondary={mode !== "passenger"} /><Button title="Водитель" onPress={() => switchMode("driver")} disabled={busy || profileLoading} secondary={mode !== "driver"} /></View>
    {showEndpointSettings ? <View style={s.card}><Text style={s.heading}>Сервер Onay</Text><Text style={s.descDark}>Укажи адрес сервера для подключения. При смене сервера потребуется вход по телефону.</Text><TextInput style={s.input} value={endpointInput} onChangeText={setEndpointInput} placeholder="https://api.onay…" autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy && !sessionLoading} />{endpointError ? <Text style={s.note}>{endpointError}</Text> : null}<Button title="Сохранить сервер" onPress={saveEndpoint} disabled={busy || sessionLoading || !endpointInput.trim()} />{apiBase ? <Button title="Закрыть настройки" onPress={() => setShowEndpointSettings(false)} secondary disabled={busy} /> : null}</View> : <Button title="Настройки сервера" onPress={() => setShowEndpointSettings(true)} secondary disabled={busy || sessionLoading} />}
    {visibleError ? <View style={s.card}><Text style={s.heading}>Нет актуальных данных</Text><Text style={s.descDark}>{visibleError}</Text><Button title="Повторить обновление" onPress={() => { void refreshOrders(); void refreshAvailability(); setProfileRefresh(value => value + 1); }} secondary disabled={busy} /></View> : null}

    {token && profile && activeRole === "driver" && mode === "driver" ? <DriverVehicleForm key={driverRouteSession} endpoint={apiBase} token={token} blocked={busy || queueMembership === "enrolled" || !!incomingOrder || activeDriverOrders.length > 0} onBusyChange={vehicleBusyChange} onSaved={vehicleSaved} /> : null}
    {sessionLoading ? <View style={s.card}><ActivityIndicator color="#0D735C" /><Text style={s.descDark}>Восстанавливаем вход…</Text></View> : !token ? <View style={s.card}>
      <Text style={s.heading}>{registering ? (mode === "driver" ? "Регистрация водителя" : "Регистрация пассажира") : "Вход по телефону"}</Text>
      <View style={s.switch}>
        <Button title="Войти" onPress={() => { setRegistering(false); setRequested(false); setOtp(""); setDemoCode(""); }} secondary={registering} disabled={busy} testID="auth-signin-mode" />
        <Button title="Регистрация" onPress={() => { setRegistering(true); setRequested(false); setOtp(""); setDemoCode(""); }} secondary={!registering} disabled={busy} testID="auth-signup-mode" />
      </View>
      {registering ? <>
        <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Имя" autoCapitalize="words" autoCorrect={false} editable={!busy && !requested} testID="registration-given-name" />
        <TextInput style={s.input} value={surname} onChangeText={setSurname} placeholder="Фамилия" autoCapitalize="words" autoCorrect={false} editable={!busy && !requested} testID="registration-family-name" />
      </> : <Text style={s.note}>Первый раз в Onay? Выбери «Регистрация».</Text>}
      <TextInput style={s.input} value={phone} onChangeText={setPhone} placeholder="+998 90 123 45 67" keyboardType="phone-pad" editable={!busy && !requested} />
      {requested ? <>{demoCode ? <Text style={s.note}>Тестовый код: {demoCode}</Text> : <Text style={s.note}>Введи код подтверждения, полученный через настроенный сервис авторизации.</Text>}<TextInput style={s.input} value={otp} onChangeText={setOtp} placeholder="Код подтверждения" keyboardType="number-pad" /><Button title={busy ? "Проверяем…" : mode === "driver" ? "Продолжить как водитель" : "Войти как пассажир"} onPress={() => login(true)} disabled={busy || !apiBase || !otp.trim()} /></> : <Button title={busy ? "Отправляем…" : "Получить код"} onPress={() => login(false)} disabled={busy || !apiBase || !phone.trim() || (registering && !registrationFullName(name, surname))} />}
      {profileError ? <Text style={s.note}>{profileError}</Text> : null}
      {busy ? <ActivityIndicator style={s.loader} color="#0D735C" /> : null}
      {mode === "driver" ? <Text style={s.small}>Новый водительский профиль будет ожидать подтверждения администратора. До подтверждения заказы недоступны.</Text> : null}
    </View> : !profile ? <View style={s.card}><Text style={s.heading}>{profileLoading ? "Загружаем профиль…" : "Нет связи с профилем"}</Text>{profileLoading ? <ActivityIndicator color="#0D735C" /> : null}<Text style={s.descDark}>{profileError || "Вход сохранён. Подключись к Onay, чтобы продолжить."}</Text><Button title="Повторить" onPress={() => setProfileRefresh(value => value + 1)} disabled={profileLoading} secondary /></View> : mode === "driver" ? (
      activeRole !== "driver" ? <View style={s.card}><Text style={s.heading}>Переключение режима</Text><Text style={s.descDark}>Подключи водительский профиль к своему аккаунту.</Text><Button title="Войти в режим водителя" onPress={() => switchMode("driver")} disabled={busy} /></View>
      : profile.driver_approval_status !== "approved" ? <View style={s.card}><Text style={s.heading}>{profile.driver_approval_status === "blocked" ? "Профиль заблокирован" : profile.driver_approval_status === "rejected" ? "Профиль отклонён" : "Профиль на проверке"}</Text><Text style={s.descDark}>{profile.driver_approval_status === "blocked" ? "Работа водителем заблокирована администратором. Изменение автомобиля не снимает блокировку." : profile.driver_approval_status === "rejected" ? "Свяжись с поддержкой Onay, чтобы узнать причину." : "Администратор должен подтвердить водительский профиль. До этого нельзя вставать в очередь или принимать заказы."}</Text><Button title="Проверить статус" onPress={refreshProfile} secondary disabled={busy} /></View>
      : <>
        <DriverRoutePicker key={driverRouteSession} endpoint={apiBase} token={token} busy={busy} queued={queueMembership !== "absent"}
          activeTrip={activeDriverOrders.length > 0} pendingOffer={!!incomingOrder} onStatusChange={updateDriverRouteGate} />
        <View style={s.card}>
          <Text style={s.heading}>Рабочая смена</Text>
          <Text style={s.descDark}>Связь: {socketConnected ? "подключена" : "переподключение…"}</Text>
          <Text style={s.descDark} testID="driver-queue-status">Очередь: {queueMembership === "unknown" ? "проверяем состояние…" : driverInQueue ? `позиция ${queuePosition ?? "—"}` : activeDriverOrders.length ? "активный маршрут" : queueMembership === "enrolled" ? "рейс сохранён, позиция FIFO завершена" : "не в очереди"}</Text>
          {queueMembership === "enrolled" && driverQueueContext ? <View testID="driver-queue-context"><Text style={s.descDark}>{driverQueueContext.routeName} · питак {driverQueueContext.pitak}: {driverQueueContext.stopName}</Text><Text style={s.note}>{lineState?.phase === "departed" ? "Отправление подтверждено. После завершения поездок закрой рейс перед сменой направления." : "Маршрут и направление сохранены. Подходящие заказы распределяются по очереди и свободным местам."}</Text></View> : null}
          <Text style={s.descDark} testID="driver-free-seats">Свободных мест сейчас: {busy || freeSeats.status === "unknown" ? "не подтверждено" : freeSeats.status === "absent" ? "нет активной очереди" : freeSeats.availableSeats}</Text>
          {!busy && freeSeats.status === "known" && driverSeatSnapshot ? <Text style={s.note}>Подтверждено: {new Date(driverSeatSnapshot.checkedAt).toLocaleTimeString("ru-RU")}</Text> : null}
          <Button title="Обновить места" testID="driver-free-seats-refresh" onPress={() => { invalidateDriverSeats(); void refreshOrders(); }} disabled={busy} secondary />
          <Text style={s.label}>МЕСТА ПРИ ВХОДЕ В ОЧЕРЕДЬ</Text><Stepper value={driverSeats} max={maxDriverSeats} onChange={setDriverSeats} disabled={busy || queueMembership !== "absent" || !!incomingOrder || activeDriverOrders.length > 0} />
          {queueMembership === "absent" && !activeDriverOrders.length ? <Button title={busy ? "Определяем местоположение…" : driverRouteGate.hasChoice ? `Встать в очередь питак ${driverRouteGate.pitak ?? "—"}` : "Встать в очередь"} testID="driver-queue-join" onPress={joinQueue} disabled={busy || !!incomingOrder || !canJoinQueue} /> : null}
          {queueMembership === "enrolled" ? <><Button title={busy ? "Обновляем…" : "Обновить местоположение"} testID="driver-queue-location" onPress={updateDriverLocation} disabled={busy} secondary /><Button title={lineState?.phase === "departed" ? "Завершить рейс и выйти с линии" : "Выйти из очереди"} testID="driver-queue-leave" onPress={leaveQueue} disabled={busy || !!incomingOrder || activeDriverOrders.length > 0} secondary /></> : null}
          {queueMembership === "enrolled" && lineState?.phase === "departed" && !incomingOrder && !activeDriverOrders.length ? <Text style={s.note} testID="driver-line-finished">Поездки завершены. Выйди с линии, затем выбери направление и начни следующий рейс.</Text> : null}
          {queueMembership === "absent" && !activeDriverOrders.length && driverRouteGate.hasChoice ? <Button title="Начать сбор пассажиров на линии" testID="driver-line-join" onPress={() => { void joinLine(); }} disabled={busy || !!incomingOrder || !canJoinQueue} secondary /> : null}
          {queueMembership === "enrolled" && lineState?.phase === "collecting" ? <View testID="driver-line-collection"><Text style={s.note}>Сбор пассажиров · линия активна. Посадка и отправление подтверждаются сервером.</Text><Button title="Отправиться с питака" testID="driver-line-depart" onPress={confirmLineDeparture} disabled={busy || !!incomingOrder || !canDepartLine(lineState)} />{departureConfirmation?.sessionKey === driverRouteSession && departureConfirmation.enrollmentId === lineState.enrollmentId ? <View><Text style={s.note}>Подтвердить отправление машины? Это действие нельзя отменить.</Text><Button title="Подтвердить отправление" testID="driver-line-depart-confirm" onPress={() => { void departLine(departureConfirmation.enrollmentId); }} disabled={busy || !!incomingOrder} /><Button title="Не сейчас" testID="driver-line-depart-cancel" onPress={() => setDepartureConfirmation(null)} disabled={busy} secondary /></View> : null}</View> : null}
        </View>
        {incomingOrder ? <View style={s.card} testID="driver-incoming-order"><Text style={s.heading}>Новый заказ</Text><Text style={s.descDark}>Точка подачи: {ridePickupLabel(incomingOrder)}</Text><Text style={s.descDark}>Куда: {rideDestinationLabel(incomingOrder)}</Text><Text style={s.descDark}>Пассажиров: {incomingOrder.seats}</Text><Text style={s.note}>Ответить за {Math.max(0, Math.ceil(((incomingOrder.offer_expires_at ?? now) - now) / 1_000))} сек.</Text><Button title={busy ? "Принимаем…" : "Принять заказ"} testID="driver-order-accept" onPress={acceptOrder} disabled={busy || !isLiveOffer(incomingOrder, profile.id, now)} /><Button title="Отклонить" testID="driver-order-reject" onPress={rejectOrder} disabled={busy || !isLiveOffer(incomingOrder, profile.id, now)} secondary /></View> : null}
        {activeDriverOrders.map(activeOrder => <View key={activeOrder.id} style={s.card} testID={`driver-trip-${activeOrder.id}`}><Text style={s.heading}>Текущая поездка</Text><Text style={s.descDark}>Статус: {statusLabels[activeOrder.status]}</Text><Text style={s.descDark}>Точка подачи: {ridePickupLabel(activeOrder)}</Text><Text style={s.descDark}>Назначение: {rideDestinationLabel(activeOrder)}</Text>{canBoardLinePassenger(lineState, activeOrder) ? <Button title="Пассажир сел в машину" testID="driver-line-board" onPress={() => { void boardLinePassenger(activeOrder); }} disabled={busy} /> : null}{nextDriverTripStatus(lineState?.phase ?? null, activeOrder) ? <Button title={busy ? "Обновляем…" : nextTripLabel(activeOrder)} testID={`driver-trip-progress-${activeOrder.id}`} onPress={() => progressOrder(activeOrder)} disabled={busy} /> : null}</View>)}
        {!driverRouteGate.hasChoice && !driverQueueContext && !incomingOrder && !activeDriverOrders.length ? <View style={s.card}><Text style={s.descDark}>Ожидаем подходящий заказ. Сервер выбирает водителя по очереди и доступным местам.</Text></View> : null}
        <DriverHistory key={`${driverRouteSession}:${profile.id}`} endpoint={apiBase} token={token} driverId={profile.id} />
      </>
    ) : <>
    {passengerOrders.filter(order => !isClosed(order)).map(passengerOrder => <View key={passengerOrder.id} style={s.card} testID={`passenger-trip-${passengerOrder.id}`}><Text style={s.heading}>Твоя поездка</Text><Text style={s.descDark}>{statusLabels[passengerOrder.status]}</Text><Text style={s.descDark}>Точка подачи: {ridePickupLabel(passengerOrder)}</Text><Text style={s.descDark}>Куда: {rideDestinationLabel(passengerOrder)}</Text><Text style={s.descDark}>Пассажиров: {passengerOrder.seats}</Text>{passengerOrder.status === "searching" && passengerOrder.offered_driver_id ? <Text style={s.note}>Ждём ответа водителя.</Text> : null}<PassengerDriverCard key={`${driverRouteSession}:${passengerOrder.id}:${passengerOrder.driver_id ?? ""}:${passengerOrder.status}`} endpoint={apiBase} token={token} order={passengerOrder} /><Button title={busy ? "Отменяем…" : "Отменить заказ"} onPress={() => cancelOrder(passengerOrder)} disabled={busy} secondary /></View>)}
    <PassengerRouteOrder key={driverRouteSession} endpoint={apiBase} userId={profile.id} token={token} busy={busy} activeOrder={passengerHasActiveOrder} bookingGate={bookingGate} onCreated={refreshOrders} />
    <View style={s.card}>
      <Text style={s.heading}>Прежний маршрут C/D</Text>
      <Text style={s.label}>ТОЧКА А · ОТПРАВЛЕНИЕ</Text>{stops.filter(v => v.code === "C" || v.code === "D").map(v => <Pressable key={"a"+v.id} onPress={() => setA(v.code)} style={[s.stop, a===v.code && s.selected]}><Text style={s.stopText}>{v.name}</Text><Text>{v.code}</Text></Pressable>)}
      <Text style={s.label}>ТОЧКА Б · НАЗНАЧЕНИЕ</Text>{stops.map(v => <Pressable key={"b"+v.id} onPress={() => setB(v.code)} style={[s.stop, b===v.code && s.selected]}><Text style={s.stopText}>{v.name}</Text><Text>{v.code}</Text></Pressable>)}
      <TextInput style={s.input} value={address} onChangeText={setAddress} placeholder="Уточнение адреса подачи (необязательно)" />
      <View style={s.fare}><Text style={s.label}>ПРЕДВАРИТЕЛЬНАЯ СТОИМОСТЬ</Text><Text style={s.price}>{fareFresh && fare ? formatFareMoney(fare) : "—"}</Text></View>
      <View style={s.seatsRow}><Text style={s.descDark}>Пассажиры (до 8)</Text><Stepper value={seats} onChange={setSeats} /></View>
      <Text style={s.descDark}>Наличие водителей: {availabilityDisplay.label}</Text>
      {availabilityError ? <Text style={s.note}>{availabilityError}</Text> : null}
      <Button title="Проверить наличие водителей" onPress={() => { void refreshAvailability(); }} disabled={busy || checkingAvailability} secondary />
      <Button title={busy ? "Оформляем…" : "Заказать поездку"} onPress={order} disabled={busy || !fareFresh || !canOrder || passengerHasActiveOrder || !bookingGate.canSubmit()} />
      {passengerHasActiveOrder ? <Text style={s.small}>Сначала заверши или отмени текущий заказ.</Text> : null}
      {message ? <Text style={s.note}>{message}</Text> : null}<Text style={s.small}>Геолокация запрашивается только при оформлении заказа.</Text>
    </View>
    {availabilityDisplay.state === "unavailable" ? <View style={s.card}><Text style={s.heading}>Водителей пока нет</Text><Text style={s.descDark}>Для этой точки и количества пассажиров сейчас нет свободного водителя. Попробуй проверить наличие позже.</Text></View> : null}
    <PassengerHistory key={`${driverRouteSession}:${profile.id}`} endpoint={apiBase} token={token} passengerId={profile.id} recentOrders={passengerOrders} />
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

