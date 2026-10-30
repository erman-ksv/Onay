import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { AdminApiError } from "./api";
import { loadTripStatistics, tripStatuses, type TripStatistics } from "./statistics-api";

const labels = { searching: "Поиск водителя", en_route_to_c: "Водитель едет", arrived_at_c: "Водитель прибыл", boarded_waiting: "Ожидание отправления", in_transit: "В пути", completed: "Завершены", cancelled: "Отменены" };
const number = new Intl.NumberFormat("ru-RU");
export default function AdminStatistics({ token, onAccessExpired }: { token: string; onAccessExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<TripStatistics | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);
  const [updated, setUpdated] = useState<Date | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setSnapshot(null); setUpdated(null); setPhase("loading");
    void loadTripStatistics(token, controller.signal).then(value => {
      if (!active || controller.signal.aborted) return;
      setSnapshot(value); setUpdated(new Date()); setPhase("ready");
    }).catch(error => {
      if (!active) return;
      setSnapshot(null); setUpdated(null); setPhase("error");
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) onAccessExpired();
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [token, revision, onAccessExpired]);
  return <section data-testid="admin-statistics" aria-label="Статистика поездок" className="min-w-0 space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-3xl font-bold tracking-tight">Статистика поездок</h1><p className="mt-2 text-sm text-slate-500">За всю историю. Сумма тарифов завершённых заказов без подтверждения оплаты и вычета расходов.</p></div>
      <button type="button" disabled={phase === "loading"} onClick={() => { setSnapshot(null); setUpdated(null); setPhase("loading"); setRevision(value => value + 1); }} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold disabled:opacity-50"><RefreshCw size={16}/>Обновить статистику</button></div>
    {phase === "loading" ? <p role="status">Загружаем статистику…</p> : null}
    {phase === "error" ? <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-700">Не удалось получить статистику. Повторите обновление.</p> : null}
    {snapshot ? <div data-testid="statistics-snapshot" className="space-y-5">
      {updated ? <p className="text-xs text-slate-500">Обновлено: {updated.toLocaleTimeString("ru-RU")}</p> : null}
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{([ ["total", "Все заказы"], ["active", "Активные"], ["completed", "Завершены"], ["cancelled", "Отменены"] ] as const).map(([key, label]) => <div key={key} className="rounded-2xl border border-slate-200 bg-white p-5"><dt className="text-sm text-slate-500">{label}</dt><dd data-testid={`statistics-${key}`} className="mt-2 text-3xl font-bold tabular-nums">{number.format(snapshot.statistics[key])}</dd></div>)}</dl>
      {snapshot.statistics.total === 0 ? <p data-testid="statistics-empty" className="text-slate-500">Поездок пока нет.</p> : null}
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="text-xl font-semibold">Сумма тарифов завершённых поездок</h2><p className="mt-2 text-sm text-slate-500">Каждый заказ учтён один раз. Отменённые и активные не включены. Валюты не конвертируются.</p>
        {snapshot.fare_summary.totals === null ? <p data-testid="statistics-incomplete" role="status" className="mt-4 text-amber-800">Полная сумма недоступна.{snapshot.fare_summary.missing_fare_orders ? ` Без достоверного тарифа: ${snapshot.fare_summary.missing_fare_orders}.` : ""}{snapshot.fare_summary.overflow ? " Сумма превышает поддерживаемый диапазон." : ""}</p>
          : snapshot.fare_summary.totals.length === 0 ? <p className="mt-4 text-slate-500">Завершённых поездок пока нет.</p> : <ul className="mt-4 space-y-3">{snapshot.fare_summary.totals.map(row => <li key={row.currency} data-testid={`statistics-fare-${row.currency}`} className="text-lg font-semibold">{number.format(row.total)} {row.currency === "UZS" ? "сум" : "₸"}<span className="ml-2 text-sm font-normal text-slate-500">· заказов: {number.format(row.orders)}</span></li>)}</ul>}
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5"><h2 className="text-xl font-semibold">По статусам</h2><dl className="mt-4 grid gap-3 sm:grid-cols-2">{tripStatuses.map(status => <div key={status} className="flex justify-between gap-4"><dt>{labels[status]}</dt><dd data-testid={`statistics-status-${status}`} className="tabular-nums">{number.format(snapshot.statistics.by_status[status])}</dd></div>)}</dl></div>
    </div> : null}
  </section>;
}
