<!-- codecontext:managed -->
# CodeContext — Agent Rules

This project uses a **CodeContext** local RAG server (http://127.0.0.1:7777)
exposed via MCP tools. Follow these rules to maximise token savings.

## Mandatory workflow

| When | Tool to call |
|------|--------------|
| Before answering any question about the codebase | `codecontext_search` first — never read files without searching |
| After creating or editing any file | `codecontext_ingest` with the full file content and file path as `source` |
| Long text to include in a response | `codecontext_compress` (ratio 0.5) |
| Complex multi-file research task | `codecontext_rag` (search + rerank + compress in one call) |
| Unsure if server is running | `codecontext_health` |

## Collection

Always pass `collection="bosun"` on every tool call.

## Why

CodeContext performs local embedding, reranking (BGE), and LLMLingua compression.
Token savings only accumulate when agents call these tools instead of reading
files directly.
