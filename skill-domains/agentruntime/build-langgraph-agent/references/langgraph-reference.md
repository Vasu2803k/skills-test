# LangGraph on AgentRuntime — Advanced Reference

> Complements SKILL.md. Read that first for basics, config.yaml, and the canonical example.
> Official docs: https://langchain-ai.github.io/langgraph/
> Changelog: https://github.com/langchain-ai/langgraph/releases

---

## How the platform invokes your agent

`main.py.j2` (the generated FastAPI wrapper) inspects your `@app.entrypoint` function
signature at import time using `inspect.signature()`.

**Two calling conventions:**

| Mode | Detection | How platform calls you |
|------|-----------|------------------------|
| **Kwargs-unpack** | Multiple named params (`messages`, `auth_context`, `session_id`, `streaming`) | `invoke(**{"messages": [...], "auth_context": ctx, ...})` |
| **Single-dict** | First param is `dict`-typed or named (`inputs`, `input`, `request`, `data`, `payload`, `kwargs`) | `invoke({"messages": [...], "auth_context": ctx, ...})` |

**Platform-injected params** (excluded from convention detection):
- `session_id` — caller-provided thread identifier
- `auth_context` — `AuthContext` frozen dataclass from JWT
- `streaming` — `bool`, True when `Accept: text/event-stream`

Use kwargs-unpack (Convention B) always for LangGraph — it's the standard.

---

## AuthContext deep dive

`AuthContext` is frozen (immutable). Key patterns:

```python
# Forward caller identity to downstream services
resp = await httpx.AsyncClient().get(
    "https://internal-service/data",
    headers=auth_context.get_auth_header(),
)

# Role-based access control
if not auth_context.has_role("agent-user"):
    return {"content": "Unauthorized", "role": "assistant"}

# Check multiple roles
if auth_context.has_any_role(["admin", "premium"]):
    # elevated access
    pass

# Access custom JWT claims
dept = auth_context.claims.get("department", "unknown")
tenant = auth_context.customer_id
```

**`roles` is a tuple** (not list) — `"premium" in auth_context.roles` works directly.

**Guard `auth_context` before use** — it's `None` for health checks and local dev:
```python
if auth_context and auth_context.has_role("premium"):
    ...
```

**Passing to graph state:** AuthContext is a frozen dataclass — serialize to dict before
putting in LangGraph State, because StateGraph serializes state to DB checkpoints:

```python
# DO: serialize to dict
auth_dict = {
    "user_id":     auth_context.user_id,
    "email":       auth_context.email,
    "roles":       list(auth_context.roles),
    "customer_id": auth_context.customer_id,
} if auth_context else None

state = {"messages": lc_msg, "auth_context": auth_dict}

# Inside node: reconstruct roles check
def route(state: State) -> str:
    auth = state.get("auth_context") or {}
    return "premium" if "premium" in auth.get("roles", []) else "basic"
```

---

## EventSerializer and SSE streaming

The platform's `EventSerializer` handles all SSE formatting. It:
1. Consumes your returned async iterator
2. Serializes each item with `json.dumps` (handles Pydantic, dataclasses, Enums, bytes)
3. Wraps as `data: <json>\n\n`
4. Sends `data: {"event": "complete"}\n\n` on normal completion
5. Sends `data: {"event": "error", "error": "..."}\n\n` on failure
6. Per-event timeout: 5 minutes (configurable via `EventSerializer._DEFAULT_STREAM_TIMEOUT`)

**What you can return for streaming:**

```python
# 1. astream_events — full event graph (tokens, tool calls, node transitions)
return graph.astream_events(state, config=config, version="v2")

# 2. astream messages — message chunks only
return graph.astream(state, config=config, stream_mode="messages")

# 3. astream updates — full state after each node
return graph.astream(state, config=config, stream_mode="updates")

# 4. astream values — state values (same as updates but different format)
return graph.astream(state, config=config, stream_mode="values")

# 5. Custom generator with filtering
async def filtered_stream():
    async for event in graph.astream_events(state, config=config, version="v2"):
        if event["event"] == "on_chat_model_stream":
            chunk = event["data"]["chunk"].content
            if chunk:
                yield {"type": "token", "content": chunk}
    # Platform sends {"event": "complete", "status": "completed"} when the generator ends — no custom sentinel needed
return filtered_stream()
```

**Never pre-format SSE strings:**
```python
# WRONG — platform double-wraps this
yield f"data: {json.dumps(payload)}\n\n"

# WRONG — don't yield raw strings expecting SSE format
yield "data: hello\n\n"

# CORRECT — yield plain dicts
yield {"content": "hello", "role": "assistant"}
```

---

## Memory DB: connection string format

When `enable_memory: true` at deploy time:
- `MEMORY_DB_URI = "postgresql://user:pass@host:5432/dbname"` (plain `postgresql://`)
- **Do NOT** transform to `postgresql+asyncpg://` — LangGraph uses psycopg3 natively
- psycopg3's `AsyncConnectionPool` and `AsyncPostgresSaver` handle async without SQLAlchemy

```python
# CORRECT
MEMORY_DB_URI = os.getenv("MEMORY_DB_URI")
# Use as-is with AsyncPostgresSaver

# WRONG — don't rewrite the scheme
MEMORY_DB_URI = raw.replace("postgresql://", "postgresql+asyncpg://")
```

### DML-only privileges

| Table | Pre-created | Purpose |
|-------|-------------|---------|
| `checkpoints` | Yes | Checkpoint metadata |
| `checkpoint_blobs` | Yes | Serialized state blobs |
| `checkpoint_writes` | Yes | Write-ahead log |

**Never call `checkpointer.setup()`** — any DDL will fail:
```
ProgrammingError: permission denied for relation checkpoints
```

Both connection paths:
```python
# Path 1: from_conn_string
saver = AsyncPostgresSaver.from_conn_string(MEMORY_DB_URI)
checkpointer = await saver.__aenter__()
# DO NOT: await checkpointer.setup()

# Path 2: manual pool
pool = AsyncConnectionPool(conninfo=MEMORY_DB_URI, open=False)
await pool.open()
checkpointer = AsyncPostgresSaver(pool)
# DO NOT: await checkpointer.setup()
```

---

## Mem0 collection naming

| Embedding dimensions | Collection name |
|---------------------|-----------------|
| 1536 | `mem0` |
| N (any other) | `mem0_N` |

This convention is enforced across all agents sharing the same DB. Wrong collection name
creates a separate, empty collection — searches return nothing.

**AWS Bedrock embedder (production):**

```python
"embedder": {
    "provider": "aws_bedrock",
    "config": {
        "model": "amazon.titan-embed-text-v2:0",
        "embedding_dims": 1024,
    },
}
# Titan v2 = 1024 dims → collection "mem0_1024"
```

**OpenAI embedder (development):**
```python
"embedder": {
    "provider": "openai",
    "config": {
        "model": "text-embedding-3-small",  # 1536 dims → "mem0"
        # "model": "text-embedding-3-large"  # 3072 dims → "mem0_3072"
    },
}
```

---

## Lifecycle hooks in depth

`on_startup` runs once per pod, before any traffic. Use it for:
- Opening async connection pools (so first request isn't slow)
- Compiling the graph (catches graph errors on startup, not at request time)
- Pre-warming caches or loading models

`on_shutdown` runs on SIGTERM, before pod termination:
- Closing pools to avoid connection leaks
- Flushing metrics/buffers

```python
_pool: AsyncConnectionPool | None = None
_graph = None

@app.on_startup
async def init():
    global _pool, _graph
    uri = os.getenv("MEMORY_DB_URI")
    if uri:
        _pool = AsyncConnectionPool(conninfo=uri, open=False, min_size=2, max_size=10)
        await _pool.open()
        checkpointer = AsyncPostgresSaver(_pool)
        _graph = builder.compile(checkpointer=checkpointer)
        logger.info("Compiled with PostgreSQL checkpointer")
    else:
        _graph = builder.compile()
        logger.info("Compiled without checkpointer")

@app.on_shutdown
async def cleanup():
    if _pool:
        await _pool.close()
        logger.info("Connection pool closed")
```

**Why `on_startup` > lazy init:**
1. Fails fast — pod fails readiness probe if DB is unreachable, surfacing the issue immediately
2. No first-request latency from pool creation
3. Avoids race conditions if multiple requests arrive concurrently before init completes

---

## Advanced state design

### Multi-field state with reducers

```python
from typing import Annotated, TypedDict
from langgraph.graph.message import add_messages
from operator import add

class State(TypedDict):
    messages:  Annotated[list, add_messages]  # append-only; deduplicates by ID
    context:   Annotated[list, add]           # plain list append
    metadata:  dict                           # last-write wins
    iteration: int                            # last-write wins
```

### Human-in-the-loop with interrupt

```python
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import StateGraph, END, START

builder = StateGraph(State)
builder.add_node("agent",   agent_node)
builder.add_node("human",   human_node)  # waits for external input
builder.add_node("process", process_node)
builder.add_edge("agent",  "human")
builder.add_edge("human",  "process")
builder.add_edge("process", END)

# Interrupt before "human" node — graph pauses, state is checkpointed
compiled = builder.compile(
    checkpointer=checkpointer,
    interrupt_before=["human"],
)

# Resume with external input by invoking with the same thread_id
await compiled.ainvoke(
    Command(resume="user input here"),
    config={"configurable": {"thread_id": session_id}},
)
```

---

## Error handling and resilience

```python
from langgraph.errors import NodeInterrupt, GraphRecursionError

@app.entrypoint
async def invoke(messages: list, auth_context=None, session_id=None, streaming=False):
    graph  = await get_graph()
    lc_msg = to_lc(messages)
    config = {"configurable": {"thread_id": session_id or "default"}}
    try:
        if streaming:
            return graph.astream_events({"messages": lc_msg}, config=config, version="v2")
        result = await graph.ainvoke({"messages": lc_msg}, config=config)
        return {"content": result["messages"][-1].content, "role": "assistant"}
    except GraphRecursionError:
        return {"content": "Processing took too many steps. Please simplify.", "role": "assistant"}
    except NodeInterrupt as e:
        return {"content": f"Interrupted: {e}", "role": "assistant"}
    except Exception as e:
        logger.error("Graph invocation error: %s", e, exc_info=True)
        return {"content": f"I encountered an error: {type(e).__name__}", "role": "assistant"}
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `permission denied for relation checkpoints` | Called `setup()` or issued DDL | Remove `checkpointer.setup()` |
| First request hangs 30s+ | Lazy pool init in `invoke()` | Move pool + graph init to `on_startup` |
| Streaming returns single blob | Returned a coroutine instead of async iterator | `return graph.astream_events(...)` without `await` |
| `thread_id` missing error | Empty `configurable` dict | Always pass `{"configurable": {"thread_id": ...}}` |
| `+asyncpg` connection error | Modified MEMORY_DB_URI scheme | Use URI as-is — psycopg3 is natively async |
| Mem0 search returns empty | Wrong collection name | 1536 dims → `"mem0"`, N dims → `"mem0_N"` |
| State not persisting between sessions | Different `thread_id` per call | Use same `session_id` → same `thread_id` |
| `StateGraph` schema validation error | AuthContext object in State | Serialize AuthContext to dict before storing in State |
| Graph not found / `None` | Called `invoke` before `on_startup` | Check startup hook registration |
| Tool calls not appearing in SSE | Using `astream(stream_mode="updates")` | Switch to `astream_events(..., version="v2")` |
