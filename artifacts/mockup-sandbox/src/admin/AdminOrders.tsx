import { useEffect, useRef, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { AdminApiError } from "./api";
import { adminOrderStatuses, adminOrderStatusLabels, cancelAdminOrder, isClosedAdminOrder, loadAdminOrders, type AdminOrder, type AdminOrderFilter } from "./orders-api";

const dateTime = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
export default function AdminOrders({ token, onAccessExpired }: { token: string; onAccessExpired: () => void }) {
  const [filter, setFilter] = useState<AdminOrderFilter>("active");
  const [search, setSearch] = useState("");
  const [revision, setRevision] = useState(0);
  const [orders, setOrders] = useState<AdminOrder[] | null>(null);
  const [selected, setSelected] = useState<AdminOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [requiresRefresh, setRequiresRefresh] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const live = useRef(false);
  const mutationLock = useRef(false);
  const mutationAbort = useRef<AbortController | null>(null);
  const keepOrder = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; mutationAbort.current?.abort(); };
  }, [token]);
  useEffect(() => { if (selected) keepOrder.current?.focus(); }, [selected]);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoading(true); setOrders(null); setSelected(null); setError(""); setRequiresRefresh(true);
    void loadAdminOrders(token, filter, controller.signal).then(result => {
      if (current && !controller.signal.aborted) { setOrders(result); mutationLock.current = false; setRequiresRefresh(false); setUpdatedAt(new Date()); }
    }).catch((cause: unknown) => {
      if (!current || controller.signal.aborted) return;
      if (cause instanceof AdminApiError && (cause.status === 401 || cause.status === 403)) onAccessExpired();
      else setError(cause instanceof AdminApiError ? cause.message : "Не удалось загрузить заказы. Повторите обновление.");
    }).finally(() => { if (current && !controller.signal.aborted) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [token, filter, revision, onAccessExpired]);

  function refresh() { setSelected(null); setRequiresRefresh(true); setRevision(value => value + 1); }
  async function confirm() {
    if (!selected || mutationLock.current || requiresRefresh || loading || isClosedAdminOrder(selected)) return;
    const observed = selected;
    mutationLock.current = true;
    const controller = new AbortController(); mutationAbort.current = controller;
    setBusy(true); setError(""); setNotice("");
    try {
      await cancelAdminOrder(token, observed, controller.signal);
      if (!live.current || controller.signal.aborted) return;
      setSelected(null); setRequiresRefresh(true);
      setNotice(`Отмена заказа ${observed.id} подтверждена.`);
      setRevision(value => value + 1);
    } catch (cause: unknown) {
      if (!live.current || controller.signal.aborted) return;
      setSelected(null); setRequiresRefresh(true);
      if (cause instanceof AdminApiError && (cause.status === 401 || cause.status === 403)) onAccessExpired();
      else if (cause instanceof AdminApiError && (cause.status === 409 || cause.status === 404)) setError("Заказ изменился или уже закрыт. Обновите список и примите новое решение.");
      else setError("Результат отмены не подтверждён. Обновите список, прежде чем продолжать. Повторная отмена автоматически не отправляется.");
    } finally {
      // Keep the synchronous mutation fence until an authoritative GET succeeds.
      if (live.current && !controller.signal.aborted) setBusy(false);
    }
  }
  const query = search.trim().toLocaleLowerCase("ru");
  const visible = orders?.filter(order => !query || order.id.toLocaleLowerCase("ru").includes(query)) ?? [];
  return <section data-testid="admin-orders" aria-label="Управление заказами" className="min-w-0">
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-3xl font-bold tracking-tight">Заказы</h1><p className="mt-2 text-sm text-slate-500">Активные и закрытые заказы. Перед отменой проверьте заказ и подтвердите действие.</p></div>
      <button type="button" disabled={busy || loading} onClick={refresh} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium disabled:opacity-50"><RefreshCw size={16} className={loading ? "animate-spin" : ""}/>Обновить заказы</button>
    </div>
    <div className="mb-5 grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:grid-cols-2">
      <label className="text-sm font-medium text-slate-700">Статус заказов<select aria-label="Статус заказов" disabled={busy || loading} value={filter} onChange={event => { setSelected(null); setRequiresRefresh(true); setNotice(""); setFilter(event.target.value as AdminOrderFilter); }} className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 font-normal">
        <option value="active">Активные</option><option value="all">Все</option>{adminOrderStatuses.map(status => <option key={status} value={status}>{adminOrderStatusLabels[status]}</option>)}
      </select></label>
      <label className="min-w-0 text-sm font-medium text-slate-700">Поиск по ID заказа<input type="search" disabled={busy} maxLength={100} value={search} onChange={event => { setSelected(null); setSearch(event.target.value); }} className="mt-2 w-full min-w-0 rounded-xl border border-slate-200 px-3 py-2.5 font-normal"/></label>
    </div>
    {notice ? <p role="status" className="mb-4 break-words rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</p> : null}
    {error ? <p role="alert" className="mb-4 flex items-start gap-2 rounded-xl bg-red-50 p-4 text-sm text-red-700"><CircleAlert size={18} className="shrink-0"/>{error}</p> : null}
    {selected ? <section role="alertdialog" aria-labelledby="admin-cancel-title" aria-describedby="admin-cancel-description" className="mb-5 rounded-2xl border border-red-200 bg-white p-5">
      <h2 id="admin-cancel-title" className="text-lg font-semibold">Отменить этот заказ?</h2><div id="admin-cancel-description" className="mt-3 space-y-2 text-sm text-slate-600"><p className="break-all font-mono">{selected.id}</p><p>{selected.pickup} → {selected.destination} · Мест: {selected.seats}</p><p>Статус: {adminOrderStatusLabels[selected.status]}</p><p>Отмена прекратит заказ и освободит зарезервированные места.</p></div>
      <div className="mt-4 flex flex-wrap gap-3"><button ref={keepOrder} type="button" disabled={busy} onClick={() => setSelected(null)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium disabled:opacity-50">Сохранить заказ</button><button type="button" disabled={busy || loading || requiresRefresh} onClick={() => void confirm()} className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Отменяем…" : "Подтвердить отмену"}</button></div>
    </section> : null}
    {loading ? <p role="status" className="py-8 text-center text-sm text-slate-500">Загружаем заказы…</p> : null}
    {!loading && orders !== null ? <>
      <p className="mb-4 text-xs text-slate-500">Показано: {visible.length} из полученных {orders.length}. {updatedAt ? `Обновлено: ${updatedAt.toLocaleTimeString("ru-RU")}.` : ""} Данные обновляются по нажатию.{requiresRefresh ? " Перед отменой требуется обновление." : ""}</p>
      {visible.length === 0 ? <p className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-500">Заказы по заданным фильтрам не найдены.</p> : <ol aria-label="Список заказов" className="space-y-3">{visible.map(order => <li key={order.id} data-testid={`admin-order-${order.id}`} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 text-sm">
        <div className="flex flex-wrap justify-between gap-3"><h2 className="break-all font-mono font-semibold">{order.id}</h2><span className="rounded-lg bg-slate-100 px-3 py-1 text-xs font-medium">{adminOrderStatusLabels[order.status]}</span></div>
        <p className="mt-3 break-words font-medium">{order.pickup} → {order.destination}</p><p className="mt-2 text-slate-600">Мест: {order.seats} · Стоимость: {new Intl.NumberFormat("ru-RU").format(order.total)} {order.currency === "UZS" ? "сум" : "₸"}</p>
        <dl className="my-3 grid min-w-0 gap-3 text-xs text-slate-500 sm:grid-cols-2"><div>Пассажир<dd className="mt-1 break-all font-mono text-slate-700">{order.passengerId}</dd></div><div>{order.driverId ? "Водитель" : "Предложен водителю"}<dd className="mt-1 break-all font-mono text-slate-700">{order.driverId ?? order.offeredDriverId ?? "Не назначен"}</dd></div></dl>
        <p className="mb-4 text-xs text-slate-500">Создан: {dateTime(order.createdAt)} · Изменён: {dateTime(order.updatedAt)}</p>
        {isClosedAdminOrder(order) ? <p className="text-xs text-slate-500">Заказ закрыт.</p> : <button type="button" data-testid={`admin-cancel-open-${order.id}`} disabled={busy || loading || requiresRefresh || selected !== null} onClick={() => { if (!mutationLock.current) { setSelected(order); setError(""); } }} className="rounded-xl border border-red-200 px-4 py-2.5 text-sm font-semibold text-red-700 disabled:opacity-50">Отменить заказ</button>}
      </li>)}</ol>}
    </> : null}
  </section>;
}
