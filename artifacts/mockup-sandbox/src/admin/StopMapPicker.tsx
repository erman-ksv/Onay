import { useEffect, useId, useRef, useState } from "react";
import { Crosshair, MapPin, X } from "lucide-react";
import type { CircleMarker, Map as LeafletMap } from "leaflet";
import "./stop-map.css";

export type MapPoint = { lat: number; lng: number };

/** A blank pair is not the coordinate (0, 0), which itself is a valid location. */
export function readMapPoint(latitude: string, longitude: string): MapPoint | null {
  if (!latitude.trim() || !longitude.trim()) return null;
  const lat = Number(latitude.trim());
  const lng = Number(longitude.trim());
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    ? { lat, lng } : null;
}

function normalizePoint(point: MapPoint): MapPoint | null {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || point.lat < -90 || point.lat > 90) return null;
  // Leaflet world copies can report longitude outside the normal range.
  const lng = ((point.lng + 180) % 360 + 360) % 360 - 180;
  return { lat: Number(point.lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

type Props = {
  stopNumber: number;
  initialPoint: MapPoint | null;
  routePoint: MapPoint | null;
  disabled: boolean;
  onApply: (point: MapPoint) => void;
  onClose: () => void;
};

/** Clicks stay inside this picker until the administrator explicitly applies the point. */
export default function StopMapPicker({ stopNumber, initialPoint, routePoint, disabled, onApply, onClose }: Props) {
  const helpId = useId();
  const heading = useRef<HTMLHeadingElement | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const instance = useRef<LeafletMap | null>(null);
  const marker = useRef<CircleMarker | null>(null);
  const leaflet = useRef<typeof import("leaflet") | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  // Opening snapshots the selected stop. Later manual edits do not reset map panning.
  const [start] = useState(() => ({ center: initialPoint ?? routePoint ?? { lat: 0, lng: 0 }, zoom: initialPoint || routePoint ? 15 : 2 }));
  const [candidate, setCandidate] = useState<MapPoint | null>(initialPoint);
  const [markerPoint, setMarkerPoint] = useState<MapPoint | null>(initialPoint);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [tileWarning, setTileWarning] = useState("");

  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    let disposed = false;
    let map: LeafletMap | null = null;
    let resize: ResizeObserver | null = null;
    let frame = 0;
    const invalidate = () => {
      if (!disposed && container.current?.offsetWidth && container.current.offsetHeight) map?.invalidateSize();
    };
    async function initialize() {
      try {
        const [L] = await Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]);
        if (disposed || !container.current) return;
        leaflet.current = L;
        map = L.map(container.current, { zoomControl: false, keyboard: true }).setView(start.center, start.zoom);
        instance.current = map;
        L.control.zoom({ zoomInTitle: "Приблизить", zoomOutTitle: "Отдалить" }).addTo(map);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          crossOrigin: "anonymous",
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
        }).on("tileerror", () => {
          if (!disposed) setTileWarning("Не удалось загрузить часть карты. Проверьте подключение или введите координаты вручную.");
        }).on("tileload", () => {
          if (!disposed) setTileWarning("");
        }).addTo(map);
        map.on("click", event => {
          if (disposed || disabledRef.current) return;
          const point = normalizePoint(event.latlng);
          if (point) {
            setCandidate(point);
            // Keep the marker in the clicked world copy; only saved longitude wraps.
            setMarkerPoint({ lat: point.lat, lng: Number(event.latlng.lng.toFixed(6)) });
          }
        });
        if (typeof ResizeObserver !== "undefined") {
          resize = new ResizeObserver(invalidate);
          resize.observe(container.current);
        }
        window.addEventListener("resize", invalidate);
        frame = window.requestAnimationFrame(invalidate);
        setReady(true);
      } catch {
        if (!disposed) setLoadError("Карта недоступна. Координаты можно ввести вручную в полях остановки.");
      }
    }
    void initialize();
    return () => {
      disposed = true;
      resize?.disconnect();
      window.removeEventListener("resize", invalidate);
      window.cancelAnimationFrame(frame);
      map?.remove();
      instance.current = null;
      marker.current = null;
      leaflet.current = null;
    };
  }, [start]);

  useEffect(() => {
    if (!ready || !instance.current || !leaflet.current) return;
    if (!markerPoint) {
      marker.current?.remove();
      marker.current = null;
    } else if (marker.current) {
      marker.current.setLatLng(markerPoint);
    } else {
      marker.current = leaflet.current.circleMarker(markerPoint, { radius: 8, color: "#ffffff", weight: 3, fillColor: "#2563eb", fillOpacity: 1, interactive: false, className: "stop-map-marker" }).addTo(instance.current);
    }
  }, [markerPoint, ready]);

  function chooseCenter() {
    if (disabled || !instance.current) return;
    const center = instance.current.getCenter();
    const point = normalizePoint(center);
    if (point) {
      setCandidate(point);
      setMarkerPoint({ lat: point.lat, lng: Number(center.lng.toFixed(6)) });
    }
  }

  return <section aria-label={"Карта остановки " + stopNumber} className="mt-4 rounded-2xl border border-blue-100 bg-white p-4" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h4 ref={heading} tabIndex={-1} className="flex items-center gap-2 text-sm font-semibold outline-none"><MapPin size={16} className="text-blue-600"/>Выбор точки остановки {stopNumber}</h4><button type="button" disabled={disabled} onClick={onClose} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-50"><X size={14}/>Закрыть карту</button></div>
    <p id={helpId} className="mb-3 text-sm leading-5 text-slate-500">Перемещайте карту, меняйте масштаб и нажмите на нужное место. Затем используйте эту точку. Клавиши стрелок перемещают карту; выбранный центр можно отметить кнопкой ниже.</p>
    <div ref={container} tabIndex={0} role="application" aria-label="Карта выбора координат" aria-describedby={helpId} className="stop-map-canvas"/>
    {!ready && !loadError && <p role="status" className="mt-3 text-sm text-slate-500">Загружаем карту…</p>}
    {loadError && <p role="alert" className="mt-3 text-sm text-red-700">{loadError}</p>}
    {tileWarning && <p role="status" className="mt-3 text-sm text-amber-700">{tileWarning}</p>}
    <p role="status" className="mt-3 text-sm text-slate-600">{candidate ? "Выбрано: " + candidate.lat.toFixed(6) + ", " + candidate.lng.toFixed(6) : "Точка пока не выбрана."}</p>
    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap"><button type="button" disabled={disabled || !ready || Boolean(loadError)} onClick={chooseCenter} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"><Crosshair size={16}/>Выбрать центр карты</button><button type="button" disabled={disabled || !candidate || Boolean(loadError)} onClick={() => { if (candidate && !disabled) onApply(candidate); }} className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">Использовать эту точку</button></div>
    <p className="mt-3 text-xs text-slate-500">Координаты добавятся в черновик. Изменения применятся после сохранения маршрута.</p>
  </section>;
}
