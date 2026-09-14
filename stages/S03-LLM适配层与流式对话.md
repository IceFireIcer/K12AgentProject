# Stage 03 · LLM 适配层 + 流式对话

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D3** |
| 关卡 | ✅ **关卡 B：能与大模型流式对话** |
| 前置 | S02 |
| 状态 | ⬜ 未开始 |

---

## 1. 目标

打通「用户输入 → OpenAI 兼容 API → 逐 token 流回前端渲染」的完整链路。**这一关通过后，项目就"活"了**，后面所有功能都是往这条链路上挂。

---

## 2. 任务清单

- [ ] `app/llm/provider.py`：`ChatOpenAI(base_url=..., api_key=..., model=...)` 工厂
  - [ ] 支持任意 OpenAI 兼容供应商（DeepSeek 默认）
  - [ ] 超时 / 重试配置
  - [ ] 连接失败 → `error.degraded=true`，不抛到前端裸 500
- [ ] `POST /api/chat/stream`：接收 `{studentId, grade, message}` → 返回 SSE
- [ ] token 流 → `event: delta`
- [ ] 结束时 → `event: done`（带 messageId）
- [ ] 前端对话界面（`views/Chat.vue`）：对话气泡 + Markdown 渲染 + 逐字追加
- [ ] 前端 Pinia store：`stores/chat.ts` 管理消息列表与流式状态
- [ ] 停止生成 / 重发 / 复制

---

## 3. 关键代码要点

```python
# app/llm/provider.py
from langchain_openai import ChatOpenAI

def build_llm(cfg: LlmConfig) -> ChatOpenAI:
    return ChatOpenAI(
        base_url=cfg.base_url,
        api_key=cfg.api_key,
        model=cfg.model_id,
        streaming=True,
        timeout=60,
        max_retries=2,
    )
```

```python
# SSE 生成器骨架
async def event_stream():
    try:
        async for chunk in llm.astream(messages):
            if chunk.content:
                yield sse("delta", {"requestId": rid, "delta": chunk.content})
        yield sse("done", {"requestId": rid, "messageId": mid})
    except Exception as e:
        yield sse("error", {"requestId": rid, "message": str(e), "degraded": True})
```

---

## 4. 验收标准（DoD / 关卡 B）

- [ ] 设置页填好 DeepSeek 配置后，问一个问题，前端**逐字**出现回答
- [ ] **中文无乱码**
- [ ] 故意填错 API Key → 前端显示优雅错误提示，不崩、不白屏
- [ ] 长回答过程中点「停止」能真的中断
- [ ] 拔网线 → 显示降级提示

---

## 5. 陷阱与注意

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | 中文乱码 | 显式 UTF-8；SSE 响应头 `charset=utf-8`。 |
| 2 | 流式缓冲 | FastAPI 需 `StreamingResponse`，且**禁用中间件缓冲**（如 GZip）。 |
| 3 | 异常裸抛 | 流中途报错不能直接 500（响应头已发出），必须用 `event: error` 收尾。 |
| 4 | 前端渲染卡顿 | 逐 token `setState` 会掉帧；按帧/批量合并更新。 |
| 5 | 供应商差异 | 部分兼容 API 不支持 `stream_options`，注意容错。 |

---

## 6. 产出记录

| 项 | 结果 |
| --- | --- |
| 首 token 延迟 | （待填） |
| 实测供应商/模型 | （待填） |
| 关卡 B 通过时间 | （待填） |
