import { AppError } from "../utils/errors";

export type SmsConfiguration = { kind: "demo" } | {
  kind: "devsms";
  apiKey: string;
  serviceName: string;
  timeoutMs: number;
};
type DevsmsConfiguration = Extract<SmsConfiguration, { kind: "devsms" }>;
type SmsInput = { phoneNumber: string; code: string; deliveryId: string };
export type OtpSmsReceipt = { providerMessageId: string; status: "accepted" | "delivered" };
const ENDPOINT = "https://devsms.uz/api/v1/sms";
const MAX_RESPONSE_BYTES = 64 * 1024;
const controlCharacters = /[\u0000-\u001f\u007f]/;
const serviceCharacters = /^[\p{L}\p{N} .-]{2,50}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const configurationError = () => new AppError(503, "SMS delivery is not configured", "SMS_NOT_CONFIGURED");

/** No provider responses, destinations, credentials or causes are attached to this error. */
export class OtpSmsError extends AppError {
  readonly definitive: boolean;
  constructor(definitive: boolean) {
    super(503, definitive ? "SMS request was rejected" : "SMS delivery outcome is unknown",
      definitive ? "SMS_REJECTED" : "SMS_OUTCOME_UNKNOWN");
    this.name = "OtpSmsError";
    this.definitive = definitive;
  }
}

export function getSmsConfiguration(env: Readonly<Record<string, string | undefined>> = process.env): SmsConfiguration {
  const provider = env["TEZJET_SMS_PROVIDER"]?.trim() || "demo";
  if (provider === "demo") {
    if (env["NODE_ENV"] === "production") throw configurationError();
    if (env["NODE_ENV"] !== undefined && !["", "development", "test"].includes(env["NODE_ENV"])) throw configurationError();
    return { kind: "demo" };
  }
  if (provider !== "devsms" || env["TEZJET_SMS_SEND_ENABLED"] !== "true") throw configurationError();
  const rawKey = env["DEVSMS_API_KEY"] ?? "";
  const apiKey = rawKey.trim();
  const serviceName = (env["TEZJET_SMS_SERVICE_NAME"] ?? "Onay").trim();
  const rawTimeout = env["TEZJET_SMS_TIMEOUT_MS"] ?? "8000";
  if (!apiKey || apiKey.length > 4096 || controlCharacters.test(rawKey) || /\s/.test(apiKey) ||
    !serviceCharacters.test(serviceName) || !/^\d+$/.test(rawTimeout)) throw configurationError();
  const timeoutMs = Number(rawTimeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15000) throw configurationError();
  return { kind: "devsms", apiKey, serviceName, timeoutMs };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The deadline covers body reads too; do not buffer arbitrary provider responses. */
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw new OtpSmsError(false);
  }
  if (!response.body) throw new OtpSmsError(false);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new OtpSmsError(false);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { cancel(); throw new OtpSmsError(false); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

const definitiveErrors: Readonly<Record<number, readonly string[]>> = {
  401: ["unauthenticated", "token_expired"],
  402: ["insufficient_balance"],
  403: ["forbidden", "account_blocked", "token_locked_by_plan", "moderation_rejected", "otp_suspended"],
  422: ["validation_failed", "idempotency_key_reused", "international_disabled", "unsupported_country", "provider_rejected"],
};

/** One request only. Provider acceptance is deliberately distinct from handset delivery. */
export async function sendOtpSms(
  config: DevsmsConfiguration,
  input: SmsInput,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OtpSmsReceipt> {
  // Revalidate trusted configuration as a defense against accidental direct misuse.
  const checked = getSmsConfiguration({
    NODE_ENV: "production", TEZJET_SMS_PROVIDER: config.kind, TEZJET_SMS_SEND_ENABLED: "true",
    DEVSMS_API_KEY: config.apiKey, TEZJET_SMS_SERVICE_NAME: config.serviceName,
    TEZJET_SMS_TIMEOUT_MS: String(config.timeoutMs),
  });
  if (checked.kind !== "devsms") throw configurationError();
  if (!/^\+998\d{9}$/.test(input.phoneNumber) || !/^\d{6}$/.test(input.code) || !uuid.test(input.deliveryId)) throw new OtpSmsError(true);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new OtpSmsError(false)); }, checked.timeoutMs);
  });
  const operation = async (): Promise<OtpSmsReceipt> => {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal,
      headers: { Authorization: `Bearer ${checked.apiKey}`, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": input.deliveryId },
      body: JSON.stringify({ phone: input.phoneNumber.slice(1), otp: { template_type: 4, service_name: checked.serviceName, code: input.code } }),
    });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {});
      throw new OtpSmsError(false);
    }
    const body = object(await boundedJson(response, controller.signal));
    const data = object(body?.["data"]);
    const meta = object(body?.["meta"]);
    if (body?.["charged"] === true || meta?.["charged"] === true || data?.["charged"] === true) throw new OtpSmsError(false);
    if (response.status === 200 && body?.["success"] === true && data) {
      const id = data["id"];
      const status = data["status"];
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || data["phone"] !== input.phoneNumber.slice(1) ||
        !["pending", "sent", "delivered"].includes(String(status)) ||
        (data["error"] !== undefined && data["error"] !== null) ||
        (data["outcome"] !== undefined && data["outcome"] !== "sent")) throw new OtpSmsError(false);
      return { providerMessageId: String(id), status: status === "delivered" ? "delivered" : "accepted" };
    }
    const code = body?.["error_code"];
    if (body?.["success"] === false && typeof code === "string" && definitiveErrors[response.status]?.includes(code)) throw new OtpSmsError(true);
    throw new OtpSmsError(false);
  };
  try {
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    if (error instanceof OtpSmsError) throw error;
    throw new OtpSmsError(false);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
