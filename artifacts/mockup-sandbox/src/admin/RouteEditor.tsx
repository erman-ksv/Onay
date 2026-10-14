import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, CircleAlert, MapPin, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import {
  AdminApiError, createAdminRoute, loadAdminRoute, loadAdminRoutes, saveAdminRouteLayout,
  type AdminRoute,
} from "./api";
import { buildRouteLayout, draftFromRoute, type RouteDraft, type StopDraft } from "./route-form";

const inputClass = "mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50";
const buttonClass = "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50";

export default function RouteEditor({ token, onAccessExpired }: { token: string; onAccessExpired: () => void }) {
  const [routes, setRoutes] = useState<AdminRoute[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [current, setCurrent] = useState<AdminRoute | null>(null);
  const [draft, setDraft] = useState<RouteDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [routeName, setRouteName] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const [error, setError] = useState("");
  const [createError, setCreateError] = useState("");
  const [success, setSuccess] = useState("");
  const [conflict, setConflict] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<string | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const catalogRequest = useRef(0);
  const detailRequest = useRef(0);
  const revision = useRef(0);
  const nextStopKey = useRef(0);
  const active = useRef(true);
  const catalogAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);

  const handleError = useCallback((cause: unknown, setMessage: (message: string) => void) => {
    if (!active.current) return;
    if (cause instanceof AdminApiError && (cause.status === 401 || cause.status === 403)) {
      onAccessExpired();
    } else {
      setMessage(cause instanceof Error ? cause.message : "Не удалось выполнить запрос.");
    }
  }, [onAccessExpired]);

  useEffect(() => {
    active.current = true;
    // A completed request from a logged-out editor cannot expire a newer login.
    return () => { active.current = false; };
  }, []);

  const refreshCatalog = useCallback(async () => {
    catalogAbort.current?.abort();
    const controller = new AbortController();
    catalogAbort.current = controller;
    const request = ++catalogRequest.current;
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const list = await loadAdminRoutes(token, controller.signal);
      if (request !== catalogRequest.current || controller.signal.aborted) return;
      setRoutes(list);
      // Reloading the catalog never replaces an already selected route's draft.
      setSelectedId(previous => previous || list[0]?.id || "");
    } catch (cause) {
      if (!controller.signal.aborted && request === catalogRequest.current) handleError(cause, setCatalogError);
    } finally {
      if (!controller.signal.aborted && request === catalogRequest.current) setCatalogLoading(false);
    }
  }, [token, handleError]);

  const loadDetail = useCallback(async (id: string) => {
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    const request = ++detailRequest.current;
    const startingRevision = revision.current;
    setDetailLoading(true);
    setError("");
    try {
      const route = await loadAdminRoute(token, id, controller.signal);
      if (request !== detailRequest.current || controller.signal.aborted || startingRevision !== revision.current) return;
      setCurrent(route);
      setDraft(draftFromRoute(route));
      setDirty(false);
      setConflict(false);
      setPendingRoute(null);
      setSuccess("");
      setRoutes(previous => previous.map(item => item.id === route.id ? route : item));
    } catch (cause) {
      if (!controller.signal.aborted && request === detailRequest.current) handleError(cause, setError);
    } finally {
      if (!controller.signal.aborted && request === detailRequest.current) setDetailLoading(false);
    }
  }, [token, handleError]);

  useEffect(() => {
    void refreshCatalog();
    return () => catalogAbort.current?.abort();
  }, [refreshCatalog]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    return () => detailAbort.current?.abort();
  }, [selectedId, loadDetail]);

  function activateRoute(id: string) {
    if (id === selectedId) return;
    detailAbort.current?.abort();
    detailRequest.current++;
    revision.current++;
    setCurrent(null);
    setDraft(null);
    setDirty(false);
    setConflict(false);
    setError("");
    setSuccess("");
    setConfirmReload(false);
    setPendingRoute(null);
    setSelectedId(id);
  }

  function chooseRoute(id: string) {
    if (id === selectedId) return;
    if (dirty) setPendingRoute(id);
    else activateRoute(id);
  }

  function changeDraft(update: (previous: RouteDraft) => RouteDraft) {
    revision.current++;
    setDraft(previous => previous ? update(previous) : previous);
    setDirty(true);
    setError("");
    setSuccess("");
  }

  function updateStop(key: string, field: keyof Pick<StopDraft, "code" | "name" | "latitude" | "longitude">, value: string) {
    changeDraft(previous => ({ ...previous, stops: previous.stops.map(stop => stop.key === key ? { ...stop, [field]: value } : stop) }));
  }

  function moveStop(index: number, direction: -1 | 1) {
    changeDraft(previous => {
      const stops = [...previous.stops];
      [stops[index], stops[index + direction]] = [stops[index + direction], stops[index]];
      return { ...previous, stops };
    });
  }

  function addStop() {
    const key = "new-stop-" + (++nextStopKey.current);
    changeDraft(previous => ({ ...previous, stops: [...previous.stops, { key, code: "", name: "", latitude: "", longitude: "" }] }));
  }

  function reloadRoute() {
    if (dirty) setConfirmReload(true);
    else if (selectedId) void loadDetail(selectedId);
  }

  async function createRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    const name = routeName.trim();
    if (!name || name.length > 120) {
      setCreateError("Введите название маршрута: от 1 до 120 символов.");
      return;
    }
    setCreating(true);
    setCreateError("");
    try {
      const route = await createAdminRoute(token, name);
      if (!active.current) return;
      // A late catalog GET cannot remove a newly created route from the list.
      catalogAbort.current?.abort();
      catalogRequest.current++;
      setCatalogLoading(false);
      setRoutes(previous => [...previous.filter(item => item.id !== route.id), route]);
      setRouteName("");
      setShowCreate(false);
      chooseRoute(route.id);
    } catch (cause) {
      handleError(cause, setCreateError);
    } finally { if (active.current) setCreating(false); }
  }

  async function saveLayout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current || !draft || blocked || conflict) return;
    let layout;
    try { layout = buildRouteLayout(draft, current.updatedAt); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Проверьте остановки и питаки."); return; }
    setSaving(true);
    setError("");
    setSuccess("");
    detailAbort.current?.abort();
    detailRequest.current++;
    try {
      const route = await saveAdminRouteLayout(token, current.id, layout);
      if (!active.current) return;
      catalogAbort.current?.abort();
      catalogRequest.current++;
      setCatalogLoading(false);
      revision.current++;
      setCurrent(route);
      setDraft(draftFromRoute(route));
      setRoutes(previous => previous.map(item => item.id === route.id ? route : item));
      setDirty(false);
      setConflict(false);
      setPendingRoute(null);
      setConfirmReload(false);
      setSuccess(route.pitaks ? "Остановки и питаки A/B сохранены." : "Черновик остановок сохранён без питаков A/B.");
    } catch (cause) {
      if (!active.current) return;
      if (cause instanceof AdminApiError && cause.status === 409 && cause.code === "ROUTE_CHANGED") {
        setConflict(true);
        setError("");
      } else {
        handleError(cause, setError);
      }
    } finally { if (active.current) setSaving(false); }
  }

  const blocked = saving || detailLoading || creating;

  return <div>
    <div className="mb-8"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Панель управления</p><h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Маршруты и остановки</h1><p className="mt-2 text-sm text-slate-500">Настройте порядок остановок и питаки A/B на концах маршрута.</p></div>
    <section aria-label="Каталог маршрутов" className="mb-6 rounded-2xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="w-full min-w-0 text-sm font-medium text-slate-700 sm:w-auto sm:flex-1">Маршрут
          <select aria-label="Маршрут" value={selectedId} disabled={blocked || routes.length === 0} onChange={event => chooseRoute(event.target.value)} className={inputClass}>
            {!selectedId && <option value="">{catalogLoading ? "Загружаем маршруты…" : "Нет маршрутов"}</option>}
            {selectedId && !routes.some(route => route.id === selectedId) && <option value={selectedId}>{current?.name ?? selectedId} (нет в каталоге)</option>}
            {routes.map(route => <option key={route.id} value={route.id}>{route.name}{route.active ? "" : " · неактивен"}</option>)}
          </select>
        </label>
        <button type="button" className={buttonClass} disabled={catalogLoading || creating} onClick={() => void refreshCatalog()}><RefreshCw size={16} className={catalogLoading ? "animate-spin" : ""}/><span>Обновить каталог</span></button>
        <button type="button" className={buttonClass} disabled={blocked} onClick={() => { setShowCreate(previous => !previous); setCreateError(""); }}><Plus size={16}/>Новый маршрут</button>
      </div>
      {catalogError && <p role="alert" className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{catalogError}</p>}
      {!catalogLoading && routes.length === 0 && !catalogError && <p className="mt-4 text-sm text-slate-500">В каталоге пока нет маршрутов. Создайте маршрут, затем добавьте остановки.</p>}
      {showCreate && <form onSubmit={createRoute} className="mt-5 border-t border-slate-100 pt-5">
        <div className="flex flex-wrap items-end gap-3"><label className="w-full min-w-0 text-sm font-medium text-slate-700 sm:w-auto sm:flex-1">Название нового маршрута<input aria-label="Название нового маршрута" className={inputClass} required maxLength={120} value={routeName} disabled={blocked} onChange={event => setRouteName(event.target.value)} placeholder="Например, Центр — Вокзал"/></label><button type="submit" disabled={blocked} className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{creating ? "Создаём…" : "Создать маршрут"}</button></div>
        {createError && <p role="alert" className="mt-3 text-sm text-red-700">{createError}</p>}
      </form>}
    </section>
    {pendingRoute && <div role="alert" className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p>В текущем маршруте есть несохранённые изменения. Переход к другому маршруту заменит черновик.</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={blocked} onClick={() => activateRoute(pendingRoute)} className={buttonClass}>Перейти и сбросить изменения</button><button type="button" onClick={() => setPendingRoute(null)} className={buttonClass}>Остаться</button></div></div>}
    {error && <p role="alert" className="mb-5 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700"><CircleAlert size={17} className="mt-0.5 shrink-0"/>{error}</p>}
    {detailLoading && <p role="status" className="mb-5 text-sm text-slate-500">Загружаем остановки маршрута…</p>}
    {selectedId && !current && !detailLoading && error && <button type="button" className={buttonClass} onClick={() => void loadDetail(selectedId)}><RefreshCw size={16}/>Повторить загрузку</button>}
    {current && draft && <form onSubmit={saveLayout} className="rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5"><div className="min-w-0 flex-1"><h2 className="break-words text-lg font-bold">{current.name}</h2><p className="mt-1 text-xs text-slate-500">{dirty ? "Есть несохранённые изменения" : "Данные загружены с сервера"} · {draft.stops.length} остановок</p></div><button type="button" disabled={blocked} onClick={reloadRoute} className={buttonClass}><RefreshCw size={16}/>Загрузить текущую версию</button></div>
      {conflict && <div role="alert" className="m-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p className="font-semibold">Маршрут изменился на сервере.</p><p className="mt-1">Ваш черновик сохранён на экране. Загрузите текущую версию перед следующим сохранением.</p><button type="button" disabled={blocked} onClick={reloadRoute} className={buttonClass + " mt-3"}>Загрузить текущую версию</button></div>}
      {confirmReload && <div role="alert" className="m-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><p>Загрузка заменит ваш несохранённый черновик данными с сервера.</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={blocked} onClick={() => { setConfirmReload(false); void loadDetail(current.id); }} className={buttonClass}>Загрузить и заменить черновик</button><button type="button" onClick={() => setConfirmReload(false)} className={buttonClass}>Оставить черновик</button></div></div>}
      <fieldset disabled={blocked} className="min-w-0 space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">Остановки по порядку</h3><p className="mt-1 text-sm text-slate-500">Код и название обязательны. Координаты промежуточных остановок можно оставить пустыми.</p></div><button type="button" disabled={blocked || draft.stops.length >= 1000} className={buttonClass} onClick={addStop}><Plus size={16}/>Добавить остановку</button></div>
        {draft.stops.length === 0 && <p className="rounded-xl bg-slate-50 p-5 text-sm text-slate-500">Остановок пока нет. Добавьте первую остановку маршрута.</p>}
        <div className="space-y-4">{draft.stops.map((stop, index) => <div key={stop.key} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className="flex items-center gap-2 text-sm font-semibold"><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white text-blue-700">{index + 1}</span>Остановка {index + 1}{draft.withPitaks && stop.key === draft.aKey && <span className="rounded-lg bg-blue-50 px-2 py-1 text-xs text-blue-700">Питак A</span>}{draft.withPitaks && stop.key === draft.bKey && <span className="rounded-lg bg-violet-50 px-2 py-1 text-xs text-violet-700">Питак B</span>}</p><div className="flex gap-1"><button type="button" className={buttonClass} disabled={blocked || index === 0} onClick={() => moveStop(index, -1)} aria-label={"Поднять остановку " + (index + 1)}><ArrowUp size={15}/></button><button type="button" className={buttonClass} disabled={blocked || index === draft.stops.length - 1} onClick={() => moveStop(index, 1)} aria-label={"Опустить остановку " + (index + 1)}><ArrowDown size={15}/></button><button type="button" className={buttonClass + " text-red-600"} onClick={() => changeDraft(previous => ({ ...previous, stops: previous.stops.filter(item => item.key !== stop.key) }))} aria-label={"Удалить остановку " + (index + 1)}><Trash2 size={15}/></button></div></div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><label className="text-sm font-medium text-slate-700">Код<input className={inputClass} aria-label={"Код остановки " + (index + 1)} maxLength={40} value={stop.code} onChange={event => updateStop(stop.key, "code", event.target.value)} placeholder="A1"/></label><label className="text-sm font-medium text-slate-700">Название<input className={inputClass} aria-label={"Название остановки " + (index + 1)} maxLength={120} value={stop.name} onChange={event => updateStop(stop.key, "name", event.target.value)} placeholder="Название остановки"/></label><label className="text-sm font-medium text-slate-700">Широта<input className={inputClass} aria-label={"Широта остановки " + (index + 1)} inputMode="decimal" value={stop.latitude} onChange={event => updateStop(stop.key, "latitude", event.target.value)} placeholder="−90…90"/></label><label className="text-sm font-medium text-slate-700">Долгота<input className={inputClass} aria-label={"Долгота остановки " + (index + 1)} inputMode="decimal" value={stop.longitude} onChange={event => updateStop(stop.key, "longitude", event.target.value)} placeholder="−180…180"/></label></div>
        </div>)}</div>
        <div className="rounded-2xl border border-slate-200 p-4"><label className="flex items-center gap-3 text-sm font-semibold"><input type="checkbox" className="h-4 w-4 accent-blue-600" checked={draft.withPitaks} onChange={event => changeDraft(previous => ({ ...previous, withPitaks: event.target.checked, aKey: event.target.checked ? previous.stops[0]?.key ?? "" : previous.aKey, bKey: event.target.checked ? previous.stops[previous.stops.length - 1]?.key ?? "" : previous.bKey }))}/><MapPin size={17} className="text-blue-600"/>Настроить питаки A/B</label><p className="mt-2 text-sm text-slate-500">A — первая остановка, B — последняя. Для обеих нужны координаты. Без этой настройки маршрут сохраняется как черновик без питаков.</p>
          {draft.withPitaks && <div className="mt-4 grid gap-4 sm:grid-cols-3"><label className="text-sm font-medium text-slate-700">Питак A<select aria-label="Питак A" className={inputClass} value={draft.aKey} onChange={event => changeDraft(previous => ({ ...previous, aKey: event.target.value }))}><option value="">Выберите первую остановку</option>{draft.stops.map((stop, index) => <option key={stop.key} value={stop.key} disabled={index !== 0}>{index + 1}. {stop.name || stop.code || "Без названия"}</option>)}</select></label><label className="text-sm font-medium text-slate-700">Питак B<select aria-label="Питак B" className={inputClass} value={draft.bKey} onChange={event => changeDraft(previous => ({ ...previous, bKey: event.target.value }))}><option value="">Выберите последнюю остановку</option>{draft.stops.map((stop, index) => <option key={stop.key} value={stop.key} disabled={index !== draft.stops.length - 1}>{index + 1}. {stop.name || stop.code || "Без названия"}</option>)}</select></label><label className="text-sm font-medium text-slate-700">Радиус, м<input aria-label="Радиус питака, м" className={inputClass} inputMode="numeric" value={draft.radius} onChange={event => changeDraft(previous => ({ ...previous, radius: event.target.value }))} placeholder="10–5000"/></label></div>}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 p-5"><p className="text-xs text-slate-500">Изменения применяются после сохранения.</p><button type="submit" disabled={blocked || conflict || !dirty} className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><Save size={16}/>{saving ? "Сохраняем…" : "Сохранить остановки и питаки"}</button></div>
      {success && <p role="status" className="mx-5 mb-5 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">{success}</p>}
    </form>}
  </div>;
}
