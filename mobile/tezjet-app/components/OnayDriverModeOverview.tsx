import Text from "./OnayText";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import OnayScreenFrame, { onayPalette } from "./OnayScreenFrame";
import type { DriverModeStatus, DriverModeVehicle } from "../lib/onay-driver-mode-status";
import { driverModeStatus, driverModeReadyForQueue, hasCompleteDriverVehicle } from "../lib/onay-driver-mode-status";

type Approval = "pending" | "approved" | "rejected" | "blocked";
type VehicleSnapshot = {
  driver_vehicle: DriverModeVehicle | null;
  approval_status: Approval | null;
  route_name?: string | null;
  review_reason?: string | null;
};
type Props = {
  theme: "light" | "dark";
  demoMode: boolean;
  approval?: Approval | null;
  vehicle?: DriverModeVehicle | null;
  routeName?: string | null;
  queueReady?: boolean;
  enrolled?: boolean;
  busy?: boolean;
  onBack: () => void;
  onOpenDriver: () => void;
  onOpenVehicle?: () => void;
  onLoadVehicle?: () => Promise<VehicleSnapshot>;
  onSupport: () => void;
};
const labels: Record<DriverModeStatus, string> = {
  unfilled: "Не заполнено", pending: "На проверке", approved: "Подтверждено",
  rejected: "Отклонено", blocked: "Заблокировано", unknown: "Статус не получен",
};
const demoStates: DriverModeStatus[] = ["unfilled", "pending", "approved", "rejected", "blocked"];

/** Read-only overview. All actual queue mutations remain in the existing driver screen. */
export default function OnayDriverModeOverview({ theme, demoMode,
  queueReady = false, enrolled = false, busy = false, onBack, onOpenDriver,
  onOpenVehicle, onLoadVehicle, onSupport }: Props) {
  const c = onayPalette(theme);
  const [demoStatus, setDemoStatus] = useState<DriverModeStatus>("unfilled");
  const [snapshot, setSnapshot] = useState<VehicleSnapshot | null>(null);
  const [loading, setLoading] = useState(!demoMode);
  const [loadError, setLoadError] = useState("");
  const loaderRef = useRef(onLoadVehicle);
  const generation = useRef(0);
  loaderRef.current = onLoadVehicle;
  async function reload() {
    const ticket = ++generation.current;
    setLoading(true); setLoadError("");
    try {
      const loader = loaderRef.current;
      if (!loader) throw new Error("Не настроена загрузка анкеты с сервера.");
      const value = await loader();
      if (!value || typeof value !== "object" || !("driver_vehicle" in value) ||
          !(value.approval_status === null || ["pending", "approved", "rejected", "blocked"].includes(String(value.approval_status)))) {
        throw new Error("Сервер вернул некорректный статус анкеты.");
      }
      if (generation.current !== ticket) return;
      setSnapshot(value);
    } catch (e) {
      if (generation.current !== ticket) return;
      setSnapshot(null);
      setLoadError(e instanceof Error ? e.message : "Не удалось загрузить анкету.");
    } finally {
      if (generation.current === ticket) setLoading(false);
    }
  }
  useEffect(() => {
    if (!demoMode) void reload();
    return () => { generation.current++; };
  }, [demoMode]);

  const liveVehicle = snapshot?.driver_vehicle ?? null;
  const liveApproval = snapshot?.approval_status ?? null;
  const status: DriverModeStatus = demoMode ? demoStatus :
    snapshot ? driverModeStatus(liveApproval, liveVehicle) : "unknown";
  const ready = !demoMode && !!snapshot && driverModeReadyForQueue(liveApproval, liveVehicle, !!snapshot.route_name, queueReady);
  const onLine = !demoMode && !!snapshot && liveApproval === "approved" && enrolled;
  const car = !demoMode && liveVehicle ? [liveVehicle.make, liveVehicle.model].filter(Boolean).join(" ").trim() : "";
  const displayStatus = loading ? "Загружаем анкету…" : loadError ? "Ошибка загрузки" : labels[status];
  const canEditVehicle = !loading && !loadError && !demoMode && (status === "unfilled" || status === "rejected") && !busy;

  return <OnayScreenFrame title="Режим водителя" theme={theme} onBack={onBack} testID="onay-driver-mode-overview">
    {demoMode ? <Text testID="onay-driver-mode-demo-notice" style={[styles.notice, { color: c.muted }]}>
      ДЕМО · Учебные состояния. Реальные проверки и заказы не выполняются.
    </Text> : null}
    <View testID="onay-driver-mode-status-card" style={[styles.card, { backgroundColor: c.card }]}>
      <Text style={[styles.label, { color: c.muted }]}>{demoMode ? "ДЕМО · Учебное состояние" : "Текущий статус по данным сервера"}</Text>
      <Text testID="onay-driver-mode-status" style={[styles.status, { color: status === "approved" && !loadError && !loading ? c.accent : c.text }]}>{displayStatus}</Text>
      {!demoMode && loadError ? <>
        <Text testID="onay-driver-mode-load-error" accessibilityRole="alert" style={[styles.note, { color: c.danger }]}>{loadError}</Text>
        <Pressable testID="onay-driver-mode-retry" accessibilityRole="button" onPress={() => { void reload(); }}
          style={[styles.action, { backgroundColor: c.cardRaised }]}><Text style={{ color: c.text }}>Повторить загрузку</Text></Pressable>
      </> : !loading ? <Text style={[styles.note, { color: c.muted }]}>
        {status === "approved" ? "Анкета подтверждена. Приём заказов требует автомобиля, маршрута и очереди."
          : status === "pending" ? "Отправленные данные ожидают проверки администратора."
          : status === "blocked" ? "Доступ водителя заблокирован. Разблокировка доступна только администратору."
          : status === "rejected" ? "Анкета отклонена. Исправление доступно, если аккаунт не заблокирован."
          : status === "unfilled" ? "Для допуска требуется заполнить анкету автомобиля."
          : "Статус не подтверждён сервером. Приём заказов недоступен."}
      </Text> : null}
    </View>

    {demoMode ? <View testID="onay-driver-mode-demo-states" style={[styles.card, { backgroundColor: c.card }]}>
      <Text style={[styles.section, { color: c.text }]}>Учебные статусы</Text>
      <View style={styles.statusOptions}>{demoStates.map(value => <Pressable key={value}
        testID={"onay-driver-mode-demo-" + value} accessibilityRole="button"
        accessibilityState={{ selected: demoStatus === value }} onPress={() => setDemoStatus(value)}
        style={[styles.demoPill, { backgroundColor: demoStatus === value ? c.accent : c.cardRaised }]}>
        <Text style={{ color: demoStatus === value ? c.accentInk : c.text, fontSize: 12, fontWeight: "600" }}>{labels[value]}</Text>
      </Pressable>)}</View>
    </View> : null}

    <View style={[styles.card, { backgroundColor: c.card }]}>
      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.section, { color: c.text }]}>Принимать заказы</Text>
          <Text style={[styles.note, { color: c.muted }]}>Только через серверную очередь водителя</Text>
        </View>
        <View testID="onay-driver-mode-readonly-online" accessibilityRole="switch"
          accessibilityLabel="Принимать заказы: доступно только в режиме водителя"
          accessibilityState={{ checked: onLine, disabled: true }}
          style={[styles.switch, { backgroundColor: onLine ? c.accent : c.cardRaised, opacity: .65 }]}>
          <View style={[styles.knob, { backgroundColor: onLine ? c.accentInk : c.muted, alignSelf: onLine ? "flex-end" : "flex-start" }]}/>
        </View>
      </View>
      <Text testID="onay-driver-mode-queue-guard" style={[styles.note, { color: c.muted, marginTop: 8 }]}>
        {demoMode ? "В демо приём заказов недоступен. Учебные статусы не дают одобрения."
          : ready ? "Условия выполнены. Управляйте очередью в режиме водителя."
          : "Приём заказов недоступен без подтверждённой анкеты, автомобиля, маршрута и очереди."}
      </Text>
    </View>

    <View style={[styles.card, { backgroundColor: c.card }]}>
      <Text style={[styles.section, { color: c.text }]}>Проверка водителя · Автомобиль</Text>
      <View style={[styles.line, { borderBottomColor: c.border }]}>
        <Text style={{ color: c.text }}>Анкета</Text>
        <Text style={{ color: c.muted }}>{displayStatus}</Text>
      </View>
      {(!loading && !loadError && !demoMode && liveVehicle && hasCompleteDriverVehicle(liveVehicle)) ? <>
        <View style={styles.line}><Text style={{ color: c.text }}>Марка / модель</Text>
          <Text testID="onay-driver-mode-vehicle" style={[styles.detail, { color: c.muted }]}>{car}</Text></View>
        <View style={styles.line}><Text style={{ color: c.text }}>Госномер</Text>
          <Text testID="onay-driver-mode-plate" style={[styles.detail, { color: c.muted }]}>{liveVehicle.plate_number}</Text></View>
        <View style={styles.line}><Text style={{ color: c.text }}>Количество мест</Text>
          <Text testID="onay-driver-mode-seats" style={{ color: c.muted }}>{liveVehicle.seat_capacity}</Text></View>
      </> : <Text testID="onay-driver-mode-vehicle" style={[styles.note, { color: c.muted }]}>
        {demoMode ? "ДЕМО · Реальные данные автомобиля не загружаются"
          : loading ? "Загружаем автомобиль…" : loadError ? "Данные не получены из-за ошибки загрузки"
          : status === "approved" ? "Автомобиль подтверждён, но данные не получены. Обновите информацию."
          : "Анкета автомобиля не заполнена"}
      </Text>}
      {!demoMode && !loading && !loadError && status === "rejected" ? <Text testID="onay-driver-mode-rejection-reason"
        style={[styles.note, { color: c.muted }]}>
        {snapshot?.review_reason || "Причина отказа не предоставлена сервером."}
      </Text> : null}
      {canEditVehicle ? <Pressable testID="onay-driver-mode-vehicle-form" accessibilityRole="button"
        onPress={onOpenVehicle} disabled={!onOpenVehicle} style={[styles.action, { backgroundColor: c.accent }]}>
        <Text style={{ color: c.accentInk, fontWeight: "700" }}>{status === "rejected" ? "Исправить анкету" : "Заполнить анкету"}</Text>
      </Pressable> : null}
    </View>

    <View style={[styles.card, { backgroundColor: c.card }]}>
      <Text style={[styles.section, { color: c.text }]}>Ваш маршрут</Text>
      <Text testID="onay-driver-mode-route" style={[styles.note, { color: c.muted, marginTop: 8 }]}>
        {demoMode ? "ДЕМО · Реальный маршрут не назначен"
          : loading ? "Загружаем маршрут…" : loadError ? "Ошибка загрузки маршрута"
          : snapshot?.route_name || "Маршрут не выбран"}
      </Text>
    </View>
    {demoMode ? <Text style={[styles.notice, { color: c.muted }]}>
      Для просмотра экранов водителя используйте отдельный переключатель ролей в демо.
    </Text> : <Pressable testID="onay-driver-mode-enter" accessibilityRole="button" disabled={busy}
      onPress={onOpenDriver} style={[styles.action, { backgroundColor: c.accent, marginTop: 16, opacity: busy ? .5 : 1 }]}>
      <Text style={{ color: c.accentInk, fontWeight: "700" }}>Перейти к настройкам водителя</Text>
    </Pressable>}
    <Pressable testID="onay-driver-mode-support" accessibilityRole="button" onPress={onSupport}
      style={[styles.help, { borderColor: c.border }]}>
      <Text style={{ color: c.text, fontWeight: "600" }}>Связаться с поддержкой</Text>
    </Pressable>
  </OnayScreenFrame>;
}
const styles = StyleSheet.create({
  card: { borderRadius: 20, padding: 16, marginTop: 16, gap: 7 },
  label: { fontSize: 13, fontWeight: "600" },
  section: { fontSize: 16, fontWeight: "700" },
  status: { fontSize: 20, fontWeight: "800", marginTop: 4 },
  note: { fontSize: 13, lineHeight: 20 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  switch: { width: 52, height: 30, borderRadius: 15, justifyContent: "center", paddingHorizontal: 4 },
  knob: { height: 22, width: 22, borderRadius: 11 },
  line: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  detail: { flexShrink: 1, textAlign: "right", fontSize: 14 },
  statusOptions: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 8 },
  demoPill: { padding: 10, borderRadius: 13 },
  notice: { marginTop: 14, fontSize: 13, lineHeight: 20 },
  action: { minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", padding: 12, marginTop: 8 },
  help: { minHeight: 52, borderWidth: 1, borderRadius: 16, alignItems: "center", justifyContent: "center", marginTop: 12, marginBottom: 20 },
});
