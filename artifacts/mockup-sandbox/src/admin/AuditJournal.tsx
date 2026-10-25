import { useEffect, useState, type FormEvent } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { AdminApiError, loadAdminAuditEvents, type AdminAuditEvent, type AdminAuditFilters } from "./api";

const initialFilters: AdminAuditFilters = { orderId: "", driverId: "", routeId: "", limit: 50 };
const actions = { "order.cancelled": "Заказ отменён администратором", "driver.approval_changed": "Решение по водителю изменено", "route.updated": "Маршрут изменён" };
const statuses: Record<string, string> = { pending: "На проверке", approved: "Одобрен", rejected: "Отклонён", searching: "Поиск водителя", en_route_to_c: "Едет к точке посадки", arrived_at_c: "Прибыл к точке посадки", boarded_waiting: "Ожидает отправления", in_transit: "В пути", completed: "Завершён", cancelled: "Отменён" };
const fields: Record<string, string> = { name: "Название", active: "Активность", pricePerStop: "Тариф", pricePerStopKzt: "Тариф" };
function dateTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}
function Details({ event }: { event: AdminAuditEvent }) {
  if (event.action === "route.updated") return <>
    <p>Изменены поля: {event.changedFields?.map(field => fields[field] ?? field).join(", ") || "—"}</p>
    <p className="mt-1 text-xs text-slate-500">Предыдущая версия: <span className="break-all">{event.previousVersion || "—"}</span></p>
    <p className="text-xs text-slate-500">Новая версия: <span className="break-all">{event.nextVersion || "—"}</span></p>
  </>;
  return <>
    <p>{statuses[event.fromStatus ?? ""] ?? event.fromStatus ?? "—"} → {statuses[event.toStatus ?? ""] ?? event.toStatus ?? "—"}</p>
    {event.vehicleRevision ? <p className="mt-1 break-all text-xs text-slate-500">Версия автомобиля: {event.vehicleRevision}</p> : null}
  </>;
}

/** Read-only server audit. Unmounting or changing a session aborts and discards pending reads. */
export default function AuditJournal({ token, onAccessExpired }: { token: string; onAccessExpired: () => void }) {
  const [draft, setDraft] = useState<AdminAuditFilters>({ ...initialFilters });
  const [applied, setApplied] = useState<AdminAuditFilters>({ ...initialFilters });
  const [revision, setRevision] = useState(0);
  const [events, setEvents] = useState<AdminAuditEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoading(true); setError(""); setEvents(null);
    void loadAdminAuditEvents(token, applied, controller.signal).then(result => {
      if (current && !controller.signal.aborted) setEvents(result);
    }).catch((cause: unknown) => {
      if (!current || controller.signal.aborted) return;
      if (cause instanceof AdminApiError && (cause.status === 401 || cause.status === 403)) {
        onAccessExpired();
      } else setError(cause instanceof AdminApiError ? cause.message : "Не удалось связаться с сервером.");
    }).finally(() => {
      if (current && !controller.signal.aborted) setLoading(false);
    });
    return () => { current = false; controller.abort(); };
  }, [token, applied, revision, onAccessExpired]);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEvents(null);
    setApplied({ ...draft, orderId: draft.orderId.trim(), driverId: draft.driverId.trim(), routeId: draft.routeId.trim() });
  }
  function reset() {
    setDraft({ ...initialFilters }); setApplied({ ...initialFilters }); setEvents(null);
  }
  return <section aria-label="Журнал действий администраторов" data-testid="admin-audit-journal" className="min-w-0">
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-3xl font-bold tracking-tight">Журнал действий</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Отмены заказов, решения по водителям и изменения названия, активности и тарифа маршрутов. Изменения остановок и геометрии пока не входят в журнал.</p></div>
      <button type="button" disabled={loading} onClick={() => { setEvents(null); setRevision(value => value + 1); }} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium disabled:opacity-50"><RefreshCw size={16} className={loading ? "animate-spin" : ""}/>Обновить журнал</button>
    </div>
    <form onSubmit={apply} aria-label="Фильтры журнала" className="mb-5 grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-4">
      {([{ key: "orderId", label: "ID заказа" }, { key: "driverId", label: "ID водителя" }, { key: "routeId", label: "ID маршрута" }] as const).map(field => <label key={field.key} className="min-w-0 text-sm font-medium text-slate-700">{field.label}
        <input value={draft[field.key]} maxLength={100} autoComplete="off" onChange={event => setDraft(value => ({ ...value, [field.key]: event.target.value }))} className="mt-2 w-full min-w-0 rounded-xl border border-slate-200 px-3 py-2.5 font-normal outline-none focus:border-blue-600"/>
      </label>)}
      <label className="text-sm font-medium text-slate-700">Показывать не более
        <select aria-label="Показывать не более" value={draft.limit} onChange={event => setDraft(value => ({ ...value, limit: Number(event.target.value) }))} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 font-normal">{[25, 50, 100].map(limit => <option key={limit} value={limit}>{limit} событий</option>)}</select>
      </label>
      <div className="flex flex-wrap gap-3 sm:col-span-2 lg:col-span-4">
        <button type="submit" disabled={loading} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">Применить фильтры</button>
        <button type="button" disabled={loading} onClick={reset} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium disabled:opacity-50">Сбросить фильтры</button>
      </div>
    </form>
    {error ? <p role="alert" className="mb-4 flex items-start gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-700"><CircleAlert size={18} className="shrink-0"/>{error} Нажмите «Обновить журнал», чтобы повторить.</p> : null}
    {loading ? <p role="status" className="py-8 text-center text-sm text-slate-500">Загружаем журнал…</p> : null}
    {!loading && !error && events !== null ? <>
      <p role="status" className="mb-4 text-sm text-slate-500">Показано событий: {events.length}. Последние не более {applied.limit} по заданным фильтрам, новые сверху. Время устройства.</p>
      {events.length === 0 ? <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-500">По заданным фильтрам событий нет.</p> : <ol className="space-y-3" aria-label="События журнала">{events.map(event => <li key={event.id} data-testid={`audit-event-${event.id}`} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="font-semibold text-slate-900">{actions[event.action]}</h2><time dateTime={event.createdAt} className="text-xs text-slate-500">{dateTime(event.createdAt)}</time></div>
        <dl className="my-3 grid min-w-0 gap-2 text-xs text-slate-500 sm:grid-cols-2"><div>Администратор<dd className="mt-1 break-all font-mono text-slate-700">{event.actorId}</dd></div><div>{event.routeId ? "Маршрут" : event.driverId ? "Водитель" : "Заказ"}<dd className="mt-1 break-all font-mono text-slate-700">{event.routeId ?? event.driverId ?? event.orderId}</dd></div></dl>
        <div className="text-slate-600"><Details event={event}/></div>
        <p className="mt-3 break-all font-mono text-[11px] text-slate-400">Событие: {event.id}</p>
      </li>)}</ol>}
    </> : null}
  </section>;
}
