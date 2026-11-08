import TextInput from "./OnayTextInput";
import Text from "./OnayText";
import { useEffect, useReducer, useRef, useState } from "react";
import { BackHandler, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { createDemoState, onayDemoReducer, type DemoRole } from "../lib/onay-demo";
import { formatFareMoney } from "../lib/fare-money";
import { statusLabels } from "../lib/orders";
import { useOnaySystemUi } from "../lib/use-onay-system-ui";
import type { OnayPassengerTab } from "../lib/onay-passenger-tabs";
import OnayPassengerHome from "./OnayPassengerHome";
import OnayPassengerScreens from "./OnayPassengerScreens";
import OnayPassengerTabBar from "./OnayPassengerTabBar";
import OnayPassengerTrips from "./OnayPassengerTrips";
import OnayPassengerProfile from "./OnayPassengerProfile";
import OnayPassengerChatsEmpty from "./OnayPassengerChatsEmpty";
import OnayPassengerAbout from "./OnayPassengerAbout";
import OnayPassengerSupport from "./OnayPassengerSupport";
import OnayDriverShell, { type OnayDriverTab } from "./OnayDriverShell";
import OnayDriverProfile from "./OnayDriverProfile";
import OnayHistoryRow from "./OnayHistoryRow";
import OnayPassengerRide from "./OnayPassengerRide";
import OnayRouteSchematic from "./OnayRouteSchematic";
import OnayScreenFrame, { onayPalette } from "./OnayScreenFrame";

type Popup = "booking" | "route" | "vehicle" | "support" | "about" | "server" | null;

function DemoNotice({ color }: { color: string }) {
  return <Text testID="onay-demo-notice" style={{ color, fontSize: 13, lineHeight: 20 }}>ДЕМО · Без SMS и сервера. Все данные учебные. Настоящие заказы не отправляются.</Text>;
}

/** Isolated preview tree: deliberately no API/auth clients or token-bearing components. */
export default function OnayDemoApp({ initialRole, onExit }: { initialRole: DemoRole; onExit: () => void }) {
  const [state, dispatch] = useReducer(onayDemoReducer, initialRole, createDemoState);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [tab, setTab] = useState<OnayPassengerTab>("home"), [driverTab, setDriverTab] = useState<OnayDriverTab>("line");
  const historyReturnTab = useRef<OnayPassengerTab>("profile");
  function closeHistory() { setHistoryOpen(false); setTab(historyReturnTab.current); }
  const [historyOpen, setHistoryOpen] = useState(false), [popup, setPopup] = useState<Popup>(null);
  const [seats, setSeats] = useState(1), [reverse, setReverse] = useState(false);
  const [car, setCar] = useState("Chevrolet Cobalt"), [plate, setPlate] = useState("DEMO"), [capacity, setCapacity] = useState(4);
  const scroll = useRef<ScrollView>(null), insets = useSafeAreaInsets(), c = onayPalette(theme);
  useOnaySystemUi(theme);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (popup) { setPopup(null); return true; }
      if (state.role === "passenger") {
        // Nested Home/Profile pages own their Back handlers; do not intercept them.
        if (tab === "home" || tab === "profile") return false;
        if (tab === "trips" && historyOpen) { closeHistory(); return true; }
        setTab("home"); return true;
      }
      if (state.role === "driver" && driverTab !== "line") { setDriverTab("line"); return true; }
      onExit(); return true;
    });
    return () => listener.remove();
  }, [popup, state.role, tab, driverTab, historyOpen, onExit]);
  function role(value: DemoRole) { dispatch({ type: "role", role: value }); setPopup(null); setTab("home"); setDriverTab("line"); setHistoryOpen(false); }
  const button = (id: string, label: string, onPress: () => void, secondary = false, disabled = false) => <Pressable testID={id} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={{ minHeight: 48, borderRadius: 16, padding: 14, alignItems: "center", justifyContent: "center", backgroundColor: secondary ? c.cardRaised : c.accent, opacity: disabled ? .45 : 1, marginTop: 12 }}><Text style={{ color: secondary ? c.text : c.accentInk, fontSize: 15, fontWeight: "700", textAlign: "center" }}>{label}</Text></Pressable>;
  const history = <View testID="onay-demo-history"><DemoNotice color={c.muted}/>{state.history.map(order => <OnayHistoryRow key={order.id} order={order} theme={theme} amount={formatFareMoney(order.fare)} driver={state.role === "driver"} testID={"onay-demo-history-row-" + order.id}/>)}</View>;
  const demoTrip = state.ride ? <OnayPassengerRide order={state.ride} theme={theme}>
    <View style={{ backgroundColor: c.card, padding: 16, borderRadius: 20, marginTop: 16, gap: 10 }}><DemoNotice color={c.muted}/><Text style={{ color: c.text, fontSize: 18, fontWeight: "700" }}>Демо-водитель</Text><Text style={{ color: c.muted }}>{car} · {plate}</Text><Text style={{ color: c.muted }}>Звонки и сообщения в демо не отправляются.</Text></View>
    {button("onay-demo-passenger-cancel", "Отменить учебную поездку", () => { if (state.ride) dispatch({ type: "cancel", expectedStatus: state.ride.status }); }, true)}
  </OnayPassengerRide> : null;
  const chooseBooking = (isReverse = false) => { setReverse(isReverse); setPopup("booking"); };
  return <View testID="onay-demo-app" style={{ flex: 1, backgroundColor: c.background }}>
    <StatusBar style={theme === "dark" ? "light" : "dark"}/>
    <View style={{ paddingTop: Math.max(insets.top, 10), paddingHorizontal: 16, paddingBottom: 10, backgroundColor: c.cardRaised, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><Text accessibilityRole="header" style={{ color: c.accent, fontSize: 16, fontWeight: "700", flex: 1 }}>ДЕМО ONAY</Text><Pressable testID="onay-demo-exit" accessibilityRole="button" onPress={onExit} style={{ padding: 10 }}><Text style={{ color: c.text }}>Выйти из демо</Text></Pressable></View>
      <Text style={{ color: c.muted, fontSize: 12 }}>Без сервера · Учебные данные · Без настоящих заказов</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>{(["passenger", "driver"] as const).map(value => <Pressable key={value} testID={"onay-demo-role-" + value} accessibilityRole="button" accessibilityState={{ selected: state.role === value }} onPress={() => role(value)} style={{ flex: 1, padding: 9, borderRadius: 12, alignItems: "center", backgroundColor: state.role === value ? c.accent : c.card }}><Text style={{ color: state.role === value ? c.accentInk : c.text, fontWeight: "600" }}>{value === "passenger" ? "Пассажир" : "Водитель"}</Text></Pressable>)}</View>
    </View>
    {state.role === "passenger" ? <>
      <OnayPassengerScreens active={tab} theme={theme} homeScroll={scroll}
        home={<OnayPassengerHome active={tab === "home"} theme={theme} onThemeChange={setTheme} activeOrder={!!state.ride} onViewActiveOrder={() => setTab("trips")} onChoose={value => chooseBooking(value === "village")} onChooseLocation={() => setPopup("route")}/>}
        trips={<OnayPassengerTrips theme={theme} activeCount={state.ride ? 1 : 0} historyOpen={historyOpen} onShowHistory={() => setHistoryOpen(true)} onShowActive={closeHistory} onBook={() => chooseBooking()} activeContent={demoTrip} historyContent={history}/>}
        chats={<OnayPassengerChatsEmpty theme={theme}/>}
        profile={<OnayPassengerProfile demoMode fullName="Демо-пассажир" busy={false} theme={theme} active={tab === "profile"} onBackToHome={() => setTab("home")} onThemeChange={setTheme} onHistory={() => { historyReturnTab.current = tab; setTab("trips"); setHistoryOpen(true); }} onDriver={() => role("driver")} onLogout={onExit} onSupportPreview={() => setPopup("support")}/>}/>
      <OnayPassengerTabBar active={tab} onSelect={value => { setTab(value); if (value !== "trips") setHistoryOpen(false); }} theme={theme}/>
    </> : <OnayDriverShell active={driverTab} onSelect={setDriverTab} theme={theme} fullName="Демо-водитель" online={state.online} disabled={false} onOnline={() => dispatch({ type: "online" })} pages={{
      line: <><OnayRouteSchematic start="ДЕМО · Shaxsham" end="ДЕМО · Gazalkent"/><View style={{ backgroundColor: c.card, padding: 16, borderRadius: 20, gap: 8 }}><Text style={{ color: c.text, fontSize: 18, fontWeight: "700" }}>{car} · {plate}</Text><Text style={{ color: c.muted }}>Демо-автомобиль · мест: {capacity}</Text><DemoNotice color={c.muted}/></View>
        {button("onay-demo-driver-route", "Маршрут и направление", () => setPopup("route"), true)}
        {state.ride ? <View testID="onay-demo-driver-order" style={{ backgroundColor: c.card, borderRadius: 20, padding: 16, gap: 8, marginTop: 12 }}><Text style={{ color: c.accent, fontWeight: "700" }}>Учебный заказ</Text><Text style={{ color: c.text }}>{statusLabels[state.ride.status]}</Text><Text style={{ color: c.muted }}>Демо-пассажир · {state.ride.seats} мест · {formatFareMoney(state.ride.fare)}</Text>
          {button("onay-demo-driver-progress", state.ride.status === "searching" ? "Принять (демо)" : state.ride.status === "en_route_to_c" ? "Прибыл (демо)" : state.ride.status === "arrived_at_c" ? "Пассажир сел (демо)" : state.ride.status === "boarded_waiting" ? "Начать поездку (демо)" : "Завершить (демо)", () => { if (state.ride) dispatch({ type: "advance", expectedStatus: state.ride.status }); })}
          {button("onay-demo-driver-cancel", "Отменить учебный заказ", () => { if (state.ride) dispatch({ type: "cancel", expectedStatus: state.ride.status }); }, true)}</View> : button("onay-demo-driver-example", "Показать пример заказа", () => dispatch({ type: "start", seats: 1, reverse }))}</>,
      queue: <><DemoNotice color={c.muted}/>{button("onay-demo-queue-route", "Выбрать учебный маршрут", () => setPopup("route"), true)}<View style={{ backgroundColor: c.card, borderRadius: 20, padding: 16, marginTop: 12, gap: 8 }}><Text style={{ color: c.text, fontSize: 18 }}>1 · Демо-водитель</Text><Text style={{ color: c.muted }}>Пример очереди. К реальной очереди не подключено.</Text><Text style={{ color: c.muted }}>Учебных свободных мест: {capacity}</Text></View></>,
      chats: <OnayPassengerChatsEmpty theme={theme} role="driver" showHeading={false}/>, history,
      profile: <OnayDriverProfile demoMode fullName="Демо-водитель" vehicle={{ make: car, model: "", plate_number: plate, seat_capacity: capacity }} theme={theme} onTheme={setTheme} busy={false} onVehicle={() => setPopup("vehicle")} onSupport={() => setPopup("support")} onAbout={() => setPopup("about")} onPassenger={() => role("passenger")} onServer={() => setPopup("server")} onLogout={onExit}/>,
    }}/>}
    <Modal visible={popup !== null} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setPopup(null)}>
      <OnayScreenFrame title={popup === "booking" ? "Демо · Оформление" : popup === "route" ? "Демо · Маршрут" : popup === "vehicle" ? "Демо · Автомобиль" : popup === "about" ? undefined : popup === "support" ? undefined : "Демо · Сервер"} theme={theme} onBack={popup === "about" ? undefined : () => setPopup(null)} testID="onay-demo-page">
        <DemoNotice color={c.muted}/>
        {popup === "booking" ? <>
          {[['Откуда', reverse ? 'Gazalkent' : 'Shaxsham'], ['Куда', reverse ? 'Shaxsham' : 'Gazalkent']].map(([label, value]) => <Pressable key={label} accessibilityRole="button" onPress={() => setReverse(value => !value)} style={{ backgroundColor: c.card, padding: 16, borderRadius: 20, marginTop: 12, gap: 5 }}><Text style={{ color: c.muted }}>{label}</Text><Text style={{ color: c.text, fontSize: 17, fontWeight: "700" }}>ДЕМО · {value}</Text></Pressable>)}
          <View style={{ backgroundColor: c.card, padding: 16, borderRadius: 20, marginTop: 12 }}><Text style={{ color: c.text, fontSize: 16, fontWeight: "700" }}>Пассажиры</Text><View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>{button("onay-demo-seat-minus", "−", () => setSeats(value => Math.max(1, value - 1)), true, seats <= 1)}<Text testID="onay-demo-seats" style={{ color: c.text, fontSize: 22 }}>{seats}</Text>{button("onay-demo-seat-plus", "+", () => setSeats(value => Math.min(8, value + 1)), true, seats >= 8)}</View></View>
          <Text style={{ color: c.muted, marginTop: 18 }}>Пример тарифа: {formatFareMoney({ total: seats * 12000, currency: "UZS" })}. Это не предложение реальной поездки.</Text>
          {button("onay-demo-preview-trip", state.ride ? "Открыть учебную поездку" : "Показать учебную поездку", () => { if (!state.ride) dispatch({ type: "start", seats, reverse }); setPopup(null); setTab("trips"); setHistoryOpen(false); })}
        </> : popup === "route" ? <>{button("onay-demo-route-forward", "Shaxsham → Gazalkent", () => setReverse(false), reverse)}{button("onay-demo-route-reverse", "Gazalkent → Shaxsham", () => setReverse(true), !reverse)}{button("onay-demo-route-done", "Выбрать учебный маршрут", () => setPopup(state.role === "passenger" ? "booking" : null))}</> : popup === "vehicle" ? <>
          <Text style={{ color: c.muted, marginTop: 16 }}>Автомобиль</Text><TextInput testID="onay-demo-car" value={car} onChangeText={setCar} style={{ backgroundColor: c.card, color: c.text, borderRadius: 16, padding: 16, marginTop: 8 }}/><Text style={{ color: c.muted, marginTop: 16 }}>Учебный номер</Text><TextInput testID="onay-demo-plate" value={plate} onChangeText={setPlate} style={{ backgroundColor: c.card, color: c.text, borderRadius: 16, padding: 16, marginTop: 8 }}/><Text style={{ color: c.muted, marginTop: 16 }}>Мест в салоне: {capacity}</Text><View style={{ flexDirection: "row", gap: 16 }}>{button("onay-demo-car-minus", "−", () => setCapacity(value => Math.max(1, value - 1)), true, capacity <= 1)}{button("onay-demo-car-plus", "+", () => setCapacity(value => Math.min(8, value + 1)), true, capacity >= 8)}</View>{button("onay-demo-car-done", "Вернуться к демо", () => setPopup(null))}<Text style={{ color: c.muted, marginTop: 16 }}>Изменения только для демонстрации; после выхода они исчезнут.</Text>
        </> : popup === "about" ? <OnayPassengerAbout mode="demo" theme={theme} onBack={() => setPopup(null)}/> : popup === "support" ? <OnayPassengerSupport theme={theme} previewOnly onBack={() => setPopup(null)}/> : <Text style={{ color: c.text, fontSize: 16, lineHeight: 24, marginTop: 24 }}>{popup === "server" ? "Демо работает без подключения. Для настоящего входа выйдите из демо и откройте настройки сервера на экране авторизации." : "В деморежиме сообщения не отправляются. Здесь можно только посмотреть интерфейс."}</Text>}
      </OnayScreenFrame>
    </Modal>
  </View>;
}
