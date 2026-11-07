import Text from "./OnayText";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import OnayScreenFrame, { onayPalette } from "./OnayScreenFrame";
import type { DriverModeStatus, DriverModeVehicle } from "../lib/onay-driver-mode-status";
import { driverModeStatus, driverModeReadyForQueue, hasCompleteDriverVehicle } from "../lib/onay-driver-mode-status";

type Props = {
  theme: "light" | "dark";
  demoMode: boolean;
  approval?: "pending" | "approved" | "rejected" | "blocked" | null;
  vehicle?: DriverModeVehicle | null;
  routeName?: string | null;
  queueReady?: boolean;
  enrolled?: boolean;
  busy?: boolean;
  onBack: () => void;
  onOpenDriver: () => void;
  onSupport: () => void;
};
const labels: Record<DriverModeStatus, string> = {
  unfilled: "Не заполнено",
  pending: "На проверке",
  approved: "Подтверждено",
  rejected: "Отклонено",
  blocked: "Заблокировано",
  unknown: "Статус не получен",
};
const demoStates: DriverModeStatus[] = ["unfilled", "pending", "approved", "rejected", "blocked"];
/**
 * A passenger-facing informational page, not the driver queue controls.
 * Only the driver's existing server-backed queue/route actions may enroll.
 */
export default function OnayDriverModeOverview({
  theme, demoMode, approval, vehicle, routeName, queueReady = false, enrolled = false, busy = false,
  onBack, onOpenDriver, onSupport,
}: Props) {
  const c = onayPalette(theme);
  const [demoStatus, setDemoStatus] = useState<DriverModeStatus>("unfilled");
  const status = demoMode ? demoStatus : driverModeStatus(approval, vehicle);
  const ready = !demoMode && driverModeReadyForQueue(approval, vehicle, !!routeName, queueReady);
  const onLine = !demoMode && approval === "approved" && enrolled;
  const title = demoMode ? "ДЕМО · Учебное состояние" : "Текущий статус по данным сервера";
  const car = !demoMode && vehicle && [vehicle.make, vehicle.model].filter(Boolean).join(" ").trim();
  return <OnayScreenFrame title="Режим водителя" theme={theme} onBack={onBack} testID="onay-driver-mode-overview">
    {demoMode ? <Text testID="onay-driver-mode-demo-notice" style={[styles.notice, { color: c.muted }]}>
      ДЕМО · Только пример интерфейса. Проверки, одобрения и реальные заказы не выполняются.
    </Text> : null}
    <View testID="onay-driver-mode-status-card" style={[styles.card, { backgroundColor: c.card }]}>
      <Text style={[styles.label, { color: c.muted }]}>{title}</Text>
      <Text testID="onay-driver-mode-status" style={[styles.status, { color: status === "approved" ? c.accent : c.text }]}>
        {labels[status]}
      </Text>
      <Text style={[styles.note, { color: c.muted }]}>
        {status === "approved" ? "Анкета подтверждена. Для приёма заказов также необходимы автомобиль, маршрут и очередь."
          : status === "pending" ? "Анкета ожидает проверки администратора."
          : status === "blocked" ? "Работа водителем заблокирована. Самостоятельное включение заказов недоступно."
          : status === "rejected" ? "Анкета отклонена. Уточните подробности в поддержке."
          : status === "unfilled" ? "Чтобы стать водителем, необходимо заполнить анкету и добавить автомобиль."
          : "Статус не подтверждён сервером. Приём заказов недоступен."}
      </Text>
    </View>

    {demoMode ? <View testID="onay-driver-mode-demo-states" style={[styles.card, { backgroundColor: c.card }]}>
      <Text style={[styles.label, { color: c.text }]}>Учебные статусы</Text>
      <View style={styles.statusOptions}>
        {demoStates.map(value => <Pressable key={value} testID={"onay-driver-mode-demo-" + value}
          accessibilityRole="button" accessibilityState={{ selected: demoStatus === value }}
          onPress={() => setDemoStatus(value)} style={[styles.demoPill, { backgroundColor: demoStatus === value ? c.accent : c.cardRaised }]}>
          <Text style={{ color: demoStatus === value ? c.accentInk : c.text, fontSize: 12, fontWeight: "600" }}>{labels[value]}</Text>
        </Pressable>)}
      </View>
    </View> : null}

    <View style={[styles.card, { backgroundColor: c.card }]}>
      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.section, { color: c.text }]}>Принимать заказы</Text>
          <Text style={[styles.note, { color: c.muted }]}>Только через проверенную очередь водителя</Text>
        </View>
        <View testID="onay-driver-mode-readonly-online" accessibilityRole="switch"
          accessibilityLabel="Принимать заказы: доступно только в режиме водителя"
          accessibilityState={{ checked: onLine, disabled: true }}
          style={[styles.switch, { backgroundColor: onLine ? c.accent : c.cardRaised, opacity: .65 }]}>
          <View style={[styles.knob, { backgroundColor: onLine ? c.accentInk : c.muted, alignSelf: onLine ? "flex-end" : "flex-start" }]}/>
        </View>
      </View>
      <Text testID="onay-driver-mode-queue-guard" style={[styles.note, { color: c.muted, marginTop: 10 }]}>
        {demoMode ? "В демо переключатель недоступен. Учебные статусы не дают допуск."
          : ready ? "Условия проверены. Управляйте приёмом заказов в режиме водителя."
          : "Приём заказов заблокирован до проверки статуса, автомобиля, маршрута и очереди."}
      </Text>
    </View>

    <View style={[styles.card, { backgroundColor: c.card }]}>
      <Text style={[styles.section, { color: c.text }]}>Проверка водителя</Text>
      <View style={[styles.line, { borderBottomColor: c.border }]}>
        <Text style={{ color: c.text }}>Анкета</Text>
        <Text style={{ color: c.muted, flexShrink: 1, textAlign: "right" }}>{labels[status]}</Text>
      </View>
      <View style={styles.line}>
        <Text style={{ color: c.text }}>Автомобиль</Text>
        <Text testID="onay-driver-mode-vehicle" style={{ color: c.muted, flexShrink: 1, textAlign: "right" }}>
          {demoMode ? "ДЕМО · Нет реального автомобиля"
            : hasCompleteDriverVehicle(vehicle) ? [car, vehicle?.plate_number].filter(Boolean).join(" · ") : "Не заполнено"}
        </Text>
      </View>
    </View>

    <View style={[styles.card, { backgroundColor: c.card }]}>
      <Text style={[styles.section, { color: c.text }]}>Ваш маршрут</Text>
      <Text testID="onay-driver-mode-route" style={[styles.note, { color: c.muted, marginTop: 10 }]}>
        {demoMode ? "ДЕМО · Реальный маршрут не назначен" : routeName || "Маршрут не выбран"}
      </Text>
    </View>

    {demoMode
      ? <Text style={[styles.notice, { color: c.muted }]}>Для просмотра водительских экранов используйте отдельный переключатель ролей вверху демо.</Text>
      : <Pressable testID="onay-driver-mode-enter" accessibilityRole="button" disabled={busy}
          onPress={onOpenDriver} style={[styles.cta, { backgroundColor: c.accent, opacity: busy ? .5 : 1 }]}>
          <Text style={{ color: c.accentInk, fontWeight: "700", fontSize: 15 }}>Перейти к настройкам водителя</Text>
        </Pressable>}
    <Pressable testID="onay-driver-mode-support" accessibilityRole="button" onPress={onSupport}
      style={[styles.help, { borderColor: c.border }]}>
      <Text style={{ color: c.text, fontSize: 14, fontWeight: "600" }}>Связаться с поддержкой</Text>
    </Pressable>
  </OnayScreenFrame>;
}
const styles = StyleSheet.create({
  card: { borderRadius: 20, padding: 16, marginTop: 16, gap: 5 },
  status: { fontSize: 20, fontWeight: "800", marginTop: 4 },
  section: { fontSize: 16, fontWeight: "700" },
  label: { fontSize: 13, fontWeight: "600" },
  note: { fontSize: 13, lineHeight: 20 },
  notice: { marginTop: 14, fontSize: 13, lineHeight: 20 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  switch: { width: 52, height: 30, borderRadius: 15, justifyContent: "center", paddingHorizontal: 4 },
  knob: { height: 22, width: 22, borderRadius: 11 },
  line: { minHeight: 49, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottomWidth: 1 },
  cta: { minHeight: 52, borderRadius: 16, alignItems: "center", justifyContent: "center", padding: 10, marginTop: 20 },
  help: { minHeight: 52, borderRadius: 16, borderWidth: 1, alignItems: "center", justifyContent: "center", marginTop: 12, marginBottom: 20 },
  statusOptions: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 12 },
  demoPill: { padding: 10, borderRadius: 13 },
});
