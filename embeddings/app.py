from __future__ import annotations

import os
import time
from functools import lru_cache
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastembed import TextEmbedding
from pydantic import BaseModel


MODEL_ALIAS = os.getenv("EMBEDDING_MODEL_ALIAS", "text-embedding-3-small")
MODEL_NAME = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
CACHE_DIR = os.getenv("EMBEDDING_CACHE_DIR", "/cache")

app = FastAPI(title="LLMHQ Embeddings", version="0.1.0")


class EmbeddingRequest(BaseModel):
    model: str | None = None
    input: str | list[str]


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model_alias": MODEL_ALIAS,
        "model": MODEL_NAME,
    }


@app.get("/v1/models")
def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_ALIAS,
                "object": "model",
                "kind": "embedding",
                "provider": "fastembed",
                "native_model": MODEL_NAME,
            }
        ],
    }


@app.post("/v1/embeddings")
def embeddings(request: EmbeddingRequest) -> dict[str, Any]:
    texts = normalize_input(request.input)
    requested_model = request.model or MODEL_ALIAS
    started = time.monotonic()
    try:
        vectors = [vector.tolist() for vector in get_model().embed(texts)]
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"embedding model failed: {exc}") from exc
    return {
        "object": "list",
        "model": requested_model,
        "used_model": MODEL_NAME,
        "data": [
            {
                "object": "embedding",
                "index": index,
                "embedding": vector,
            }
            for index, vector in enumerate(vectors)
        ],
        "usage": None,
        "llmhq_embedding": {
            "provider": "fastembed",
            "latency_ms": round((time.monotonic() - started) * 1000, 1),
        },
    }


def normalize_input(value: str | list[str]) -> list[str]:
    if isinstance(value, str):
        if not value.strip():
            raise HTTPException(status_code=400, detail="input must not be empty")
        return [value]
    if isinstance(value, list) and value and all(isinstance(item, str) and item.strip() for item in value):
        return value
    raise HTTPException(status_code=400, detail="input must be a non-empty string or string array")


@lru_cache(maxsize=1)
def get_model() -> TextEmbedding:
    return TextEmbedding(model_name=MODEL_NAME, cache_dir=CACHE_DIR)


if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host=os.getenv("EMBEDDING_HOST", "0.0.0.0"),
        port=int(os.getenv("EMBEDDING_PORT", "8080")),
    )
