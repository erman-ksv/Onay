export type FareCurrency = "KZT" | "UZS";
export type FareMoney = { total: number; currency: FareCurrency };

const moneyFormat = new Intl.NumberFormat("ru-RU");
const has = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const validAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Never convert or relabel an amount: only the server chooses amount/currency. */
export function parseServerFareMoney(input: unknown): FareMoney {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Сервер не рассчитал стоимость поездки.");
  }
  const fare = input as Record<string, unknown>;
  if (fare.currency !== "KZT" && fare.currency !== "UZS") {
    throw new Error("Сервер вернул неподдерживаемую валюту поездки.");
  }
  const hasTotal = has(fare, "total"), hasLegacy = has(fare, "totalKzt");
  // A KZT-only field is never a source of UZS, even if the number looks valid.
  if (fare.currency === "UZS" && hasLegacy) {
    throw new Error("Валюта и стоимость поездки не согласованы.");
  }
  if ((hasTotal && !validAmount(fare.total)) || (hasLegacy && !validAmount(fare.totalKzt))) {
    throw new Error("Сервер вернул недостоверную стоимость поездки.");
  }
  if (hasTotal && hasLegacy && fare.total !== fare.totalKzt) {
    throw new Error("Сервер вернул противоречивую стоимость поездки.");
  }
  const total = hasTotal ? fare.total : fare.currency === "KZT" && hasLegacy ? fare.totalKzt : undefined;
  if (!validAmount(total)) throw new Error("Сервер не рассчитал стоимость поездки.");
  return { total, currency: fare.currency };
}

export function formatFareMoney(money: FareMoney): string {
  const fare = parseServerFareMoney(money);
  return `${moneyFormat.format(fare.total)} ${fare.currency === "UZS" ? "сум" : "₸"}`;
}
