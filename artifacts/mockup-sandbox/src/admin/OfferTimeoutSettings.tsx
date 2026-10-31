import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AdminApiError } from "./api";
import { loadOfferTimeout, readOfferTimeoutDraft, saveOfferTimeout, type OfferTimeoutPolicy } from "./offer-timeout-api";

export default function OfferTimeoutSettings({ token, onAccessExpired }: { token: string; onAccessExpired: () => void }) {
  const [policy, setPolicy] = useState<OfferTimeoutPolicy | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0), inFlight = useRef(false), controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    const ticket = ++generation.current, abort = new AbortController();
    controller.current?.abort(); controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 15_000);
    setLoading(true); setError(""); setNotice(""); setPolicy(null);
    try {
      const value = await loadOfferTimeout(token, abort.signal);
      if (ticket !== generation.current || abort.signal.aborted) return;
      setPolicy(value); setDraft(String(value.seconds));
    } catch (reason) {
      if (ticket !== generation.current) return;
      if (reason instanceof AdminApiError && (reason.status === 401 || reason.status === 403)) onAccessExpired();
      else setError("Не удалось получить настройку. Нажмите «Обновить настройку», чтобы повторить.");
    } finally { clearTimeout(timer); if (ticket === generation.current) setLoading(false); }
  }, [token, onAccessExpired]);

  useEffect(() => {
    void load();
    return () => { generation.current++; controller.current?.abort(); };
  }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || loading || !policy) return;
    let seconds: number;
    try { seconds = readOfferTimeoutDraft(draft); } catch (reason) { setError((reason as Error).message); return; }
    const receipt = policy.revision, ticket = ++generation.current, abort = new AbortController();
    controller.current?.abort(); controller.current = abort; inFlight.current = true;
    const timer = setTimeout(() => abort.abort(), 15_000);
    setSaving(true); setError(""); setNotice("");
    try {
      const value = await saveOfferTimeout(token, seconds, receipt, abort.signal);
      if (ticket !== generation.current || abort.signal.aborted) return;
      setPolicy(value); setDraft(String(value.seconds)); setNotice("Настройка сохранена. Она применяется только к новым предложениям.");
    } catch (reason) {
      if (ticket !== generation.current) return;
      setPolicy(null);
      if (reason instanceof AdminApiError && (reason.status === 401 || reason.status === 403)) onAccessExpired();
      else setError(reason instanceof AdminApiError && reason.code === "OFFER_TIMEOUT_CHANGED"
        ? "Настройка изменилась у другого администратора. Обновите её перед новым сохранением."
        : "Результат сохранения не подтверждён. Обновите настройку перед следующим действием.");
    } finally { clearTimeout(timer); inFlight.current = false; if (ticket === generation.current) setSaving(false); }
  }

  const dirty = !!policy && (draft.trim() !== String(policy.seconds) || policy.revision === null);
  return <section data-testid="admin-offer-timeout" aria-label="Настройка времени ответа водителя" className="max-w-2xl space-y-5">
    <div><h1 className="text-3xl font-bold tracking-tight">Время ответа водителя</h1>
      <p className="mt-2 text-sm leading-6 text-slate-500">Новый срок действует только для предложений, выданных после сохранения. Уже отправленные предложения сохраняют свой срок. Время посадки и поездки не меняется.</p></div>
    {loading ? <p role="status">Загружаем настройку…</p> : null}
    <p data-testid="offer-timeout-current" className="font-medium">{policy ? `Текущее время ответа: ${policy.seconds} с` : "Нет подтверждённой настройки"}</p>
    {error ? <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p> : null}
    {notice ? <p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</p> : null}
    <form onSubmit={save} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
      <label className="block text-sm font-medium">Тайм-аут предложения, секунд
        <input type="text" inputMode="numeric" autoComplete="off" maxLength={8} value={draft} disabled={loading || saving || !policy}
          onChange={event => { setDraft(event.target.value); setError(""); setNotice(""); }}
          className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-3 font-normal disabled:opacity-50"/>
      </label>
      <p className="text-xs text-slate-500">Целое число от 1 до 3600 секунд.</p>
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={loading || saving || !policy || !dirty} className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">Сохранить время ответа</button>
        <button type="button" disabled={loading || saving} onClick={() => { void load(); }} className="rounded-xl border px-4 py-3 text-sm disabled:opacity-50">Обновить настройку</button>
      </div>
      <p className="text-xs text-slate-500">Обновление заменит несохранённое значение данными сервера.</p>
    </form>
  </section>;
}
