import type { NormalizedAddress } from "../types/domain";
import { AppError } from "../utils/errors";

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 15_000;

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableCoordinate(value: unknown, min: number, max: number): number | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue >= min && numberValue <= max
    ? numberValue
    : null;
}

function normalizeModelResult(
  input: string,
  value: unknown,
): NormalizedAddress {
  const result =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const confidence =
    result["confidence"] === "high" ||
    result["confidence"] === "medium" ||
    result["confidence"] === "low"
      ? result["confidence"]
      : "low";
  const landmarks = Array.isArray(result["landmarks"])
    ? result["landmarks"].filter(
        (landmark): landmark is string =>
          typeof landmark === "string" && landmark.trim().length > 0,
      )
    : [];
  const notes = Array.isArray(result["notes"])
    ? result["notes"].filter(
        (note): note is string =>
          typeof note === "string" && note.trim().length > 0,
      )
    : [];

  return {
    original: input,
    normalized: nullableString(result["normalized"]) ?? input,
    country: nullableString(result["country"]),
    region: nullableString(result["region"]),
    city: nullableString(result["city"]),
    district: nullableString(result["district"]),
    street: nullableString(result["street"]),
    houseNumber: nullableString(result["house_number"]),
    postalCode: nullableString(result["postal_code"]),
    landmarks,
    latitude: nullableCoordinate(result["latitude"], -90, 90),
    longitude: nullableCoordinate(result["longitude"], -180, 180),
    confidence,
    notes,
  };
}

function extractJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

export async function normalizeNaturalLanguageAddress(
  address: string,
  locale: string,
): Promise<NormalizedAddress> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AppError(
      503,
      "Address processing is not configured",
      "GEMINI_NOT_CONFIGURED",
    );
  }

  const prompt = `You normalize natural-language addresses for TezJet, a rural taxi service.
Return only valid JSON matching the requested structure.
Do not invent missing details or coordinates. Set unknown scalar fields to null,
unknown coordinates to null, confidence to low, and explain uncertainty in notes.
Preserve useful local landmarks and colloquial location descriptions.
The user's preferred language is ${locale}.

Input address:
${address}

JSON shape:
{
  "normalized": "complete readable address",
  "country": "string or null",
  "region": "string or null",
  "city": "string or null",
  "district": "string or null",
  "street": "string or null",
  "house_number": "string or null",
  "postal_code": "string or null",
  "landmarks": ["string"],
  "latitude": "number or null",
  "longitude": "number or null",
  "confidence": "low | medium | high",
  "notes": ["string"]
}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const result = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!result.ok) {
      // The provider body can contain the submitted address or credentials.
      // Discard it without reflecting it to the client or logging it.
      if (result.body) void result.body.cancel().catch(() => undefined);
      throw new AppError(
        502,
        "Gemini address processing is temporarily unavailable",
        "GEMINI_UPSTREAM_ERROR",
      );
    }

    let payload: GeminiResponse;
    try {
      payload = (await result.json()) as GeminiResponse;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Invalid provider response envelope");
      }
    } catch (error) {
      // A timeout while reading the response body retains the timeout contract.
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new AppError(502, "Gemini returned an invalid address result", "GEMINI_INVALID_RESPONSE");
    }
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new AppError(
        502,
        "Gemini returned an empty address result",
        "GEMINI_EMPTY_RESPONSE",
      );
    }

    try {
      return normalizeModelResult(address, extractJson(text));
    } catch {
      throw new AppError(
        502,
        "Gemini returned an invalid address result",
        "GEMINI_INVALID_RESPONSE",
      );
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new AppError(
        504,
        "Gemini address processing timed out",
        "GEMINI_TIMEOUT",
      );
    }
    throw new AppError(
      502,
      "Could not reach Gemini address processing",
      "GEMINI_CONNECTION_ERROR",
    );
  } finally {
    clearTimeout(timeout);
  }
}
