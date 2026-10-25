import { createHmac } from "node:crypto";
import * as jwt from "jsonwebtoken";
import type { ExternalPickupQuote } from "../types/domain";
import { validateExternalPickupQuote } from "../store/externalPickup";
import { JWT_SECRET } from "../utils/config";
import { AppError } from "../utils/errors";

const PURPOSE = "external-pickup-v1";
const PURPOSE_V2 = "external-pickup-v2";
const MAX_TOKEN_BYTES = 12 * 1024;
// An access token signed with JWT_SECRET cannot authenticate as a pickup quote.
const quoteSigningKey = createHmac("sha256", JWT_SECRET)
  .update("TezJet/external-pickup-quote/v1", "utf8")
  .digest();
const quoteSigningKeyV2 = createHmac("sha256", JWT_SECRET)
  .update("TezJet/external-pickup-quote/v2", "utf8").digest();

function invalidQuote(): AppError {
  return new AppError(400, "Invalid pickup quote", "INVALID_PICKUP_QUOTE");
}

export function createExternalPickupQuoteToken(input: ExternalPickupQuote): string {
  try {
    const quote = validateExternalPickupQuote(input);
    const purpose = quote.version === 1 ? PURPOSE : PURPOSE_V2;
    const key = quote.version === 1 ? quoteSigningKey : quoteSigningKeyV2;
    const token = jwt.sign({
      purpose,
      quote,
      exp: Math.ceil(quote.expiresAt / 1000),
    }, key, { algorithm: "HS256", audience: purpose, noTimestamp: true });
    if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) throw invalidQuote();
    return token;
  } catch {
    throw invalidQuote();
  }
}

/**
 * Authentic expired quotes are returned so an already committed confirmation
 * can be retrieved idempotently. Stores must reject expiresAt <= Date.now()
 * before any new reservation, order creation, or price confirmation.
 */
export function verifyExternalPickupQuoteToken(token: string): ExternalPickupQuote {
  try {
    if (typeof token !== "string" || !token ||
        Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw invalidQuote();
    }
    // Unverified decoding selects a key only. Signature, purpose, audience and
    // quote version are all independently verified before any claim is used.
    const hint = jwt.decode(token);
    if (!hint || typeof hint !== "object" || (hint["purpose"] !== PURPOSE && hint["purpose"] !== PURPOSE_V2)) throw invalidQuote();
    const purpose = hint["purpose"];
    const version = purpose === PURPOSE ? 1 : 2;
    const payload = jwt.verify(token, version === 1 ? quoteSigningKey : quoteSigningKeyV2, {
      algorithms: ["HS256"],
      audience: purpose,
      ignoreExpiration: true,
    });
    if (typeof payload !== "object" || payload === null || Array.isArray(payload) ||
        payload["purpose"] !== purpose || payload.aud !== purpose ||
        Object.keys(payload).some((key) =>
          !["purpose", "quote", "exp", "aud"].includes(key))) {
      throw invalidQuote();
    }
    const quote = validateExternalPickupQuote(payload["quote"]);
    if (quote.version !== version) throw invalidQuote();
    if (!Number.isSafeInteger(payload.exp) ||
        payload.exp !== Math.ceil(quote.expiresAt / 1000)) {
      throw invalidQuote();
    }
    return quote;
  } catch {
    throw invalidQuote();
  }
}
