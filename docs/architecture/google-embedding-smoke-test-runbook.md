# Google Embedding Provider — Real-Vector Smoke Test Runbook

**Purpose:** prove the existing M3 embedding pipeline produces correct, genuine
semantic vectors with a real provider (Google's `gemini-embedding-001`),
using **exactly 100** real chunks from the real Docker docs corpus, without
risking the free-tier daily quota on the Google API key used to run it.

**This is a manual, human-run procedure.** Do not script this into a loop,
a CI job, or an unattended background task. Run each command yourself,
read its output, and stop if anything looks wrong.

## Prerequisites

- `pnpm build` has been run and is clean (`pnpm build` — confirm zero errors).
- `./data/chunks-output` contains real chunked output (regenerate via the
  chunking pipeline against `./data/ingestion-output` if it does not — see
  the M2/M3 session notes for how this was done previously; this plan does
  not recreate that step).
- You have a real Google AI Studio API key with access to `gemini-embedding-001`.
- The following lines are present in your local `.env` (never commit this
  file with a real key in it):

```
EMBEDDING_API_KEY=<your real Google API key>
EMBEDDING_MAX_CHUNKS_PER_RUN=0
```

(`EMBEDDING_MAX_CHUNKS_PER_RUN` is set to `0` in `.env` itself —
intentionally, so the _default_ environment configuration is
"unbounded," matching every other provider — and the actual `100` cap for
this specific run is passed as an inline environment override on the
command line below, not baked into `.env`, so this exact ceiling is
visible in the command you type every time, not hidden in a file.)

## Step 0: verify the wire shape with a single, tiny live call

Before running the real 100-chunk batch below, confirm one open question
about Google's exact request shape: whether each individual item in a
`batchEmbedContents` request's `requests[]` array needs a redundant
`"model": "models/gemini-embedding-001"` field, even though the model is
already in the URL path (Google's docs are ambiguous on this). Do this with
a single, tiny, bounded `curl` request — **not** a batch, and it does not
count against the 100-chunk cap below:

```bash
curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents" \
  -H "x-goog-api-key: <your real Google API key>" \
  -H "Content-Type: application/json" \
  -d '{"requests":[{"content":{"parts":[{"text":"test"}]},"embedContentConfig":{"taskType":"RETRIEVAL_DOCUMENT","outputDimensionality":768}}]}'
```

- If this returns a `200` with an `embeddings` array, the current adapter
  shape (no per-item `model` field) is correct — proceed to "The command"
  below with no code changes.
- If this returns a `400` specifically about a missing/invalid model, add
  `"model": "models/gemini-embedding-001"` to each `requests[]` entry
  built in `src/embedding/providers/google-embedding-provider.adapter.ts`'s
  `embed()` method, then re-run
  `pnpm test -- google-embedding-provider.adapter.spec.ts` to confirm the
  change before proceeding to "The command."

## The command

Run this exactly as written, once. All of the following are inline
environment overrides on top of whatever `.env` already has — nothing here
is a permanent config change:

```bash
EMBEDDING_PROVIDER=google \
EMBEDDING_MODEL=gemini-embedding-001 \
EMBEDDING_MODEL_VERSION=1 \
EMBEDDING_DIMENSIONS=768 \
EMBEDDING_INPUT_MAX_TOKENS=2000 \
EMBEDDING_MAX_CHUNKS_PER_RUN=100 \
EMBEDDING_BATCH_SIZE=10 \
EMBEDDING_MAX_CONCURRENT_BATCHES=1 \
EMBEDDING_MAX_RETRIES=3 \
EMBEDDING_OUTPUT_DIR=./data/embedding-output-google-smoke-test \
EMBEDDING_BASE_URL= \
pnpm embed ./data/chunks-output
```

**Why these specific values, beyond the 100-chunk cap:**

- `EMBEDDING_DIMENSIONS=768` — one of Google's three explicitly-recommended
  Matryoshka checkpoints for `gemini-embedding-001` (768/1536/3072), and the
  smallest of the three — appropriate for a validation run, not a
  storage-cost decision that needs revisiting later.
- `EMBEDDING_INPUT_MAX_TOKENS=2000` — Google's real per-text limit for
  `gemini-embedding-001` is **2048 tokens**, below this project's existing
  default of `8000` (safe for the other providers, not for Google). `2000`
  leaves a small margin under the real ceiling. In practice almost nothing
  should actually hit this limit — `'child'`-type chunks are already
  size-bounded well below it by the chunking module — but setting it
  explicitly means a rare oversized chunk gets truncated (with
  `truncated: true` recorded on its `EmbeddingRecord`, exactly as designed)
  instead of wasting one of your 100 chunk-attempts on a `400` error.
- `EMBEDDING_BATCH_SIZE=10` — 100 chunks ÷ 10 = exactly 10 HTTP requests to
  Google for the whole run, regardless of what the account's exact current
  RPM/RPD figures are (Google does not publish embedding-specific free-tier
  numbers in static docs as of 2026-08-13 — they're visible per-account at
  https://aistudio.google.com/rate-limit — 10 total requests is
  comfortably safe under any plausible tier).
- `EMBEDDING_MAX_CONCURRENT_BATCHES=1` — sequential, not parallel: one
  request in flight at a time, so nothing can burst past a per-minute
  ceiling.
- `EMBEDDING_MAX_RETRIES=3` — a failed request retries at most 3 times
  (existing exponential-backoff-with-jitter logic, unchanged) before that
  batch is recorded as failed and the run moves on — never an unbounded
  retry loop.
- `EMBEDDING_OUTPUT_DIR=./data/embedding-output-google-smoke-test` — a
  dedicated directory, separate from the existing fake-provider
  `./data/embedding-output/embeddings.jsonl`. This also means the existing,
  already-tested provider/model mismatch guard in
  `EmbeddingOutputStoreService` cannot fire (it would refuse to run if this
  pointed at output written by a different provider) and, if you ever
  re-run this exact command a second time on top of a **fully successful**
  first run, the existing resumability logic makes it a **zero-cost
  no-op** — all 100 `embeddingId`s are already present, so
  `alreadyEmbedded` will read `100` and `attempted` will read `0`. This
  free-re-run guarantee does **not** hold for a partially-or-fully-failed
  first run — see the resumability caveat under "If something goes wrong"
  below before re-running after any failure.
- `EMBEDDING_BASE_URL=` (explicitly empty) — neutralizes any stale, non-empty
  value already sitting in your `.env` from earlier Voyage/OpenAI
  experimentation. Voyage/OpenAI treat `EMBEDDING_BASE_URL` as a _complete
  endpoint URL_, but the Google adapter treats it as an _API root prefix_
  it appends `/models/{model}:batchEmbedContents` onto — a leftover value
  pointed at some other host would silently send your real Google API key
  (via the `x-goog-api-key` header) to that host instead of Google's API.
  Leaving this blank forces the adapter's built-in
  `https://generativelanguage.googleapis.com/v1beta` default.

## What to check afterward

1. The printed `EmbeddingRunResult` JSON shows `"attempted": 100`,
   `"succeeded": 100` (or close to it — some real-world failures are
   expected and fine; the point is proving the pipeline handles them, not
   demanding perfection), `"failed"` plus `"succeeded"` summing to `100`,
   and `"totalBatches": 10`.
2. `wc -l ./data/embedding-output-google-smoke-test/embeddings.jsonl`
   reports at most `100` lines (exactly `succeeded`, since failed chunks
   are never written).
3. Spot-check one line with `head -1 ... | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).vector.length)"`
   (or open it in an editor) — the vector should have exactly `768`
   elements, all real (non-integer, varied) floating-point numbers — not
   the fake provider's SHA-256-derived pattern.
4. Optional, stronger semantic-quality check: pick two chunks you know are
   topically related (e.g. two chunks from the same `install-docker`-style
   document) and two you know are unrelated (e.g. one networking chunk, one
   licensing chunk), compute cosine similarity between their real vectors
   (a five-line Node script is enough), and confirm the related pair scores
   higher than the unrelated pair. This is the actual proof that these are
   _real_ semantic embeddings, not just successfully-shaped API responses.
   Note: at 768 dimensions, `gemini-embedding-001`'s output vectors are
   **not** unit-normalized by the API (per Google's own docs — only the
   full 3072-dimension output is). This cosine-similarity check doesn't
   need normalization since cosine similarity is scale-invariant, but if a
   future vector store needs unit vectors (e.g. for a dot-product-based
   similarity index), normalize these at ingestion time.

## If something goes wrong

- **401/403 error:** your API key is invalid or lacks access to
  `gemini-embedding-001` — fix the key before re-running, don't retry
  blindly.
- **429 rate limited on the very first batch:** your account's actual
  current free-tier limits are stricter than assumed — stop, check
  https://aistudio.google.com/rate-limit, and lower
  `EMBEDDING_BATCH_SIZE`/add a manual delay between runs rather than
  re-running immediately.
- **`Embedding run failed: ...` printed, with no `EmbeddingRunResult` JSON:**
  `EMBEDDING_FAILURE_THRESHOLD` defaults to `0.5` and is not overridden by
  this runbook's command — if more than half of the 10 batches fail (e.g.
  every batch 400s on a wrong request shape), `EmbeddingPipelineService.run()`
  throws `EmbeddingThresholdExceededError` _before_ it ever constructs an
  `EmbeddingRunResult`, so there is no `failures` array to read from the
  final output. Scroll up in the terminal output instead: each failed batch
  logs its own `Embedding batch failed permanently after retries` warning
  line (structured with `batchId`, `chunkCount`, and `error`) from
  `EmbeddingBatchProcessorService` as the run proceeds — that's where the
  actual diagnostic detail is.
- **Any other failure (an `EmbeddingRunResult` JSON was printed):** the
  run's own `failures` array in the printed result names the failing
  `chunkId`s and error messages.
- **Before re-running after any failure:** re-running is a free no-op only
  for the chunks that were _already successfully written_ to the output
  file — failed chunks are never written, so a re-run does not simply
  retry them for free. Instead, a re-run treats those failed chunks as
  still-eligible input and will fill the rest of a fresh capped batch of
  100 with brand-new chunks (in the worst case — e.g. every chunk failed —
  a re-run spends a completely fresh 100). Diagnose and fix the root cause
  of the failure first (see above); don't reflexively re-run expecting it
  to be free unless you've confirmed the prior run fully succeeded.
