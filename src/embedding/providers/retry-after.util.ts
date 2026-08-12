// Per RFC 7231, a `Retry-After` header may be either delay-seconds (e.g.
// "3") or an HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT"). `Number()` on
// an HTTP-date (or any other non-numeric string) yields `NaN`, which must
// never reach `withRetry` — `NaN` flows through `??` untouched (it is
// neither `null` nor `undefined`) and resolves a `setTimeout` almost
// instantly, burning every remaining retry attempt in milliseconds against a
// provider that just asked us to slow down. Only a finite, non-negative
// delay-seconds value is treated as valid; anything else falls back to
// `null` so the caller's own computed exponential backoff takes over.
export function parseRetryAfterMs(
  retryAfterHeader: string | null,
): number | null {
  if (retryAfterHeader === null) {
    return null;
  }

  const seconds = Number(retryAfterHeader);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  return seconds * 1000;
}
