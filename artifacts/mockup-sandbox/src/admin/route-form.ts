import type { AdminRoute, RouteLayoutInput } from "./api";

export type StopDraft = {
  key: string;
  id?: string;
  code: string;
  name: string;
  latitude: string;
  longitude: string;
};

export type RouteDraft = {
  stops: StopDraft[];
  withPitaks: boolean;
  aKey: string;
  bKey: string;
  radius: string;
};

export function draftFromRoute(route: AdminRoute): RouteDraft {
  const stops = [...route.stops].sort((a, b) => a.sequence - b.sequence).map(stop => ({
    key: stop.id,
    id: stop.id,
    code: stop.code,
    name: stop.name,
    latitude: stop.location ? String(stop.location.lat) : "",
    longitude: stop.location ? String(stop.location.lng) : "",
  }));
  return {
    stops,
    withPitaks: Boolean(route.pitaks),
    aKey: stops.find(stop => stop.code === route.pitaks?.aStopCode)?.key ?? "",
    bKey: stops.find(stop => stop.code === route.pitaks?.bStopCode)?.key ?? "",
    radius: String(route.pitaks?.radiusMeters ?? 100),
  };
}

function coordinate(value: string, limit: number, label: string): number {
  if (!value.trim()) throw new Error(label + ": введите координату.");
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < -limit || parsed > limit) {
    throw new Error(label + ": допустимо число от −" + limit + " до " + limit + ".");
  }
  return parsed;
}

/** Empty coordinate pairs are valid intermediate stops; blank strings never become zero. */
export function buildRouteLayout(draft: RouteDraft, updatedAt: string): RouteLayoutInput {
  if (!updatedAt) throw new Error("Сначала загрузите текущую версию маршрута.");
  if (draft.stops.length > 1000) throw new Error("В маршруте может быть не более 1000 остановок.");
  const codes = new Set<string>();
  const stops = draft.stops.map((stop, index) => {
    const label = "Остановка " + (index + 1);
    const code = stop.code.trim().toUpperCase();
    const name = stop.name.trim();
    if (!code || code.length > 40) throw new Error(label + ": код должен содержать от 1 до 40 символов.");
    if (!name || name.length > 120) throw new Error(label + ": название должно содержать от 1 до 120 символов.");
    if (codes.has(code)) throw new Error(label + ": код «" + code + "» уже используется.");
    codes.add(code);
    const hasLatitude = Boolean(stop.latitude.trim());
    const hasLongitude = Boolean(stop.longitude.trim());
    if (hasLatitude !== hasLongitude) throw new Error(label + ": заполните обе координаты или оставьте обе пустыми.");
    const location = hasLatitude ? {
      lat: coordinate(stop.latitude, 90, label + ", широта"),
      lng: coordinate(stop.longitude, 180, label + ", долгота"),
    } : undefined;
    return { ...(stop.id ? { id: stop.id } : {}), code, name, ...(location ? { location } : {}) };
  });
  const layout: RouteLayoutInput = { expected_updated_at: updatedAt, stops };
  if (draft.withPitaks) {
    if (stops.length < 2) throw new Error("Для питаков A и B нужны минимум две остановки.");
    if (!draft.aKey || !draft.bKey || draft.aKey === draft.bKey) throw new Error("Выберите разные остановки для питаков A и B.");
    if (draft.aKey !== draft.stops[0].key || draft.bKey !== draft.stops[draft.stops.length - 1].key) {
      throw new Error("Питак A должен быть первой остановкой, а питак B — последней. Проверьте выбор после изменения порядка.");
    }
    if (!stops[0].location || !stops[stops.length - 1].location) throw new Error("У обеих остановок питаков A и B должны быть широта и долгота.");
    const radius = draft.radius.trim() ? Number(draft.radius.trim()) : NaN;
    if (!Number.isFinite(radius) || !Number.isInteger(radius) || radius < 10 || radius > 5000) {
      throw new Error("Радиус питака должен быть целым числом от 10 до 5000 метров.");
    }
    layout.pitaks = { a_stop_code: stops[0].code, b_stop_code: stops[stops.length - 1].code, radius_meters: radius };
  }
  return layout;
}
