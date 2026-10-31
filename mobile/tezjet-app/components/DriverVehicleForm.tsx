import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { validateApiEndpoint } from "../lib/api";
import { driverVehicleBody, parseDriverVehicleSnapshot, type DriverVehicleSnapshot, type VehicleDraft } from "../lib/driver-vehicle";

type Props = { endpoint: string; token: string; blocked: boolean; onBusyChange: (busy: boolean) => void; onSaved: (value: DriverVehicleSnapshot) => void };
const empty: VehicleDraft = { make: "", model: "", plate_number: "", seat_capacity: 3 };
export default function DriverVehicleForm({ endpoint, token, blocked, onBusyChange, onSaved }: Props) {
  const [snapshot, setSnapshot] = useState<DriverVehicleSnapshot | null>(null);
  const [draft, setDraft] = useState(empty);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0), savingRef = useRef(false);
  const activeController = useRef<AbortController | null>(null);
  const call = useCallback(async (method: "GET" | "PUT", signal: AbortSignal, body?: unknown) => {
    const response = await fetch(validateApiEndpoint(endpoint) + "/api/driver/vehicle", { method, signal, cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(value?.error?.code === "VEHICLE_CHANGED" ? "Автомобиль изменился. Обнови профиль и проверь данные перед сохранением."
      : value?.error?.code === "DRIVER_VEHICLE_BUSY" ? "Сначала заверши поездки и выйди из очереди, затем изменяй автомобиль."
      : "Не удалось сохранить или получить автомобиль. Проверь данные и повтори обновление.");
    return parseDriverVehicleSnapshot(value);
  }, [endpoint, token]);

  const load = useCallback(async () => {
    const ticket = ++generation.current;
    activeController.current?.abort(); const controller = new AbortController(); activeController.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    setLoading(true); setError("");
    try { const value = await call("GET", controller.signal);
      if (generation.current !== ticket || controller.signal.aborted) return;
      setSnapshot(value); setDraft(value.driver_vehicle ?? empty);
    } catch { if (generation.current === ticket) setError("Не удалось получить автомобиль. Повтори обновление."); }
    finally { clearTimeout(timer); if (generation.current === ticket) setLoading(false); }
  }, [call]);
  useEffect(() => { void load(); return () => { generation.current++; activeController.current?.abort(); }; }, [load]);

  async function save() {
    if (blocked || loading || !snapshot || savingRef.current) return;
    let body: ReturnType<typeof driverVehicleBody>;
    try { body = driverVehicleBody(draft, snapshot.driver_vehicle); } catch (reason) { setError((reason as Error).message); return; }
    savingRef.current = true; setSaving(true); onBusyChange(true); setError(""); setNotice("");
    const ticket = ++generation.current, controller = new AbortController(); activeController.current?.abort(); activeController.current = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try { const value = await call("PUT", controller.signal, body);
      if (!value.driver_vehicle || (value.approval_status !== "pending" && value.approval_status !== "blocked")) throw new Error("Сервер не подтвердил сохранение автомобиля. Повтори обновление.");
      if (generation.current !== ticket || controller.signal.aborted) return;
      setSnapshot(value); setDraft(value.driver_vehicle!); setNotice(value.approval_status === "blocked" ? "Автомобиль сохранён. Блокировка водителя остаётся; снять её может только администратор." : "Автомобиль сохранён и отправлен администратору на проверку."); onSaved(value);
    } catch (reason) { if (generation.current === ticket) setError(reason instanceof Error && reason.name !== "AbortError" ? reason.message : "Ответ не получен. Обнови профиль, чтобы проверить результат сохранения."); }
    finally { clearTimeout(timer); savingRef.current = false; setSaving(false); onBusyChange(false); }
  }
  const disabled = loading || saving || blocked;
  const current = snapshot?.driver_vehicle;
  const dirty = !current || draft.make.trim() !== current.make || draft.model.trim() !== current.model || draft.plate_number.trim() !== current.plate_number || draft.seat_capacity !== current.seat_capacity;
  return <View style={s.card} testID="driver-vehicle-form"><Text style={s.heading}>Мой автомобиль</Text>
    <Text style={s.note}>После изменения нужна повторная проверка администратора.</Text>
    {snapshot?.approval_status === "blocked" ? <Text testID="driver-blocked-status" style={s.note}>Работа водителем заблокирована администратором.</Text> : null}
    {loading ? <Text>Загружаем автомобиль…</Text> : null}
    <TextInput testID="driver-vehicle-make" accessibilityLabel="Марка автомобиля" placeholder="Марка автомобиля" style={s.input} editable={!disabled} value={draft.make} onChangeText={make => setDraft(value => ({ ...value, make }))} />
    <TextInput testID="driver-vehicle-model" accessibilityLabel="Модель автомобиля" placeholder="Модель автомобиля" style={s.input} editable={!disabled} value={draft.model} onChangeText={model => setDraft(value => ({ ...value, model }))} />
    <TextInput testID="driver-vehicle-plate" accessibilityLabel="Госномер" placeholder="Госномер" style={s.input} editable={!disabled} autoCapitalize="characters" value={draft.plate_number} onChangeText={plate_number => setDraft(value => ({ ...value, plate_number }))} />
    <Text style={s.note}>Пассажирских мест, без водителя: 1–8</Text><TextInput testID="driver-vehicle-seats" accessibilityLabel="Пассажирских мест" style={s.input} keyboardType="number-pad" editable={!disabled} value={String(draft.seat_capacity)} onChangeText={value => setDraft(current => ({ ...current, seat_capacity: Number(value) }))} />
    {blocked ? <Text style={s.note}>Изменение доступно после завершения поездок и выхода из очереди.</Text> : null}
    {error ? <Text style={s.note} testID="driver-vehicle-error">{error}</Text> : null}{notice ? <Text style={s.note} testID="driver-vehicle-notice">{notice}</Text> : null}
    <Pressable accessibilityRole="button" testID="driver-vehicle-save" disabled={disabled || !snapshot || !dirty} onPress={() => { void save(); }} style={s.button}><Text>Сохранить автомобиль</Text></Pressable>
    <Pressable accessibilityRole="button" testID="driver-vehicle-refresh" disabled={saving || loading} onPress={() => { void load(); }} style={s.button}><Text>Обновить автомобиль</Text></Pressable>
  </View>;
}
const s = StyleSheet.create({ card: { padding: 20, marginBottom: 16, backgroundColor: "#fff", borderRadius: 24, gap: 10 }, heading: { fontSize: 20, fontWeight: "700", color: "#102D26" },
  note: { color: "#53675E", lineHeight: 21 }, input: { borderWidth: 1, borderColor: "#DCE5DF", borderRadius: 12, padding: 12 }, button: { backgroundColor: "#EDF8F2", padding: 14, borderRadius: 12 } });
