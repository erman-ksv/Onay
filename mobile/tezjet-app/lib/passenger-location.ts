/** Native location providers can stay pending when a GPS fix is unavailable.
 * Bound the wait before booking; a late native result must not resume the POST.
 * Expo does not expose cancellation for getCurrentPositionAsync.
 */
export async function passengerPositionWithDeadline<T>(getPosition: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(getPosition),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Не удалось определить местоположение вовремя. Проверь геолокацию и повтори проверку водителей.")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
