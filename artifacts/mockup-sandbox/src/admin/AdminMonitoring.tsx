import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { AdminApiError } from "./api";
import { adminOrderStatusLabels } from "./orders-api";
import { loadAdminMonitoring, type AdminMonitoringSnapshot } from "./monitoring-api";

const errorMessage = "Не удалось обновить мониторинг. Автообновление остановлено. Повторите загрузку.";
type Phase = "loading" | "live" | "paused" | "error";

/** Read-only polling. A failed or interrupted pair never becomes a current snapshot. */
export default function AdminMonitoring({ token, onAccessExpired }: { token: string; onAccessExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<AdminMonitoringSnapshot | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [automatic, setAutomatic] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    let failed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const visibleOnline = () => document.visibilityState !== "hidden" && navigator.onLine !== false;
    const cancel = () => {
      clearTimeout(timer); clearTimeout(deadline);
      controller?.abort(); controller = null; inFlight = false;
    };
    const clear = () => { setSnapshot(null); setUpdatedAt(null); };
    const load = async () => {
      if (!active || inFlight || failed) return;
      if (!visibleOnline()) { clear(); setPhase("paused"); return; }
      inFlight = true;
      const request = new AbortController();
      controller = request;
      clear(); setPhase("loading");
      let expired = false;
      let succeeded = false;
      deadline = setTimeout(() => {
        if (!active || controller !== request) return;
        expired = true; failed = true; request.abort();
        clear(); setPhase("error");
      }, 10_000);
      try {
        const result = await loadAdminMonitoring(token, request.signal);
        if (!active || controller !== request || request.signal.aborted) return;
        setSnapshot(result); setUpdatedAt(new Date()); setPhase("live"); succeeded = true;
      } catch (error) {
        if (!active || controller !== request || (request.signal.aborted && !expired)) return;
        request.abort(); // Cancel the sibling read if one of the pair failed.
        failed = true; clear(); setPhase("error");
        if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) onAccessExpired();
      } finally {
        if (controller === request) {
          clearTimeout(deadline); controller = null; inFlight = false;
          if (active && succeeded && automatic && visibleOnline()) timer = setTimeout(() => { void load(); }, 10_000);
        }
      }
    };
    const environmentChanged = () => {
      cancel(); clear();
      if (!visibleOnline()) setPhase("paused");
      else if (failed) setPhase("error");
      else void load();
    };
    document.addEventListener("visibilitychange", environmentChanged);
    window.addEventListener("offline", environmentChanged);
    window.addEventListener("online", environmentChanged);
    void load();
    return () => {
      active = false; cancel();
      document.removeEventListener("visibilitychange", environmentChanged);
      window.removeEventListener("offline", environmentChanged);
      window.removeEventListener("online", environmentChanged);
    };
  }, [token, automatic, revision, onAccessExpired]);

  return <section data-testid="admin-monitoring" aria-label="Мониторинг поездок и очередей" className="min-w-0 space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-3xl font-bold tracking-tight">Мониторинг</h1><p className="mt-2 text-sm text-slate-500">Активные заказы и FIFO по маршрутам. Для отмены откройте раздел «Заказы».</p></div>
      <button type="button" disabled={phase === "loading"} onClick={() => setRevision(value => value + 1)} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold disabled:opacity-50"><RefreshCw size={16}/>Обновить мониторинг</button>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
      <label className="flex items-center gap-2"><input type="checkbox" checked={automatic} onChange={event => setAutomatic(event.target.checked)}/>Автообновление каждые 10 секунд</label>
      {updatedAt ? <span>Обновлено: {updatedAt.toLocaleTimeString("ru-RU")}</span> : null}
    </div>
    {phase === "loading" ? <p role="status">Загружаем мониторинг…</p> : null}
    {phase === "paused" ? <p role="status" className="rounded-xl bg-amber-50 p-4 text-amber-900">Обновление приостановлено: проверьте подключение и вернитесь на вкладку.</p> : null}
    {phase === "error" ? <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-700">{errorMessage}</p> : null}
    {snapshot ? <div data-testid="monitor-snapshot" className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">Активные заказы</p><p className="mt-1 text-3xl font-bold tabular-nums">{snapshot.orders.length}</p></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><p className="text-sm text-slate-500">Водители в FIFO</p><p className="mt-1 text-3xl font-bold tabular-nums">{snapshot.queue.length}</p></div>
      </div>
      <div><h2 className="mb-3 text-xl font-semibold">Активные поездки</h2>
        {snapshot.orders.length === 0 ? <p className="rounded-2xl border border-slate-200 bg-white p-5 text-slate-500">Активных заказов нет.</p> : <ul className="grid gap-3 lg:grid-cols-2">{snapshot.orders.map(order => <li key={order.id} data-testid={`monitor-order-${order.id}`} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 text-sm">
          <p className="font-semibold">{adminOrderStatusLabels[order.status]}</p><p className="mt-2 break-all font-mono text-xs text-slate-500">{order.id}</p>
          <p className="mt-3 break-words">{order.pickup} → {order.destination}</p><p>Мест: {order.seats}</p>
          <p className="font-semibold">{new Intl.NumberFormat("ru-RU").format(order.total)} {order.currency === "UZS" ? "сум" : "KZT (исторический тариф)"}</p>
          <p className="mt-2 break-all text-slate-500">{order.driverId ? "Водитель: " + order.driverId : order.offeredDriverId ? "Предложено водителю: " + order.offeredDriverId : "Водитель ещё не назначен"}</p>
        </li>)}</ul>}
      </div>
      <div><h2 className="mb-3 text-xl font-semibold">Очереди водителей</h2>
        {snapshot.queue.length === 0 ? <p className="rounded-2xl border border-slate-200 bg-white p-5 text-slate-500">В очереди нет водителей.</p> : <ul className="grid gap-3 lg:grid-cols-2">{snapshot.queue.map(entry => <li key={entry.driverId} data-testid={`monitor-driver-${entry.driverId}`} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 text-sm">
          {entry.lane.kind === "configured" ? <><p className="break-words font-semibold">{entry.lane.routeName} · {entry.lane.direction === "a_to_b" ? "A → B" : "B → A"}</p><p className="break-words">Питак {entry.lane.pitak} · {entry.lane.stopName}</p><p className="mt-1 break-all font-mono text-xs text-slate-400">{entry.lane.routeId}</p></> : <p className="font-semibold">Прежняя очередь</p>}
          <p className="mt-3">Место в очереди: {entry.position}</p><p>Свободных мест: {entry.availableSeats}</p><p className="mt-2 break-all font-mono text-xs text-slate-500">{entry.driverId}</p>
        </li>)}</ul>}
      </div>
      <p className="text-xs text-slate-500">Заказы и очередь обновляются отдельно; показатели могут измениться между обновлениями. Позиция FIFO относится только к указанной линии.</p>
    </div> : null}
  </section>;
}
