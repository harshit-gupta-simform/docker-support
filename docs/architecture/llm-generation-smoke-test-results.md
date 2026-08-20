# M5 LLM Generation — Real Gemini Smoke Test Results

**Date:** 2026-08-20
**Provider/model:** `google` / `gemini-3.6-flash` (via `@langchain/google-genai`)
**Corpus:** same real Docker documentation corpus indexed during the M4 smoke test (`docker__google_gemini_embedding_2_768d_v1` collection)

## Queries run

| #   | Query                                                | Result                                                                                  | Notes                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | "What is the difference between CMD and ENTRYPOINT?" | 200, honest "no information available", `sources: []`                                   | Retrieved chunks (Install Docker, a Go template file, several Engine v28 release notes) don't actually cover Dockerfile CMD/ENTRYPOINT reference docs — a corpus/retrieval coverage gap already noted in the M4 smoke-test runbook, not an M5 defect. Correct behavior: no hallucination. |
| 6   | "What is the capital of France?" (out-of-domain)     | 200, "the supplied documentation does not contain information...", `sources: []`, ~4.8s | Exactly the required demo-safety behavior — no confident general-knowledge answer.                                                                                                                                                                                                        |

Queries 2–5 (COPY vs ADD, volumes vs bind mounts, EXPOSE, Compose healthcheck) were not run — the two above were sufficient to confirm both failure modes that mattered (grounded-but-irrelevant-corpus and out-of-domain), and further real API spend wasn't warranted once the two live bugs below were found and fixed.

## Real bugs found and fixed via this smoke test

1. **`gemini-2.5-flash` is deprecated for new API keys.** The real Google API returned `404 Not Found: This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.6-flash.` Fixed by changing `LLM_MODEL`'s schema default to `gemini-3.6-flash` (commit `2c2729e`). **Action for the user:** update `LLM_MODEL` in your real `.env` if you copied the old default — you already did this during the session.
2. **`LLM_TIMEOUT_MS=15000` was too aggressive.** A 5-chunk, parent-expanded prompt (`RETRIEVAL_EXPAND_TO_PARENT=true` default) took 22–31s in real generation calls, exceeding the timeout even after one retry and surfacing as a 503. Bumped the schema default to `30000` (commit `2c2729e`).
3. **Citation fallback was misleading on non-answers.** When Gemini correctly declined to answer (query #1 above), it cited nothing — and the original `extractCitations` fallback ("no citations found → return every sent chunk") attached all 5 retrieved chunks as confident-looking `sources` to an "I don't know" answer. Removed the fallback entirely; `sources` is now empty whenever the model cites nothing (commit `48b3269`). Confirmed via unit tests (`citation-extractor.util.spec.ts`) and a second live call to query #1, which now correctly returns `sources: []`.

## Known, not fixed (out of scope for this smoke test)

- The corpus's apparent bias toward release-notes/install-page content over Dockerfile-reference content (query #1) is a retrieval/indexing coverage question, not a generation-layer bug — same root cause as the "98/100 chunks from one release-notes file" finding already documented in the M4 smoke-test runbook. Re-indexing with better corpus coverage would improve grounded-answer quality but is out of M5's scope.
- `LLM_MIN_RETRIEVAL_SCORE` remains at its default of `0` (inert). The real `highestScore` values observed during this test (~0.63–0.69 for a genuinely off-topic retrieval) suggest a non-zero threshold could help pre-filter poor matches earlier, but tuning this needs more sample queries than this smoke test ran — left as a follow-up.
