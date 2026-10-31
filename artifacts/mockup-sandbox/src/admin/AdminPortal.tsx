import OfferTimeoutSettings from "./OfferTimeoutSettings";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, CircleAlert, LockKeyhole, LogOut, MapPin, RefreshCw, Search, ShieldCheck, Smartphone, Users, UserRound, CarTaxiFront } from "lucide-react";
import RouteEditor from "./RouteEditor";
import AuditJournal from "./AuditJournal";
import AdminOrders from "./AdminOrders";
import AdminMonitoring from "./AdminMonitoring";
import AdminStatistics from "./AdminStatistics";
import DriverVehicleReview from "./DriverVehicleReview";
import {
  AdminApiError, closeAdminSession, filterDirectory, loadDirectories, sendAdminOtp, verifyAdminOtp,
  type AdminRecord, type AdminSession,
} from "./api";

type View = "passengers" | "drivers";
type Directory = { passengers: AdminRecord[]; drivers: AdminRecord[] };
const empty: Directory = { passengers: [], drivers: [] };

function formatDate(value?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium" }).format(d);
}
function statusLabel(status?: string): string {
  switch (status) {
    case "approved": return "Одобрен";
    case "pending": return "На проверке";
    case "rejected": return "Отклонён";
    case "blocked": return "Заблокирован";
    default: return "—";
  }
}
function IconBadge({ children }: { children: ReactNode }) {
  return <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-white">{children}</span>;
}

/** Protected user directories and route layout administration; credentials stay in memory. */
export default function AdminPortal() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [demoCode, setDemoCode] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [tab, setTab] = useState<View>("passengers");
  const [section, setSection] = useState<"users" | "routes" | "audit" | "orders" | "monitoring" | "statistics" | "settings">("users");
  const [filter, setFilter] = useState("");
  const [data, setData] = useState<Directory>(empty);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const activeSessionToken = useRef<string | null>(null);
  const directoryRequest = useRef(0);
  const directoryAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const previousTitle = document.title;
    const previousLanguage = document.documentElement.lang;
    document.title = "TezJet — администрирование";
    document.documentElement.lang = "ru";
    return () => {
      document.title = previousTitle;
      document.documentElement.lang = previousLanguage;
    };
  }, []);

  const signOut = useCallback(async (current: AdminSession | null = session) => {
    if ((current?.token ?? null) !== activeSessionToken.current) return;
    activeSessionToken.current = null;
    directoryRequest.current++;
    directoryAbort.current?.abort();
    setSession(null);
    setData(empty);
    setOtp("");
    setDemoCode("");
    setStep("phone");
    setLastUpdate(null);
    setLoading(false);
    setSection("users");
    if (current) {
      try { await closeAdminSession(current.token); }
      catch { /* Session is cleared from this browser regardless of network. */ }
    }
  }, [session]);

  const expireRouteAccess = useCallback(() => {
    if (session?.token !== activeSessionToken.current) return;
    void signOut();
    setError("Доступ администратора завершён. Войдите снова.");
  }, [session, signOut]);

  const refresh = useCallback(async (active: AdminSession) => {
    if (active.token !== activeSessionToken.current) return;
    directoryAbort.current?.abort();
    const controller = new AbortController();
    directoryAbort.current = controller;
    const request = ++directoryRequest.current;
    const isCurrent = () => !controller.signal.aborted &&
      active.token === activeSessionToken.current && request === directoryRequest.current;
    setLoading(true);
    setData(empty);
    setLastUpdate(null);
    setError("");
    try {
      const directory = await loadDirectories(active.token, controller.signal);
      if (isCurrent()) {
        setData(directory);
        setLastUpdate(new Date());
      }
    } catch (e) {
      if (!isCurrent()) return;
      if (e instanceof AdminApiError && (e.status === 401 || e.status === 403)) {
        void signOut(active);
        setError("Доступ администратора завершён. Войдите снова.");
      } else {
        setError("Не удалось обновить каталоги. Попробуйте ещё раз.");
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [signOut]);

  useEffect(() => {
    if (!session) return;
    void refresh(session);
    return () => directoryAbort.current?.abort();
    // Login changes the token; logout resets the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await sendAdminOtp(phone, name);
      setDemoCode(result.demo_code ?? "");
      setStep("code");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось запросить код.");
    } finally { setBusy(false); }
  }

  async function confirmCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const active = await verifyAdminOtp(phone, otp);
      activeSessionToken.current = active.token;
      setSession(active);
      setOtp("");
      setDemoCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Неверный код подтверждения.");
    } finally { setBusy(false); }
  }

  const records = useMemo(() => filterDirectory(data[tab], filter), [data, tab, filter]);

  if (!session) {
    return <div className="min-h-screen bg-[#f5f7fb] px-5 py-16 text-slate-900">
      <div className="mx-auto max-w-md">
        <div className="mb-10 flex items-center gap-3">
          <IconBadge><CarTaxiFront size={22} /></IconBadge>
          <div><p className="text-xl font-bold tracking-tight">TezJet</p><p className="text-xs font-medium uppercase tracking-[0.17em] text-slate-500">Администрирование</p></div>
        </div>
        <div className="rounded-[28px] border border-slate-200 bg-white p-7 shadow-sm sm:p-9">
          <span className="mb-6 inline-flex rounded-2xl bg-blue-50 p-3 text-blue-700"><ShieldCheck size={27} /></span>
          <h1 className="text-3xl font-bold tracking-tight">Вход в панель</h1>
          <p className="mt-3 text-sm leading-6 text-slate-500">Только для уполномоченного администратора. Доступ проверяется сервером TezJet.</p>
          {error && <p role="alert" className="mt-5 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700"><CircleAlert className="mt-0.5 shrink-0" size={17}/>{error}</p>}
          {step === "phone" ? <form className="mt-8 space-y-5" onSubmit={requestCode}>
            <label className="block text-sm font-medium text-slate-700">Телефон администратора
              <input type="tel" autoComplete="tel" required maxLength={32} value={phone} onChange={e => setPhone(e.target.value)} placeholder="+7 777 000 00 00" className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-base outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" />
            </label>
            <label className="block text-sm font-medium text-slate-700">Имя
              <input type="text" autoComplete="name" required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Имя администратора" className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-base outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" />
            </label>
            <button disabled={busy} type="submit" className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">{busy ? "Отправляем…" : "Получить код"}<ArrowRight size={17}/></button>
          </form> : <form className="mt-8 space-y-5" onSubmit={confirmCode}>
            <label className="block text-sm font-medium text-slate-700">Код подтверждения
              <input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ""))} placeholder="000000" className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-center font-mono text-2xl tracking-[0.35em] outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" />
            </label>
            {demoCode && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Тестовый код разработки: <strong>{demoCode}</strong>. В production сервер его не выдаёт.</p>}
            <button disabled={busy} type="submit" className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 py-3.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">{busy ? "Проверяем…" : "Войти"}<ArrowRight size={17}/></button>
            <button type="button" onClick={() => { setStep("phone"); setOtp(""); setError(""); setDemoCode(""); }} className="w-full text-sm font-medium text-slate-500 hover:text-slate-900">Изменить номер</button>
          </form>}
        </div>
        <p className="mt-6 flex items-center justify-center gap-2 text-xs text-slate-500"><LockKeyhole size={14}/> Сессия хранится только до закрытия или обновления страницы.</p>
      </div>
    </div>;
  }

  return <div className="min-h-screen bg-[#f5f7fb] text-slate-900">
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <div className="flex items-center gap-3"><IconBadge><CarTaxiFront size={21}/></IconBadge><div><p className="text-lg font-bold leading-tight tracking-tight">TezJet <span className="font-medium text-slate-400">/ Admin</span></p><p className="text-xs text-slate-500">Пользователи и маршруты</p></div></div>
        <div className="flex items-center gap-3"><span className="hidden text-right text-xs text-slate-500 sm:block"><strong className="block text-sm text-slate-800">{session.user.full_name}</strong>Администратор</span><button type="button" onClick={() => void signOut()} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium hover:bg-slate-50"><LogOut size={16}/>Выйти</button></div>
      </div>
    </header>
    <main className="mx-auto max-w-7xl px-5 py-9 sm:px-8">
      <nav aria-label="Разделы панели" className="mb-8 flex flex-wrap gap-2">
        <button type="button" aria-current={section === "users" ? "page" : undefined} onClick={() => setSection("users")} className={"inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold " + (section === "users" ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}><Users size={17}/>Пользователи</button>
        <button type="button" aria-current={section === "routes" ? "page" : undefined} onClick={() => setSection("routes")} className={"inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold " + (section === "routes" ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}><MapPin size={17}/>Маршруты и остановки</button>
        <button type="button" aria-current={section === "audit" ? "page" : undefined} onClick={() => setSection("audit")} className={"inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold " + (section === "audit" ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}><ShieldCheck size={17}/>Журнал действий</button>
        <button type="button" aria-current={section === "orders" ? "page" : undefined} onClick={() => setSection("orders")} className={"inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold " + (section === "orders" ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}><CarTaxiFront size={17}/>Заказы</button>
        <button type="button" aria-current={section === "monitoring" ? "page" : undefined} onClick={() => setSection("monitoring")} className={"inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold " + (section === "monitoring" ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}><RefreshCw size={17}/>Мониторинг</button>
        <button type="button" aria-current={section === "statistics" ? "page" : undefined} onClick={() => setSection("statistics")} className={"inline-flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold " + (section === "statistics" ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}><CarTaxiFront size={17}/>Статистика поездок</button>
        <button type="button" aria-current={section === "settings" ? "page" : undefined} onClick={() => setSection("settings")} className={"rounded-xl px-4 py-3 text-sm font-semibold " + (section === "settings" ? "bg-slate-900 text-white" : "border border-slate-200 bg-white text-slate-600")}>Настройки</button>
      </nav>
      <div data-testid="admin-directory" hidden={section !== "users"}>
      <div className="mb-8"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Панель управления</p><h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Пользователи TezJet</h1><p className="mt-2 text-sm text-slate-500">Просмотр пассажиров и водителей. Данные поступают из защищённого API.</p></div>
      <section aria-label="Статистика пользователей" className="mb-8 grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-5 inline-flex rounded-xl bg-blue-50 p-3 text-blue-600"><Users size={20}/></div><p className="text-sm text-slate-500">Пассажиры</p><p className="mt-1 text-3xl font-bold tabular-nums">{lastUpdate ? data.passengers.length : "—"}</p></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-5 inline-flex rounded-xl bg-violet-50 p-3 text-violet-600"><CarTaxiFront size={20}/></div><p className="text-sm text-slate-500">Водители</p><p className="mt-1 text-3xl font-bold tabular-nums">{lastUpdate ? data.drivers.length : "—"}</p></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-5"><div className="mb-5 inline-flex rounded-xl bg-emerald-50 p-3 text-emerald-600"><CheckCircle2 size={20}/></div><p className="text-sm text-slate-500">Одобренные водители</p><p className="mt-1 text-3xl font-bold tabular-nums">{lastUpdate ? data.drivers.filter(d => d.driver_approval_status === "approved").length : "—"}</p></div>
      </section>
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 p-5">
          <div role="tablist" aria-label="Каталог пользователей" className="flex gap-1 rounded-xl bg-slate-100 p-1">
            {([{ id: "passengers", label: "Пассажиры", Icon: UserRound }, { id: "drivers", label: "Водители", Icon: CarTaxiFront }] as const).map(item =>
              <button type="button" key={item.id} role="tab" aria-selected={tab === item.id} onClick={() => {setTab(item.id); setFilter("");}} className={"flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold " + (tab === item.id ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-900")}><item.Icon size={16}/>{item.label}</button>,
            )}
          </div>
          <button type="button" disabled={loading} onClick={() => void refresh(session)} className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"><RefreshCw size={16} className={loading ? "animate-spin" : ""}/>Обновить</button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <label className="relative w-full max-w-sm"><span className="sr-only">Поиск по имени, номеру телефона или ID</span><Search size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/><input type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Поиск пользователя..." className="w-full rounded-xl border border-slate-200 px-4 py-3 pl-10 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100" /></label>
          <span className="text-xs text-slate-500">{lastUpdate ? "Обновлено: " + lastUpdate.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "Загрузка данных"}</span>
        </div>
        {error && <div role="alert" className="mx-5 mb-4 flex items-center gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-700"><CircleAlert size={17}/>{error}</div>}
        <div className="overflow-x-auto">
          <table data-testid="directory-snapshot" hidden={!lastUpdate || loading || !!error} className="w-full min-w-[650px] border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-4 font-semibold">Пользователь</th><th className="px-5 py-4 font-semibold">Телефон</th><th className="px-5 py-4 font-semibold">{tab === "drivers" ? "Одобрение" : "Роли"}</th><th className="px-5 py-4 font-semibold">Создан</th></tr></thead>
            <tbody>{records.map(item => <tr key={item.id} className="border-t border-slate-100">
              <td className="px-5 py-4"><span className="font-semibold text-slate-900">{item.full_name || "Без имени"}</span><span className="mt-1 block font-mono text-xs text-slate-400">{item.id.slice(0, 8)}…</span></td>
              <td className="px-5 py-4 font-medium text-slate-600">{item.phone_number}</td>
              <td className="px-5 py-4">{tab === "drivers" ? <span className={"inline-flex rounded-full px-2.5 py-1 text-xs font-semibold " + (item.driver_approval_status === "approved" ? "bg-emerald-50 text-emerald-700" : (item.driver_approval_status === "rejected" || item.driver_approval_status === "blocked") ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700")}>{statusLabel(item.driver_approval_status)}</span> : <span className="text-slate-600">{item.roles?.join(", ") || "Пассажир"}</span>}</td>
              <td className="px-5 py-4 text-slate-500">{formatDate(item.created_at)}{tab === "drivers" && section === "users" ? <DriverVehicleReview key={`${session.token}:${item.id}:${item.driver_vehicle?.revision ?? "none"}`} driver={item} token={session.token} onReviewed={() => { void refresh(session); }} onAccessExpired={expireRouteAccess} /> : null}</td></tr>)}</tbody>
          </table>
          {lastUpdate && !loading && !error && records.length === 0 && <div className="px-6 py-14 text-center"><Smartphone className="mx-auto mb-3 text-slate-300" size={28}/><p className="font-medium text-slate-700">Пользователи не найдены</p><p className="mt-1 text-sm text-slate-400">Измените запрос или нажмите «Обновить».</p></div>}
          {loading && <p role="status" className="px-6 py-8 text-center text-sm text-slate-500">Загружаем актуальные данные…</p>}
        </div>
        <div className="border-t border-slate-100 px-5 py-4 text-xs text-slate-500">{lastUpdate ? "Найдено: " + records.length : "Нет актуальных данных"} · Автомобили проверяются администратором. Персональные данные доступны лишь администратору.</div>
      </section>
      </div>
      <div hidden={section !== "routes"}><RouteEditor token={session.token} onAccessExpired={expireRouteAccess}/></div>
      {section === "settings" ? <OfferTimeoutSettings key={session.token} token={session.token} onAccessExpired={expireRouteAccess}/> : null}
      {section === "audit" ? <AuditJournal key={session.token} token={session.token} onAccessExpired={expireRouteAccess}/> : null}
      {section === "monitoring" ? <AdminMonitoring key={session.token} token={session.token} onAccessExpired={expireRouteAccess}/> : null}
      {section === "statistics" ? <AdminStatistics key={session.token} token={session.token} onAccessExpired={expireRouteAccess}/> : null}
      {section === "orders" ? <AdminOrders key={session.token} token={session.token} onAccessExpired={expireRouteAccess}/> : null}
    </main>
  </div>;
}


