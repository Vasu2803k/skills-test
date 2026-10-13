---
name: build-langgraph-agent
description: >
  Build an agent using LangGraph that runs on AgentRuntime. Use this skill whenever the user
  wants to create a LangGraph agent, a state machine agent, an agent with checkpointing, RAG
  agents, multi-step workflows, conditional routing, parallel fan-out, subgraph composition,
  tool calling agents, or anything involving langgraph on AgentRuntime. Also triggers for:
  "LangGraph", "StateGraph", "RAG agent", "langgraph checkpoints", "create_react_agent",
  "AsyncPostgresSaver", "astream_events", "langgraph workflow", "state machine agent",
  "conditional edges", "parallel nodes", "graph compilation".
---

# Build a LangGraph Agent for AgentRuntime

You are building an agent using **LangGraph** on **AgentRuntime** — the FastAPI-based platform
that wraps your agent in a K8s pod with JWT auth, SSE streaming, memory provisioning, and schema
translation.

> **Official LangGraph docs:** https://langchain-ai.github.io/langgraph/
> **LangGraph API reference:** https://langchain-ai.github.io/langgraph/reference/
> **LangGraph how-to guides:** https://langchain-ai.github.io/langgraph/how-tos/
> Always check docs for the latest checkpointer API — it evolves across minor versions.

---

## Required files

| File | Purpose |
|------|---------|
| `agent.py` | Agent logic with `@app.entrypoint` |
| `config.yaml` | Metadata + environment variables |
| `requirements.txt` | Python dependencies |

---

## AgentRuntime import pattern

The platform bundles `agent_runtime` as a sibling package inside the deployment. Always use
the try/except so the agent works both locally (direct import) and deployed (relative import):

```python
try:
    from .agent_runtime.runtime import AgentRuntimeApp
except ImportError:
    from agent_runtime.runtime import AgentRuntimeApp

app = AgentRuntimeApp()
```

---

## AuthContext — full API

`AuthContext` is a **frozen dataclass** injected from the caller's JWT:

```python
@dataclass(frozen=True)
class AuthContext:
    token: str = ""          # Raw JWT — use for downstream service calls
    user_id: str = ""        # Unique user identifier
    email: str = ""          # User's email
    customer_id: str = ""    # Tenant identifier
    roles: tuple = field(default_factory=tuple)   # Role strings from JWT
    claims: dict = field(default_factory=dict)    # Full decoded JWT payload

    def get_auth_header(self) -> dict[str, str]:
        """Returns {"Authorization": "Bearer <token>"}"""

    def has_role(self, role: str) -> bool:
        """True if role is in self.roles"""

    def has_any_role(self, roles: list) -> bool:
        """True if any of roles are in self.roles"""
```

**Important:** `roles` is a **tuple**, not a list. `has_role()` and `has_any_role()` do
membership checks. `auth_context` is `None` for unauthenticated requests — always guard:

```python
if auth_context and auth_context.has_role("premium"):
    # premium path
```

---

## Entrypoint signature

The platform inspects your signature to determine the calling convention. Use named kwargs:

```python
@app.entrypoint
async def invoke(
    messages: list,                   # list of {"role": ..., "content": ...}
    auth_context=None,               # AuthContext from JWT
    session_id: str | None = None,   # caller-provided session ID → use as thread_id
    streaming: bool = False,         # True when caller sends Accept: text/event-stream
):
```

**Platform-injected parameters** (excluded from convention detection):
- `auth_context` — JWT identity
- `session_id` — conversation thread identifier
- `streaming` — whether SSE is requested

**Return format:**
```python
return {"content": "response text", "role": "assistant"}
# Or for streaming: return async_iterator  (platform wraps in SSE)
```

---

## config.yaml

```yaml
name: my-langgraph-agent
description: LangGraph agent description
framework: langgraph
version: 1.0.0

environment_variables:
  LLM_MODEL: gpt-4o-mini
  # Secrets injected at deploy time — never hardcode here:
  # OPENAI_API_KEY: injected via runtime_secrets_config

  # LiteLLM proxy (optional — route to Bedrock, Azure, Vertex)
  LITELLM_BASE_URL: ""
  LITELLM_API_KEY: ""
  LITELLM_MODEL: ""

  # Memory (auto-injected by platform when enable_memory=true)
  # MEMORY_DB_URI: postgresql://user:pass@host:5432/dbname

  # Opik observability (optional)
  ENABLE_OPIK_TRACING: "false"
  OPIK_PROJECT_NAME: my-langgraph-agent
  OPIK_URL_OVERRIDE: ""
  OPIK_API_KEY: ""
```

---

## Message conversion utility

AgentRuntime passes dicts; LangGraph expects LangChain Message objects:

```python
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, BaseMessage

def to_lc_messages(messages: list) -> list[BaseMessage]:
    result = []
    for m in messages:
        if not isinstance(m, dict):
            result.append(HumanMessage(content=str(m)))
            continue
        role    = m.get("role", "user")
        content = m.get("content", "")
        if role == "user":
            result.append(HumanMessage(content=content))
        elif role == "assistant":
            result.append(AIMessage(content=content))
        elif role == "system":
            result.append(SystemMessage(content=content))
        else:
            result.append(HumanMessage(content=content))
    return result
```

---

## Complete production agent with memory

```python
import os
import logging
from typing import Annotated, TypedDict

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, BaseMessage
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

try:
    from .agent_runtime.runtime import AgentRuntimeApp
except ImportError:
    from agent_runtime.runtime import AgentRuntimeApp

logger = logging.getLogger(__name__)
app = AgentRuntimeApp()

MEMORY_DB_URI  = os.getenv("MEMORY_DB_URI")
LITELLM_BASE   = os.getenv("LITELLM_BASE_URL")
LITELLM_KEY    = os.getenv("LITELLM_API_KEY", "sk-1234")
LITELLM_MODEL  = os.getenv("LITELLM_MODEL")

# ── LLM setup ──────────────────────────────────────────────────────────────
model_name = LITELLM_MODEL or os.getenv("LLM_MODEL", "gpt-4o-mini")
llm_kwargs = {"model": model_name}
if LITELLM_BASE:
    llm_kwargs.update({"base_url": LITELLM_BASE, "api_key": LITELLM_KEY})
llm = ChatOpenAI(**llm_kwargs)

# ── State ──────────────────────────────────────────────────────────────────
class State(TypedDict):
    messages: Annotated[list, add_messages]

# ── Graph ──────────────────────────────────────────────────────────────────
def call_model(state: State) -> dict:
    response = llm.invoke(state["messages"])
    return {"messages": [response]}

builder = StateGraph(State)
builder.add_node("agent", call_model)
builder.set_entry_point("agent")
builder.add_edge("agent", END)

_compiled = None

async def get_graph():
    global _compiled
    if _compiled is not None:
        return _compiled

    if MEMORY_DB_URI:
        # MEMORY_DB_URI is plain postgresql:// — no +asyncpg suffix needed
        saver = AsyncPostgresSaver.from_conn_string(MEMORY_DB_URI)
        checkpointer = await saver.__aenter__()
        # DO NOT call checkpointer.setup() — tables are pre-created by platform.
        # Agent has DML-only privileges; DDL will fail with permission error.
        _compiled = builder.compile(checkpointer=checkpointer)
    else:
        _compiled = builder.compile()
    return _compiled


def to_lc(messages: list) -> list[BaseMessage]:
    result = []
    for m in messages:
        role    = m.get("role", "user") if isinstance(m, dict) else "user"
        content = m.get("content", "") if isinstance(m, dict) else str(m)
        if role == "user":
            result.append(HumanMessage(content=content))
        elif role == "assistant":
            result.append(AIMessage(content=content))
        elif role == "system":
            result.append(SystemMessage(content=content))
        else:
            result.append(HumanMessage(content=content))
    return result


@app.entrypoint
async def invoke(messages: list, auth_context=None, session_id=None, streaming=False):
    graph  = await get_graph()
    lc_msg = to_lc(messages)
    # Use session_id as thread_id for per-conversation checkpointing
    config = {"configurable": {"thread_id": session_id or "default"}}

    if streaming:
        # Return async iterator — platform's EventSerializer wraps it in SSE
        return graph.astream_events({"messages": lc_msg}, config=config, version="v2")

    result = await graph.ainvoke({"messages": lc_msg}, config=config)
    return {"content": result["messages"][-1].content, "role": "assistant"}
```

---

## Lifecycle hooks (startup/shutdown)

Use `on_startup` to initialize connection pools and the compiled graph **once per pod**,
not on every request. This avoids first-request latency and cold-DB pool issues.

```python
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg_pool import AsyncConnectionPool

_pool: AsyncConnectionPool | None = None
_compiled = None


@app.on_startup
async def init():
    global _pool, _compiled
    uri = os.getenv("MEMORY_DB_URI")
    if uri:
        _pool = AsyncConnectionPool(conninfo=uri, open=False)
        await _pool.open()
        checkpointer = AsyncPostgresSaver(_pool)
        # DO NOT call checkpointer.setup()
        _compiled = builder.compile(checkpointer=checkpointer)
    else:
        _compiled = builder.compile()
    logger.info("Graph compiled, pool opened")


@app.on_shutdown
async def cleanup():
    if _pool:
        await _pool.close()
    logger.info("Pool closed")
```

---

## AsyncPostgresSaver — memory and checkpointing

When `enable_memory: true` in the deployment config:
- `MEMORY_DB_URI` is injected as `postgresql://user:pass@host:5432/dbname`
- **Do NOT transform to `postgresql+asyncpg://`** — LangGraph's `AsyncPostgresSaver` uses
  psycopg3 natively and does not need SQLAlchemy dialect prefixes
- Pre-created tables: `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`
- **Never call `checkpointer.setup()`** — agent has DML-only privileges; DDL fails

```python
# CORRECT
saver = AsyncPostgresSaver.from_conn_string(os.getenv("MEMORY_DB_URI"))
checkpointer = await saver.__aenter__()
compiled = builder.compile(checkpointer=checkpointer)

# CORRECT with manual pool
pool = AsyncConnectionPool(conninfo=os.getenv("MEMORY_DB_URI"), open=False)
await pool.open()
checkpointer = AsyncPostgresSaver(pool)
compiled = builder.compile(checkpointer=checkpointer)

# WRONG — will raise permission error
# await checkpointer.setup()

# WRONG — don't modify the URI
# uri = MEMORY_DB_URI.replace("postgresql://", "postgresql+asyncpg://")
```

---

## Mem0 — semantic/long-term memory

Combine with `AsyncPostgresSaver` for episodic + semantic memory:

```python
from mem0 import Memory

# Collection name: "mem0" for 1536-dim, "mem0_{dims}" otherwise
embedding_dims = int(os.getenv("EMBEDDING_MODEL_DIMS", "1024"))
collection_name = "mem0" if embedding_dims == 1536 else f"mem0_{embedding_dims}"

mem0 = Memory.from_config({
    "vector_store": {
        "provider": "pgvector",
        "config": {
            "connection_string": MEMORY_DB_URI,
            "collection_name": collection_name,
        },
    },
    "embedder": {
        "provider": os.getenv("EMBEDDER_PROVIDER", "openai"),
        "config": {"model": os.getenv("EMBEDDER_MODEL", "text-embedding-3-small")},
    },
    "llm": {
        "provider": "openai",
        "config": {"model": os.getenv("LLM_MODEL", "gpt-4o-mini")},
    },
})

# In production — AWS Bedrock embedder (injected by platform):
# "embedder": {
#     "provider": "aws_bedrock",
#     "config": {"model": "amazon.titan-embed-text-v2:0", "embedding_dims": 1024},
# }
# collection_name = "mem0_1024"  (Titan v2 = 1024 dims)

# Retrieve memories before invoking graph:
memories = mem0.search(user_message, filters={"user_id": session_id}, limit=5)

# Store after response:
mem0.add([
    {"role": "user",      "content": user_message},
    {"role": "assistant", "content": response_text},
], user_id=session_id)
```

---

## Streaming patterns

The platform's `EventSerializer` handles all SSE formatting. Return the async iterator
directly — **never** manually format `data: ...\n\n` strings.

```python
@app.entrypoint
async def invoke(messages: list, auth_context=None, session_id=None, streaming=False):
    graph  = await get_graph()
    lc_msg = to_lc(messages)
    config = {"configurable": {"thread_id": session_id or "default"}}

    if not streaming:
        result = await graph.ainvoke({"messages": lc_msg}, config=config)
        return {"content": result["messages"][-1].content, "role": "assistant"}

    # astream_events — all LangGraph events (model tokens, tool calls, etc.)
    return graph.astream_events({"messages": lc_msg}, config=config, version="v2")

    # astream messages — just message chunks (simpler, less verbose)
    # return graph.astream({"messages": lc_msg}, config=config, stream_mode="messages")

    # astream updates — full state after each node
    # return graph.astream({"messages": lc_msg}, config=config, stream_mode="updates")

    # Custom generator for filtering/transforming events:
    # async def filtered():
    #     async for event in graph.astream_events(state, config=config, version="v2"):
    #         if event["event"] == "on_chat_model_stream":
    #             yield {"token": event["data"]["chunk"].content}
    # return filtered()
```

---

## Opik observability

```python
# Option 1: OpikTracer callback
try:
    from opik.integrations.langchain import OpikTracer
    opik_tracer = OpikTracer(
        tags=["langgraph", "production"],
        project_name=os.getenv("OPIK_PROJECT_NAME", "my-langgraph-agent"),
    )
    config = {
        "configurable": {"thread_id": session_id or "default"},
        "callbacks": [opik_tracer],
    }
except ImportError:
    config = {"configurable": {"thread_id": session_id or "default"}}

result = await graph.ainvoke({"messages": lc_msg}, config=config)
```

---

## Tool calling agent (create_react_agent)

For simple tool-calling without a custom graph:

```python
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent

@tool
def calculator(expression: str) -> str:
    """Evaluate mathematical expressions."""
    return str(eval(expression, {"__builtins__": {}}, {}))

@tool
async def web_search(query: str) -> str:
    """Search the web for information."""
    # implement with your search provider
    return f"Results for: {query}"

agent_executor = create_react_agent(llm, tools=[calculator, web_search])

@app.entrypoint
async def invoke(messages: list, auth_context=None, session_id=None, streaming=False):
    lc_msg = to_lc(messages)
    config = {"configurable": {"thread_id": session_id or "default"}}

    if streaming:
        return agent_executor.astream_events({"messages": lc_msg}, config=config, version="v2")

    result = await agent_executor.ainvoke({"messages": lc_msg}, config=config)
    return {"content": result["messages"][-1].content, "role": "assistant"}
```

---

## Conditional routing (auth gating, intent detection)

```python
from langgraph.graph import StateGraph, END, START

class State(TypedDict):
    messages: Annotated[list, add_messages]
    auth_context: dict | None  # store as dict for StateGraph serialization
    route: str

def route_by_role(state: State) -> str:
    auth = state.get("auth_context") or {}
    roles = auth.get("roles", ())
    if "premium" in roles:
        return "premium_node"
    return "basic_node"

graph = StateGraph(State)
graph.add_node("premium_node", premium_handler)
graph.add_node("basic_node",   basic_handler)
graph.add_conditional_edges(START, route_by_role, {
    "premium_node": "premium_node",
    "basic_node":   "basic_node",
})
graph.add_edge("premium_node", END)
graph.add_edge("basic_node",   END)

@app.entrypoint
async def invoke(messages: list, auth_context=None, session_id=None, streaming=False):
    graph = await get_graph()
    # Store auth_context as dict (AuthContext is a frozen dataclass, not directly serializable)
    auth_dict = None
    if auth_context:
        auth_dict = {"user_id": auth_context.user_id, "roles": list(auth_context.roles),
                     "email": auth_context.email, "customer_id": auth_context.customer_id}
    state = {"messages": to_lc(messages), "auth_context": auth_dict}
    config = {"configurable": {"thread_id": session_id or "default"}}
    result = await graph.ainvoke(state, config=config)
    return {"content": result["messages"][-1].content, "role": "assistant"}
```

---

## RAG agent

```python
from langchain_core.vectorstores import VectorStore
from typing import Annotated
from operator import add

class RAGState(TypedDict):
    messages: Annotated[list, add_messages]
    context:  Annotated[list, add]  # accumulate retrieved chunks

def retrieve(state: RAGState) -> dict:
    query = state["messages"][-1].content
    docs  = retriever.invoke(query)
    return {"context": [d.page_content for d in docs]}

def generate(state: RAGState) -> dict:
    context = "\n\n".join(state["context"])
    prompt  = f"Context:\n{context}\n\nQuestion: {state['messages'][-1].content}"
    return {"messages": [llm.invoke([HumanMessage(content=prompt)])]}

rag_graph = StateGraph(RAGState)
rag_graph.add_node("retrieve", retrieve)
rag_graph.add_node("generate", generate)
rag_graph.set_entry_point("retrieve")
rag_graph.add_edge("retrieve", "generate")
rag_graph.add_edge("generate", END)
```

---

## Parallel fan-out / fan-in

```python
from langgraph.graph import StateGraph, END, START

class ParallelState(TypedDict):
    query:   str
    results: Annotated[list, add]  # merge parallel writes

async def search_web(state: ParallelState) -> dict:
    return {"results": [await web_search(state["query"])]}

async def search_db(state: ParallelState) -> dict:
    return {"results": [await db_search(state["query"])]}

def merge(state: ParallelState) -> dict:
    combined = "\n".join(state["results"])
    return {"query": combined}

pg = StateGraph(ParallelState)
pg.add_node("search_web", search_web)
pg.add_node("search_db",  search_db)
pg.add_node("merge",      merge)

pg.add_edge(START, "search_web")
pg.add_edge(START, "search_db")
pg.add_edge("search_web", "merge")
pg.add_edge("search_db",  "merge")
pg.add_edge("merge", END)
```

---

## Subgraph composition

```python
# Inner graph
inner = StateGraph(InnerState)
inner.add_node("step_a", step_a)
inner.add_node("step_b", step_b)
inner.set_entry_point("step_a")
inner.add_edge("step_a", "step_b")
inner.add_edge("step_b", END)
inner_compiled = inner.compile()

# Outer graph uses inner as a single node
outer = StateGraph(OuterState)
outer.add_node("preprocess",     preprocess)
outer.add_node("inner_workflow", inner_compiled)   # subgraph as node
outer.add_node("postprocess",    postprocess)
outer.set_entry_point("preprocess")
outer.add_edge("preprocess",     "inner_workflow")
outer.add_edge("inner_workflow", "postprocess")
outer.add_edge("postprocess",    END)
```

---

## requirements.txt

```
langgraph>=0.2.0
langchain-openai>=0.2.0
langchain-core>=0.3.0
psycopg[binary,pool]>=3.1.0    # AsyncPostgresSaver requires psycopg v3
sse-starlette                   # Required by platform for streaming
opik                            # Optional: observability
mem0ai                          # Optional: semantic memory
```

---

## config.yaml framework values

```yaml
framework: langgraph   # langgraph | crewai | autogen | agno | openai_agents | claude_agents
```

Using the wrong value causes the wrong `main.py.j2` template branch — platform will fail silently.

---

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Calling `checkpointer.setup()` | Tables pre-created; agent has DML-only privileges |
| Using `postgresql+asyncpg://` URI | Keep URI as `postgresql://` — psycopg3 handles async natively |
| Forgetting message conversion | AgentRuntime sends dicts; LangGraph needs `HumanMessage`/etc. |
| Not passing `thread_id` in config | Always include `{"configurable": {"thread_id": ...}}` |
| Returning a coroutine from streaming | Return `astream_events(...)` directly; do not `await` it |
| Pre-formatting SSE strings | Return raw async iterators; platform handles `data: ...\n\n` |
| Missing `sse-starlette` in requirements | Platform needs it even if you don't import it directly |
| Passing `auth_context` object to State | Store as dict — AuthContext dataclass may not serialize |
| Lazy graph compilation on first request | Move to `on_startup` to avoid first-request latency |
| Storing large objects in State | State is checkpointed to DB; keep it lean |

---

## Related skills

- **agentruntime-lifecycle** — package, upload, deploy, invoke, update, scale, teardown
- **agentruntime-notebook** — interactive Jupyter notebooks for lifecycle demos
- See `references/langgraph-reference.md` for platform internals, SSE details, and troubleshooting
