import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  canMutateDriverRoute, createDriverRouteClient, createDriverRouteRequestScope, driverDirectionLabel,
  driverRouteSessionKey, orderedDriverStops, refreshDriverRouteDraft, DriverRouteError,
  type DriverDirection, type DriverRouteChoice, type DriverRouteGate, type DriverRouteOption, type DriverRouteSnapshot,
} from "../lib/driver-routes";

type Props = {
  endpoint: string;
  token: string;
  busy: boolean;
  queued: boolean;
  activeTrip: boolean;
  pendingOffer: boolean;
  onStatusChange: (status: DriverRouteGate) => void;
};

const unavailableLabels = {
  ROUTE_MISSING: "Сохранённый маршрут удалён.",
  ROUTE_INACTIVE: "Сохранённый маршрут отключён.",
  ROUTE_CHANGED: "Сохранённый маршрут изменился.",
  ROUTE_NOT_CONFIGURED: "Сохранённый маршрут пока не настроен.",
};

function Action({ title, onPress, disabled, secondary = false, testID }: {
  title: string; onPress: () => void; disabled: boolean; secondary?: boolean; testID: string;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled }}
    testID={testID} disabled={disabled} onPress={onPress} style={[s.button, secondary && s.secondary, disabled && s.disabled]}>
    <Text style={[s.buttonText, secondary && s.secondaryText]}>{title}</Text>
  </Pressable>;
}

export default function DriverRoutePicker(props: Props) {
  const { endpoint, token, onStatusChange } = props;
  const sessionKey = driverRouteSessionKey(endpoint, token);
  const client = useMemo(() => createDriverRouteClient(endpoint, token), [endpoint, token]);
  const scope = useRef(createDriverRouteRequestScope());
  const [routes, setRoutes] = useState<DriverRouteOption[]>([]);
  const [snapshot, setSnapshot] = useState<DriverRouteSnapshot | null>(null);
  const [draft, setDraft] = useState<DriverRouteChoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const draftRef = useRef(draft);
  const snapshotRef = useRef(snapshot);
  draftRef.current = draft;
  snapshotRef.current = snapshot;
  const publish = useCallback((ready: boolean, mutating = false, value = snapshotRef.current) => {
    const pitak = value?.choice?.direction === "b_to_a" ? "B" : "A";
    onStatusChange({ sessionKey, ready, hasChoice: value?.choice != null, mutating,
      choice: value?.choice ?? undefined, routeAvailable: !!value?.route && !value.unavailable_reason, pitak,
      pitakName: value?.route ? (pitak === "A" ? value.route.stops[0].name : value.route.stops[value.route.stops.length - 1].name) : undefined,
    });
  }, [onStatusChange, sessionKey]);

  const load = useCallback(async (preserveDraft = false, nextNotice = "") => {
    const ticket = scope.current.start();
    setLoading(true); setSaving(false); setError(""); setNotice(nextNotice);
    publish(false);
    try {
      const result = await client.load(ticket.signal);
      if (!scope.current.isCurrent(ticket)) return;
      setRoutes(result.routes); setSnapshot(result.snapshot); snapshotRef.current = result.snapshot;
      if (scope.current.draftUnchanged(ticket)) {
        const nextDraft = refreshDriverRouteDraft(preserveDraft ? draftRef.current : result.snapshot.choice, result.routes);
        draftRef.current = nextDraft; setDraft(nextDraft);
      }
      setLoading(false); publish(true, false, result.snapshot);
    } catch (e) {
      if (!scope.current.isCurrent(ticket)) return;
      setLoading(false);
      setError(e instanceof Error ? e.message : "Не удалось загрузить маршруты. Повтори обновление.");
      publish(false);
    }
  }, [client, publish]);

  useEffect(() => {
    scope.current = createDriverRouteRequestScope();
    void load();
    return () => { scope.current.dispose(); };
  }, [load]);

  const allowed = canMutateDriverRoute(props);
  const disabled = !allowed || loading || saving;
  const selectedRoute = routes.find(route => route.id === draft?.routeId);
  const selectedStops = selectedRoute && draft ? orderedDriverStops(selectedRoute, draft.direction) : [];

  function selectRoute(route: DriverRouteOption) {
    if (disabled) return;
    scope.current.editDraft();
    const next: DriverRouteChoice = { routeId: route.id, direction: draft?.direction ?? "a_to_b", routeUpdatedAt: route.updatedAt };
    draftRef.current = next; setDraft(next); setNotice("");
  }
  function selectDirection(direction: DriverDirection) {
    if (disabled || !draft) return;
    scope.current.editDraft();
    const next = { ...draft, direction };
    draftRef.current = next; setDraft(next); setNotice("");
  }

  async function mutate(clear: boolean) {
    if (disabled || !snapshot || (!clear && !selectedRoute) || (clear && !snapshot.choice)) return;
    const ticket = scope.current.start();
    setSaving(true); setError(""); setNotice(""); publish(false, true);
    try {
      let result: DriverRouteSnapshot;
      if (clear) {
        await client.clear(ticket.signal);
        result = { choice: null, route: null, unavailable_reason: null };
      } else result = await client.save(draftRef.current, routes, ticket.signal);
      if (!scope.current.isCurrent(ticket)) return;
      setSnapshot(result); snapshotRef.current = result;
      if (clear && scope.current.draftUnchanged(ticket)) {
        draftRef.current = null; setDraft(null); scope.current.editDraft();
      }
      setSaving(false); setNotice(clear ? "Выбор маршрута сброшен." : "Маршрут и направление сохранены.");
      publish(true, false, result);
    } catch (e) {
      if (!scope.current.isCurrent(ticket)) return;
      setSaving(false);
      if (e instanceof DriverRouteError && ["ROUTE_CHANGED", "ROUTE_NOT_FOUND", "ROUTE_INACTIVE", "ROUTE_NOT_CONFIGURED"].includes(e.code ?? "")) {
        void load(true, e.code === "ROUTE_CHANGED"
          ? "Маршрут изменился. Проверь обновлённые остановки и сохрани выбор ещё раз."
          : "Маршрут больше недоступен. Выбери другой маршрут или сбрось сохранённый выбор.");
        return;
      }
      setError(e instanceof DriverRouteError && e.code === "DRIVER_ROUTE_BUSY"
        ? "Сначала выйди из очереди, ответь на предложение и заверши текущую поездку."
        : e instanceof Error ? e.message : "Не удалось сохранить выбор маршрута.");
      // A connection failure may hide a committed write; a fresh GET must establish the queue gate.
      publish(false);
    }
  }

  return <View style={s.card} testID="driver-route-picker">
    <Text style={s.heading}>Маршрут водителя</Text>
    <Text style={s.description}>Выбери маршрут и направление, затем сохрани выбор.</Text>
    {loading ? <View style={s.loading}><ActivityIndicator color="#0D735C" /><Text style={s.description}>Загружаем маршруты и сохранённый выбор…</Text></View> : null}
    <View testID="driver-route-status" accessibilityLiveRegion="polite">
      {snapshot?.choice ? <>
        <Text style={s.status}>Сохранено: {snapshot.route?.name ?? snapshot.choice.routeId}{snapshot.route ? ` · ${driverDirectionLabel(snapshot.route, snapshot.choice.direction)}` : ""}</Text>
        {snapshot.unavailable_reason ? <Text style={s.warning}>{unavailableLabels[snapshot.unavailable_reason]} Выбери маршрут заново или сбрось выбор.</Text> : null}
        {snapshot.route && !snapshot.unavailable_reason ? <Text style={s.description}>Очередь: питак {snapshot.choice.direction === "a_to_b" ? "A" : "B"}. Для входа нужно находиться рядом с ним.</Text> : null}
      </> : snapshot ? <Text style={s.status}>Маршрут не выбран. Можно использовать общую очередь.</Text> : null}
      {notice ? <Text style={s.status}>{notice}</Text> : null}
      {error ? <Text style={s.warning}>{error} Обнови маршруты, чтобы проверить сохранённый выбор.</Text> : null}
    </View>
    {!loading && routes.length === 0 ? <Text style={s.description}>Нет доступных настроенных маршрутов. Повтори обновление позже.</Text> : null}
    {routes.map(route => <Pressable key={route.id} testID={`driver-route-${route.id}`} accessibilityRole="radio"
      accessibilityLabel={`Маршрут: ${route.name}`} accessibilityState={{ checked: draft?.routeId === route.id, disabled }}
      aria-checked={draft?.routeId === route.id} aria-disabled={disabled}
      onPress={() => selectRoute(route)} disabled={disabled} style={[s.option, draft?.routeId === route.id && s.selected, disabled && s.disabled]}>
      <Text style={s.optionTitle}>{route.name}</Text>
      <Text style={s.description}>{route.stops[0].name} → {route.stops[route.stops.length - 1].name}</Text>
    </Pressable>)}
    {draft && !selectedRoute && !loading ? <Text style={s.warning}>Маршрут черновика больше недоступен. Выбери другой маршрут.</Text> : null}
    {selectedRoute && draft ? <>
      <Text style={s.label}>НАПРАВЛЕНИЕ</Text>
      {(["a_to_b", "b_to_a"] as const).map(direction => <Pressable key={direction} testID={`driver-direction-${direction}`}
        accessibilityRole="radio" accessibilityLabel={driverDirectionLabel(selectedRoute, direction)}
        accessibilityState={{ checked: draft.direction === direction, disabled }} aria-checked={draft.direction === direction} aria-disabled={disabled} disabled={disabled}
        onPress={() => selectDirection(direction)} style={[s.option, draft.direction === direction && s.selected, disabled && s.disabled]}>
        <Text style={s.optionTitle}>{driverDirectionLabel(selectedRoute, direction)}</Text>
      </Pressable>)}
      <Text style={s.label}>ОСТАНОВКИ ПО НАПРАВЛЕНИЮ</Text>
      <View testID="driver-route-stops">{selectedStops.map((stop, index) => <Text key={stop.id} style={s.description}>{index + 1}. {stop.name} ({stop.code})</Text>)}</View>
      <Text style={s.description}>Выбор в списке — черновик до сохранения.</Text>
    </> : null}
    {!allowed ? <Text style={s.description}>Менять маршрут можно после выхода из очереди, ответа на предложение и завершения поездки.</Text> : null}
    <Action title={saving ? "Сохраняем…" : "Сохранить маршрут"} testID="driver-route-save" onPress={() => { void mutate(false); }} disabled={disabled || !snapshot || !selectedRoute || !!error} />
    {snapshot?.choice ? <Action title="Сбросить выбор маршрута" testID="driver-route-clear" onPress={() => { void mutate(true); }} disabled={disabled || !!error} secondary /> : null}
    <Action title="Обновить маршруты" testID="driver-route-refresh" onPress={() => { void load(true); }} disabled={loading || saving || props.busy} secondary />
  </View>;
}

const s = StyleSheet.create({
  card: { padding: 20, backgroundColor: "#fff", borderRadius: 24, borderWidth: 1, borderColor: "#E5EBE7", marginBottom: 16 },
  heading: { fontSize: 21, fontWeight: "800", color: "#102D26", marginBottom: 12 },
  description: { fontSize: 14, lineHeight: 22, color: "#53675E" },
  loading: { gap: 8, marginVertical: 12 },
  label: { fontSize: 10, fontWeight: "800", letterSpacing: 1, color: "#74857D", marginTop: 12, marginBottom: 8 },
  option: { borderWidth: 1, borderColor: "#E0E8E3", borderRadius: 12, padding: 12, marginTop: 8 },
  selected: { borderColor: "#0D735C", backgroundColor: "#EDF8F2" },
  optionTitle: { color: "#344B41", fontWeight: "700", fontSize: 14 },
  status: { color: "#175444", backgroundColor: "#E9F8EF", padding: 12, borderRadius: 10, marginTop: 12, lineHeight: 21 },
  warning: { color: "#68491D", backgroundColor: "#FFF4DD", padding: 12, borderRadius: 10, marginTop: 12, lineHeight: 21 },
  button: { minHeight: 48, borderRadius: 14, backgroundColor: "#0D735C", alignItems: "center", justifyContent: "center", paddingHorizontal: 12, marginTop: 8 },
  secondary: { backgroundColor: "#F0F5F2", borderWidth: 1, borderColor: "#DCE8E1" },
  buttonText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  secondaryText: { color: "#175444" },
  disabled: { opacity: 0.45 },
});
