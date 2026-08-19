# Vector Store Local Development

Reproducible steps to run Qdrant locally, index the current corpus, and run a retrieval query. See `docs/architecture/vector-storage-retrieval-design.md` §20 for the full design rationale.

## 1. Start the vector database

    docker compose up -d qdrant

Verify it's up: `curl http://localhost:6333/collections` should return `{"result":{"collections":[]},"status":"ok",...}`.

## 2. Index embeddings

    pnpm build
    pnpm index ./data/embedding-output/embeddings.jsonl ./data/chunks-output

This creates the collection (if absent, named per `docs/architecture/vector-storage-retrieval-design.md` §9) and upserts every eligible record. Re-running is safe — upserts are idempotent by `embeddingId`-derived point ID.

## 3. Execute a retrieval query

    pnpm query "How do I install Docker on Ubuntu?"

Prints ranked `RetrievalResult[]` as JSON, including each match's own text and its resolved parent section's text.

## 4. Inspect results directly

- Qdrant's bundled dashboard: http://localhost:6333/dashboard
- Raw REST: `curl http://localhost:6333/collections/<collection-name>`

## 5. Reset the local store

    docker compose down -v

Drops the named volume entirely — the next `docker compose up -d qdrant` starts from empty. Re-run step 2 to repopulate.

## Notes

- `VECTOR_STORE_PROVIDER=fake` runs entirely in-memory, per-process — useful for automated tests, not for the workflow above (each CLI invocation gets its own empty store).
- No authentication or TLS is configured — correct for local development only. See the design doc §24 for the production posture this must not be mistaken for.
