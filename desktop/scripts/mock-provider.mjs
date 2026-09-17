/**
 * ★ 本地假 provider（**零外网、零真实 Key**）：用于在不花钱、不联网的前提下证明
 * 三条 **key-gated** 路径在真实回合里被走到。
 *
 * 它实现 OpenAI Chat Completions 的最小契约（流式 SSE），并按关键词返回可控内容：
 *
 * | 提示里出现 | 这个假模型回什么 |
 * | --- | --- |
 * | `__SAFE__` | 一段合规回答 |
 * | `__VIOLATE__` | 一段**命中词表**的回答（`色情`）→ 生成侧终审应当撤回它 |
 * | `__QUIZ__`/`__ANIM__` | 带 tool_calls 的回合，驱动 Tool 调用（可选） |
 * | `__JUDGE__`（自审/判学段的内部调用） | 一句判违规的 JSON |
 *
 * 用法：
 *   node scripts/mock-provider.mjs            # 监听 127.0.0.1:8791
 *   然后让应用把 baseUrl 指向 http://127.0.0.1:8791 并给一把**假 Key**。
 *
 * ⚠️ 这不是产品代码：只在验收脚本里用，绝不进打包产物（不在 `src/` 下）。
 */

import { createServer } from 'node:http'

const PORT = Number(process.env.K12_MOCK_PORT ?? 8791)

/** 从 messages 里拼出「用户说了什么」（用于按关键词分支）。 */
function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    const content = message.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const text = content.map((part) => (part && typeof part === 'object' ? part.text : '')).join('')
      if (text) return text
    }
  }
  return ''
}

/** 系统提示里是否含某段（用于区分「自审」与「判学段」这类内部调用）。 */
function systemText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const system = messages.find((message) => message?.role === 'system')
  return typeof system?.content === 'string' ? system.content : ''
}

/**
 * 从自审 prompt 里取出**待审核的回复**（`<<<REPLY … REPLY>>>` 之间的正文）。
 *
 * ★ 这一步必须做对，否则假模型会「因为规则清单里写着『色情』就把一切判违规」——
 * 规则清单是 prompt 的一部分（`guard.build_self_review_prompt` 会列出六类情形），
 * 真实 LLM 绝不会把它当成待审内容。不做这个切分，本 mock 就会把所有回答都判违规。
 */
function replyUnderReview(prompt) {
  const match = /<<<REPLY\s*([\s\S]*?)\s*REPLY>>>/.exec(prompt)
  return match ? match[1] : ''
}

/** 这一轮该回什么（纯函数，便于核对）。 */
export function replyFor(body) {
  const user = lastUserText(body)
  const system = systemText(body)
  // 内部判定调用**不带 systemPrompt**（`createModelCompleter` 只在显式传入时才带），
  // 所以判据是「prompt 原文」：两个内部 prompt 的首句都是固定且唯一的
  // （`guard.build_self_review_prompt` / `grade.buildJudgePrompt`）。
  const haystack = `${system}\n${user}`

  // ① 内容安全 LLM 自审（票 22 的第二道过滤）
  if (haystack.includes('内容安全审核员')) {
    // ★ 只审 `<<<REPLY>>>` 里的那段，不看规则清单
    const reply = replyUnderReview(user)
    return reply.includes('色情') || reply.includes('__VIOLATE__')
      ? '{"violation": true, "category": "adult", "reason": "本地假模型判定：待审回复命中成人内容"}'
      : '{"violation": false, "category": "none", "reason": "安全"}'
  }

  // ② 学段第二层的 LLM 判定（票 21）—— 判据是它独有的首句
  if (haystack.includes('分级助手')) {
    return '{"suggestedGrade": "junior", "confidence": 0.8, "note": "本地假模型的判定"}'
  }

  // ③ 正常回合：按学生那句话里的关键词分支
  if (user.includes('__VIOLATE__')) {
    return '这是一段包含色情内容的回答（本地假 provider 产出，用于验证生成侧终审会撤回它）。'
  }
  if (user.includes('__LONG__')) {
    return '神经网络由很多小单元组成。'.repeat(12)
  }
  return '这是本地假 provider 的合规回答：神经网络由很多小层组成，每层做一点点计算。'
}

function sseChunks(text) {
  // OpenAI 流式：逐字分块（让前端的 delta 累积路径真的被走到）
  const chunks = []
  const step = Math.max(1, Math.ceil(text.length / 8))
  for (let index = 0; index < text.length; index += step) {
    const piece = text.slice(index, index + step)
    chunks.push({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }]
    })
  }
  chunks.push({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  })
  return chunks
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404).end('{}')
    return
  }
  // ★ 记录**到达网络的头名**（只记头名与是否存在，不记任何值）：
  //   这是「provider 边界到底看到了什么」的地面真值，用于核对 `before_provider_headers`
  //   实际拿到的那份头集合。
  const names = Object.keys(req.headers).sort().join(', ')
  process.stderr.write(`[mock-provider] headers=[${names}]\n`)
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw)
    } catch {
      // 忽略：按空 body 处理
    }
    const text = replyFor(body)
    const wantsStream = body?.stream === true
    process.stderr.write(`[mock-provider] ${req.url} stream=${wantsStream} reply=${JSON.stringify(text.slice(0, 40))}\n`)

    if (!wantsStream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        })
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    for (const chunk of sseChunks(text)) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[mock-provider] 已监听 127.0.0.1:${PORT}（零外网、零真实 Key）\n`)
})
