import { useEffect, useRef, useState } from "react";
import { AdminApiError, reviewDriverVehicle, setDriverBlocked, type AdminRecord } from "./api";

export default function DriverVehicleReview({ driver, token, onReviewed, onAccessExpired }: {
  driver: AdminRecord; token: string; onReviewed: () => void; onAccessExpired: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [blockDecision, setBlockDecision] = useState<boolean | null>(null);
  const active = useRef(true), inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function decide(status: "approved" | "rejected") {
    if (inFlight.current || !driver.driver_vehicle || driver.driver_approval_status === "blocked") return;
    inFlight.current = true; setBusy(true); setError("");
    try { await reviewDriverVehicle(token, driver.id, status, driver.driver_vehicle.revision);
      if (active.current) onReviewed();
    } catch (reason) {
      if (!active.current) return;
      if (reason instanceof AdminApiError && (reason.status === 401 || reason.status === 403)) onAccessExpired();
      setError(reason instanceof AdminApiError && reason.code === "VEHICLE_REVIEW_CHANGED"
        ? "Автомобиль изменился. Обновите список и проверьте новые данные."
        : "Не удалось изменить одобрение. Обновите список и повторите проверку.");
    } finally { inFlight.current = false; if (active.current) setBusy(false); }
  }

  async function changeBlock() {
    if (inFlight.current || blockDecision === null) return;
    const decision = blockDecision;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await setDriverBlocked(token, driver.id, decision, driver.driver_vehicle?.revision ?? null);
      if (active.current) { setBlockDecision(null); onReviewed(); }
    } catch (reason) {
      if (!active.current) return;
      if (reason instanceof AdminApiError && (reason.status === 401 || reason.status === 403)) onAccessExpired();
      setBlockDecision(null);
      setError(reason instanceof AdminApiError && reason.code === "VEHICLE_REVIEW_CHANGED"
        ? "Автомобиль изменился. Обновите список перед решением о блокировке."
        : "Результат блокировки не подтверждён. Обновите список перед повторным действием.");
    } finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  const isBlocked = driver.driver_approval_status === "blocked";
  const vehicle = driver.driver_vehicle;
  return <div className="mt-3 min-w-[200px] space-y-2" data-testid={`driver-vehicle-review-${driver.id}`}>
    {vehicle ? <><p className="font-medium">{vehicle.make} {vehicle.model}</p><p>Госномер: {vehicle.plate_number}</p><p>Пассажирских мест: {vehicle.seat_capacity}</p>
      <div className="flex flex-wrap gap-2"><button type="button" data-testid={`driver-vehicle-approve-${driver.id}`} disabled={busy || isBlocked} onClick={() => void decide("approved")} className="rounded-lg border px-3 py-2 text-emerald-700 disabled:opacity-50">Одобрить автомобиль</button>
      <button type="button" data-testid={`driver-vehicle-reject-${driver.id}`} disabled={busy || isBlocked} onClick={() => void decide("rejected")} className="rounded-lg border px-3 py-2 text-red-700 disabled:opacity-50">Отклонить</button></div></> : <p className="text-slate-500">Автомобиль не заполнен.</p>}
    {isBlocked ? <p className="font-medium text-red-700">Работа водителем заблокирована.</p> : null}
    {blockDecision === null ? <button type="button" data-testid={`driver-block-${driver.id}`} disabled={busy}
      onClick={() => { setError(""); setBlockDecision(!isBlocked); }}
      className="rounded-lg border px-3 py-2 text-red-700 disabled:opacity-50">{isBlocked ? "Снять блокировку" : "Заблокировать"}</button>
      : <div role="alertdialog" aria-label="Подтверждение блокировки водителя" className="space-y-2 rounded-lg border border-red-200 p-3">
        <p>{blockDecision ? "Закрыть доступ к работе водителем? Активные заказы автоматически не отменяются."
          : "Снять блокировку? После этого автомобиль потребуется одобрить отдельно."}</p>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => { void changeBlock(); }} className="rounded-lg border px-3 py-2">Подтвердить</button>
        <button type="button" disabled={busy} onClick={() => setBlockDecision(null)} className="rounded-lg border px-3 py-2">Отмена</button></div>
      </div>}
    {error ? <p role="alert" className="text-red-700">{error}</p> : null}
  </div>;
}
