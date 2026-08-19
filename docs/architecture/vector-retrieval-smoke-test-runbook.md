# Vector Retrieval Smoke Test Runbook (M4)

Human-supervised, not autonomous — this executes real commands against a real local Qdrant instance and 100 real Google-embedded chunks. No fake/mocked provider is used anywhere in this run.

## What was actually run (2026-08-19)

- **Real Docker docs corpus**: `~/Downloads/docs-main.zip` (already on disk from an earlier session, not re-downloaded), ingested → 1,508 `StructuredDocument`s, reused from `data/ingestion-output/` in the main checkout.
- **Chunking**: regenerated fresh in this worktree via the real, unmodified `ChunkingPipelineService` (no `pnpm chunk` CLI exists yet — a throwaway test script drove it, deleted afterward) → 30,016 real chunks, 14,387 of them `'child'`-type (eligible for embedding).
- **Embedding**: real Google `gemini-embedding-2`, 768 dimensions, capped at 100 chunks via `EMBEDDING_MAX_CHUNKS_PER_RUN=100`. Output stored at `/home/harshit/Harshit/projects/docker-support/data/embedding-output-google-smoke-test/embeddings.jsonl` (in the **main project's** `data/` directory, not this worktree's, so it survives worktree cleanup and can be reused by a future run).
- **Indexing**: real local Qdrant (`docker compose up -d qdrant`), collection `docker__google_gemini_embedding_2_768d_v1`.

### Step 1 result: indexing

```json
{
  "attempted": 100,
  "succeeded": 100,
  "failed": 0,
  "totalBatches": 10
}
```

100/100 succeeded — zero failures embedding or indexing. Vector shape spot-checked: 768 real, varied floating-point values (e.g. `[-0.0192, 0.0113, 0.0158, -0.0531, 0.0057, ...]`), not the fake provider's SHA-256-derived pattern. The full mechanical pipeline (ingest → chunk → embed → index → query) works correctly end-to-end against real data.

### Step 2 result: benchmark queries — a corpus-coverage finding, not a retrieval-algorithm finding

Before recording per-query relevance judgments, an inspection of _which_ 100 chunks the `EMBEDDING_MAX_CHUNKS_PER_RUN=100` cap actually selected explains every result below:

```json
{
  "docs-main/layouts/cli.markdown.md": 2,
  "docs-main/content/manuals/engine/release-notes/28.md": 98
}
```

**98 of the 100 embedded-and-indexed chunks come from a single release-notes document; the other 2 come from a Hugo template shortcode file.** `EmbeddingPipelineService` scans `*.chunks.json` files and applies the 100-chunk cap in directory-listing order, not a random or stratified sample across the corpus — with a 14,387-chunk eligible pool, a 100-chunk cap taken in file-listing order landed almost entirely inside one large document. This is a real, useful finding this smoke test exists to surface (per its own stated purpose: "a successful vector search with plausible-looking scores is not evidence of retrieval quality — only checking whether the right content actually surfaces is"), not a flaw in `RetrievalService`, `QdrantVectorStoreAdapter`, or the embedding pipeline itself.

| #   | Question                                           | Top result source                                           | Score | Addresses the question? | Notes                                                                                                                                                                                              |
| --- | -------------------------------------------------- | ----------------------------------------------------------- | ----- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What is the difference between CMD and ENTRYPOINT? | `docs-main/layouts/cli.markdown.md` (`{{ .Title }}`)        | 0.632 | **No**                  | Matched a Hugo template shortcode (raw `{{ }}` syntax), not prose documentation — a direct consequence of the template file being 1 of only 2 non-release-notes documents in the 100-chunk sample. |
| 2   | How do Docker volumes differ from bind mounts?     | `engine/release-notes/28.md` › `28.0.0 › New`               | 0.656 | **No**                  | A changelog bullet about `--mount type=image`, tangentially related to mounting but not an explanation of volumes vs. bind mounts.                                                                 |
| 3   | How does bridge networking work?                   | `engine/release-notes/28.md` › `28.0.0 › Networking`        | 0.714 | **No**                  | A changelog bullet about a `docker-proxy` binary update — mentions "networking" only because it's under that changelog section heading, not because it explains bridge networking.                 |
| 4   | What does `COPY --from` do?                        | `engine/release-notes/28.md` › `28.0.0 › New`               | 0.688 | **No**                  | Same changelog chunk as Q2 — no conceptual `COPY --from` documentation exists anywhere in the 100-chunk sample.                                                                                    |
| 5   | How does Docker Compose healthcheck work?          | `engine/release-notes/28.md` › `28.3.3 › Packaging updates` | 0.601 | **No**                  | A changelog bullet about a Buildx/Compose version bump — mentions "Compose" only in passing, not healthchecks.                                                                                     |
| 6   | What is the difference between ARG and ENV?        | `engine/release-notes/28.md` › `28.0.0 › API`               | 0.634 | **No**                  | A changelog bullet about a containerd image-store API field — no relation to `ARG`/`ENV`.                                                                                                          |

**Human judgment (recorded 2026-08-19):** none of the 6 top results meaningfully address their question. Given the corpus-coverage finding above, this is the expected outcome of querying against a 100-chunk sample that is ~98% one changelog document — it is not evidence that `RetrievalService`'s vector search, filtering, or scoring logic is broken. The scores themselves (0.60–0.71 cosine similarity) are in a plausible range and correctly rank-order relative to each other; they simply have no genuinely relevant chunk to find in this sample.

## Root cause and recommended follow-up (not implemented in this task — out of M4's scope)

`EmbeddingPipelineService`'s `EMBEDDING_MAX_CHUNKS_PER_RUN` cap selects chunks in file-scan order, which is adequate for _quota safety_ (its original, narrower M3.1 purpose) but not for producing a _representative_ sample for a retrieval-quality smoke test. A future task (M4 follow-up or M5) should either:

- Re-run this smoke test with a much larger cap (or `EMBEDDING_MAX_CHUNKS_PER_RUN=0`, unbounded) to embed a representative fraction of the real corpus, at higher real API cost/quota usage, or
- Add a stratified/random sampling mode to the cap (e.g. shuffle file order, or cap per-document rather than globally) specifically for smoke-test-style runs, without changing the cap's existing quota-safety behavior for normal production runs.

Neither is implemented here — this runbook's deliverable is the honest baseline finding above, which M5's hybrid-retrieval and reranking work should be measured against only after a representative-sample re-run.

## Prerequisites (for a future re-run)

- `docker compose up -d qdrant` (see `docs/architecture/vector-store-local-dev.md`)
- `pnpm build`
- Real embeddings and their source chunks both present locally (this run's copy lives at `/home/harshit/Harshit/projects/docker-support/data/embedding-output-google-smoke-test/embeddings.jsonl`, outside any single worktree, specifically so it survives worktree cleanup and can be reused directly by a future, larger-sample re-run without spending API quota again on the same 100 chunks).

## Step 4: Tear down

```bash
docker compose down -v
```

(Executed after this run. The real embeddings in `data/embedding-output-google-smoke-test/` were deliberately left in place in the main project's `data/` directory, not deleted, for reuse.)
