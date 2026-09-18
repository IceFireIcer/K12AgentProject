/**
 * ★ Tool 参数一致性断言（执行文档 §6.3「防静默漂移」、AGENTS §4 契约纪律）。
 *
 *   `check-tool-schema.mjs` —— TypeBox（模型能填什么）⇄ pydantic（契约说什么是合法的）
 *
 * 为什么需要这一条链：Pi Tool 的参数用 **TypeBox `TSchema`** 声明，而契约的唯一来源是
 * **pydantic**（`server/app/contracts.py` → `openapi.json` → `api-types.ts`）。
 * 两边各自演化就会**静默漂移**：pydantic 改了字段名/类型，Tool 还在按老形状收参数，
 * 模型填进来的东西要么被后端拒（学生看到 error），要么被悄悄忽略（更糟）。
 *
 * 做法：**真的 import 主进程里那些导出的 schema 常量**（不复制、不解析文本），
 *       逐个与 `openapi.json` 的同名契约模型（或该端点的参数面）对比。
 *
 * ---------------------------------------------------------------------------
 * 三种对照模式（每个 Tool 按自己的形状选一种）
 * ---------------------------------------------------------------------------
 *   ① `contract: 'XxxRequest'`  —— 有请求体模型：逐字段比类型 / 枚举 / 必填 / 边界（**最严**）。
 *   ② `paramsFrom: {path, method}` —— GET 端点没有请求体模型：比**参数名集合**
 *      （Tool 的 camelCase 归一成 snake 后，与 OpenAPI 里这条操作的 `parameters` 对照）。
 *   ③ `bodyKeysFrom: {...}` —— 端点 `include_in_schema=False`（不进 OpenAPI，如动画渲染）：
 *      从 **Python 路由源码**里抽出它接受的请求体键（`body.get("x")`），
 *      断言 Tool 的每个参数都被端点接受（单向：端点还有别的路径共用，反向是噪声）。
 *
 * ---------------------------------------------------------------------------
 * 对比规则（不是「大致一样就行」，是逐字段的硬比对）
 * ---------------------------------------------------------------------------
 *   共享字段（两边都有）：
 *     - 类型（含枚举取值集合）必须**完全一致**；
 *     - 必填性必须一致；
 *     - 两边都声明的边界（min/max/minLength/maxLength/minItems/maxItems/default）必须一致；
 *       **只有 Tool 侧声明的边界**属于「允许清单」条目（见下），逐条登记、逐条给理由。
 *   只有一边有的字段：必须逐条出现在 {@link ALLOWED_DIFFS} 里，并写明理由。
 *   任何**没有登记**的差异 = 漂移 → 退出码 1。
 *
 * ★★ 「允许清单」不是「把检查放松」：清单是**逐字段**的（字段名 + 差异种类 + 理由），
 *    没有登记的差异一律报错；清单里**已经失效**的条目也会报错（防止清单腐烂成一句空话）。
 *    这是执行文档 §6.3 要求的「TypeBox 与 pydantic 一致性断言」，不是「跳过」。
 *
 * ★ 工具清单（`TOOLS`）的完整性**不再自我比对**：清单从**真实注册表**派生 ——
 *   `AGENT_TOOL_NAMES`（六个扩展实际注册的 10 个 Tool）与 `PAYLOAD_TOOL_NAMES`
 *   （`kindForTool` 表里的 7 个 payload Tool）。新增一个 Tool 但没登记进本脚本 → 退出码 1。
 *
 * 用法：node scripts/check-tool-schema.mjs     （`npm run check:tool-schema`）
 * 退出码：0 = 一致；1 = 有漂移（含清单失效）；2 = 脚本自身出错（读不到文件 / import 失败）。
 *
 * 只用 Node 内置能力（Node >= 22 的类型擦除 + `module.registerHooks`），不引入依赖。
 */

import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
/**
 * 契约生成物的位置。
 *
 * `K12_OPENAPI_PATH` 只用于**验证本脚本不是空转**：拿一份改坏的 openapi 副本跑一遍，
 * 看它是否真的报漂移（见报告里的负向验证）；日常跑法不需要这个变量。
 */
const OPENAPI_PATH = process.env.K12_OPENAPI_PATH
  ? resolve(process.env.K12_OPENAPI_PATH)
  : resolve(ROOT, 'src/shared/openapi.json')

/* ------------------------------------------------------------------ *
 * 0. 退出码约定（与 verify-ui.mjs 一致：0 通过 / 1 断言失败 / 2 脚本出错）
 * ------------------------------------------------------------------ */

function scriptError(message) {
  console.error(`[ERROR] ${message}`)
  process.exit(2)
}

/* ------------------------------------------------------------------ *
 * 1. 允许清单：**逐字段**登记的有意差异（每条都必须有理由）
 * ------------------------------------------------------------------ */

/**
 * 差异种类：
 *   `tool-only`        字段只在 Tool 参数里（模型能填，契约请求体里没有）
 *   `contract-only`    字段只在契约里（Tool 不暴露给模型）
 *   `required-tool`    Tool 侧必填、契约侧可选
 *   `required-contract`契约侧必填、Tool 侧可选
 *   `bounds-tool`      只有 Tool 侧声明了边界（更严的输入约束）
 *   `bounds-contract`  只有契约侧声明了边界
 *   `params-tool-only`     ★ 参数名集合模式：Tool 有这个参数，端点不接受（本地用 / 映射后换个键发）
 *   `params-contract-only` ★ 参数名集合模式：端点接受这个参数，Tool 不暴露（由主进程注入）
 */
const ALLOWED_DIFFS = [
  {
    tool: 'rag_search',
    field: 'gradeLevel',
    kind: 'required-contract',
    reason:
      '学段由系统判定，模型不能决定：契约里 RagSearchRequest.gradeLevel 必填（过滤写在 SQL 层），' +
      '而 Tool 参数里是可选的「复述」字段 —— 主进程注入的会话学段才是真值（extensions/rag-search.ts 头部第 2 条）。'
  },
  {
    tool: 'rag_search',
    field: 'kpId',
    kind: 'tool-only',
    reason: '知识点 id 是模型的检索提示（可选），不是 HTTP 请求体的字段：后端只用 query + gradeLevel。'
  },
  {
    tool: 'rag_search',
    field: 'allowCompat',
    kind: 'contract-only',
    reason: '向上兼容开关由 Python 默认值决定（契约默认 true），不让模型左右跨学段取用策略（§8.4）。'
  },
  {
    tool: 'rag_search',
    field: 'includeExpansion',
    kind: 'contract-only',
    reason: '依赖图扩展同上：由 Python 默认值决定（默认 true），模型填了也没用，索性不暴露。'
  },
  {
    tool: 'rag_search',
    field: 'query',
    kind: 'bounds-tool',
    reason: 'Tool 侧给模型加了 200 字上限（防止整句照抄当检索词）；契约层不限长。'
  },
  {
    tool: 'generate_quiz',
    field: 'gradeLevel',
    kind: 'tool-only',
    reason:
      '★ 学段由系统判定，模型不能设：契约的 QuizPayload 里**根本没有** gradeLevel（出题时学段由会话决定），' +
      'Tool 参数里那个可选字段只是让模型能「复述」当前学段（extensions/quiz.ts 的 resolveGradeLevel 以会话为准）。'
  },
  {
    tool: 'generate_quiz',
    field: 'count',
    kind: 'tool-only',
    reason: '出几道题是给模型的旋钮（1–10），契约的 QuizPayload 里没有它 —— 载荷只带出题结果。'
  },
  {
    tool: 'generate_quiz',
    field: 'kpId',
    kind: 'bounds-tool',
    reason: 'Tool 侧限长 64（知识点 id 的实际长度），契约层不限长。'
  },
  {
    tool: 'generate_quiz',
    field: 'source',
    kind: 'contract-only',
    reason: '题库 / 生成由 Python 与 Extension 判定后填（`source` 是产出字段），不是模型的入参。'
  },
  {
    tool: 'generate_quiz',
    field: 'questions',
    kind: 'contract-only',
    reason: '题目由题库或模型生成后填进载荷；模型不能直接把题目塞进参数（否则可绕过答案防线的投影）。'
  },
  {
    tool: 'generate_variants',
    field: 'gradeLevel',
    kind: 'tool-only',
    reason: '同 generate_quiz：学段真值来自会话，契约载荷里没有这个字段，Tool 参数只作复述。'
  },
  {
    tool: 'generate_variants',
    field: 'count',
    kind: 'tool-only',
    reason: '同 generate_quiz：数量是模型的旋钮，不是载荷字段。'
  },
  {
    tool: 'generate_variants',
    field: 'kpId',
    kind: 'bounds-tool',
    reason: '同 generate_quiz：Tool 侧限长 64。'
  },
  {
    tool: 'generate_variants',
    field: 'source',
    kind: 'contract-only',
    reason: '同 generate_quiz：`source` 是产出字段。'
  },
  {
    tool: 'generate_variants',
    field: 'questions',
    kind: 'contract-only',
    reason: '同 generate_quiz：题目是产出，不是入参。'
  },
  {
    tool: 'submit_quiz',
    field: 'studentId',
    kind: 'contract-only',
    reason:
      '★ 安全边界：学生 id 由主进程注入（`currentAgentSession()`），**绝不允许模型填** —— ' +
      '一旦成为模型参数，就能构造出「批改并写进别人档案」的调用。'
  },
  {
    tool: 'submit_quiz',
    field: 'sessionId',
    kind: 'contract-only',
    reason: '同上：会话 id 由主进程注入，模型不该也不能指定写进哪个会话。'
  },
  {
    tool: 'submit_quiz',
    field: 'qid',
    kind: 'bounds-tool',
    reason: 'Tool 侧限长 64 且非空（题目编号的实际形状），契约层不限长。'
  },
  {
    tool: 'submit_quiz',
    field: 'answer',
    kind: 'bounds-tool',
    reason:
      'Tool 侧规定多空作答每个分支的合理上限（非空字符串 + 最多 8 个空的数组），' +
      '契约层的 answer 只区分 string / string[]（不限长，因为判分只按 qid 查库）。'
  },

  /* ── evaluate_code ⇄ CodeRunRequest（POST /api/code/run-hint，逐字段比对）────── */
  {
    tool: 'evaluate_code',
    field: 'kpId',
    kind: 'bounds-tool',
    reason: '同 generate_quiz 的 kpId：Tool 侧限长 64（知识点 id 的实际长度），契约层不限长。'
  },
  {
    tool: 'evaluate_code',
    field: 'code',
    kind: 'bounds-tool',
    reason: 'Tool 侧规定学生代码的合理上限（非空 + 最多 2 万字符），契约层不限长（后端不猜代码长度）。'
  },
  {
    tool: 'evaluate_code',
    field: 'studentId',
    kind: 'contract-only',
    reason:
      '★ 安全边界（同 submit_quiz）：学生 id 由主进程注入（`currentAgentSession()`），' +
      '**绝不允许模型填** —— 一旦成为模型参数，就能构造出「把运行记录写进别人档案」的调用。'
  },
  {
    tool: 'evaluate_code',
    field: 'stdout',
    kind: 'contract-only',
    reason: '运行结果由渲染进程的 Pyodide Worker 回传（Tool 只把结果转发给 Python），不是模型入参。'
  },
  {
    tool: 'evaluate_code',
    field: 'stderr',
    kind: 'contract-only',
    reason: '同上：traceback 是 Worker 里的真实运行产物，模型编不出来、也不该编。'
  },
  {
    tool: 'evaluate_code',
    field: 'attempt',
    kind: 'contract-only',
    reason: '「同一知识点第几次」由扩展的本地失败计数决定（按学生 + kp 隔离），不让模型左右帮助级别。'
  },

  /* ── GET 端点：参数名集合模式（contracts 里没有请求体模型，对照操作参数面）──── */
  {
    tool: 'get_coding_hint',
    field: 'reason',
    kind: 'params-tool-only',
    reason:
      '学生困难描述只用于扩展内部选提示落点（再决定 `level`），不是端点参数 —— ' +
      '端点只认 `kp_id` + `level`（server/app/routes/code.py 的 get_coding_hint）。'
  },
  {
    tool: 'get_coding_hint',
    field: 'level',
    kind: 'params-contract-only',
    reason:
      '★ 级别由扩展按「该生在该 kp 上已给过的最高级 +1」决定（不跳级），**绝不暴露给模型** —— ' +
      '模型一旦能填就会出现「直接要第 3 级」绕开引导。'
  },
  {
    tool: 'get_student_profile',
    field: 'max_mastery',
    kind: 'params-tool-only',
    reason: '掌握度条目上限是给模型的 Prompt 预算旋钮；端点没有这个查询参数（画像一次返回，由扩展裁剪）。'
  },
  {
    tool: 'get_student_profile',
    field: 'student_id',
    kind: 'params-contract-only',
    reason: '★ 学生 id 是主进程注入的路径参数，模型不能指定读谁的画像（读别人 = 跨学生越权）。'
  },

  /* ── generate_animation：端点不进 OpenAPI，对照 Python 路由接受的请求体键 ──── */
  {
    tool: 'generate_animation',
    field: 'caption',
    kind: 'params-tool-only',
    reason:
      '模型写的一句话讲解在扩展里被映射成 `fallbackText` 发出（produce() 的 ' +
      '`...(input.caption ? { fallbackText: input.caption } : {})`），端点没有 `caption` 这个键。'
  }
]

/* ------------------------------------------------------------------ *
 * 2. 工具清单：导出名 → 契约模型（**一个都不能少**）
 * ------------------------------------------------------------------ */

const TOOLS = [
  {
    tool: 'rag_search',
    exportName: 'RagSearchParams',
    module: 'src/main/agent/extensions/rag-search.ts',
    /** 契约侧对照物：Tool 实际发出去的那个请求体。 */
    contract: 'RagSearchRequest',
    contractNote: 'POST /api/rag/search 的请求体（Tool 真正发出的形状）'
  },
  {
    tool: 'generate_quiz',
    exportName: 'GenerateQuizParams',
    module: 'src/main/agent/extensions/quiz.ts',
    /** 契约侧对照物：Tool 产出并下发给前端的载荷（`kpId` 是两边共用的那个字段）。 */
    contract: 'QuizPayload',
    contractNote: '出题载荷（Tool 的产出形态）'
  },
  {
    tool: 'submit_quiz',
    exportName: 'SubmitQuizParams',
    module: 'src/main/agent/extensions/quiz.ts',
    contract: 'QuizGradeRequest',
    contractNote: 'POST /api/quiz/grade 的请求体（Tool 真正发出的形状）'
  },
  {
    tool: 'generate_variants',
    exportName: 'GenerateVariantsParams',
    module: 'src/main/agent/extensions/quiz.ts',
    contract: 'QuizPayload',
    contractNote: '出题载荷（变式题与出题同一形态）'
  },
  {
    tool: 'get_code_template',
    exportName: 'GetCodeTemplateParams',
    module: 'src/main/agent/extensions/coding.ts',
    /** GET 端点：契约里没有请求体模型，对照物是这条操作的**参数面**。 */
    paramsFrom: {
      path: '/api/code/templates/{kp_id}',
      method: 'get',
      note: 'GET /api/code/templates/{kp_id} 的路径/查询参数（Tool 真正发出的那个请求）'
    }
  },
  {
    tool: 'get_coding_hint',
    exportName: 'GetCodingHintParams',
    module: 'src/main/agent/extensions/coding.ts',
    paramsFrom: {
      path: '/api/code/hint/{kp_id}',
      method: 'get',
      note: 'GET /api/code/hint/{kp_id}?level=… 的参数（级别由扩展算，不由模型填）'
    }
  },
  {
    tool: 'evaluate_code',
    exportName: 'EvaluateCodeParams',
    module: 'src/main/agent/extensions/coding.ts',
    contract: 'CodeRunRequest',
    contractNote: 'POST /api/code/run-hint 的请求体（Tool 真正发出的形状）'
  },
  {
    tool: 'generate_animation',
    exportName: 'GenerateAnimationParams',
    module: 'src/main/agent/extensions/animation.ts',
    /**
     * ★ 该端点 `include_in_schema=False`（`server/app/routes/resources.py` 的
     *   `render_animation_route`）—— 契约里**没有**它的请求体模型，所以第三种模式：
     *   从 Python 路由源码里抽出它接受的键，断言 Tool 的每个参数都被端点接受。
     *   方向是**单向**的：同一个路由还给「自由生成」路径用（那里发 html/payloadId），
     *   反向比对（端点有、Tool 没有）只会得到一堆噪声。
     */
    bodyKeysFrom: {
      file: 'server/app/routes/resources.py',
      functionName: 'render_animation_route',
      note: 'POST /api/animation/render 接受的请求体键（从 Python 路由源码抽出，该端点不进 OpenAPI）'
    }
  },
  {
    tool: 'get_student_profile',
    exportName: 'GetStudentProfileParams',
    module: 'src/main/agent/extensions/profile.ts',
    paramsFrom: {
      path: '/api/profile/{student_id}',
      method: 'get',
      note: 'GET /api/profile/{student_id} 的路径参数（这个 Tool 不发 payload，只影响 Prompt）'
    }
  },
  {
    tool: 'remember_preference',
    exportName: 'RememberPreferenceParams',
    module: 'src/main/agent/extensions/profile.ts',
    contract: 'PreferenceUpdateRequest',
    contractNote: '写学习偏好的请求体（key 是封闭词表，值限长 40 且拒换行）'
  }
]

/**
 * 工具清单的**完整性判据从真实注册表派生**（不再自我引用）。
 *
 * ⚠️ 这里曾经是一份与 `TOOLS` 平行的硬编码数组（`EXPECTED_TOOLS`）—— 两边永远是同一份，
 * 于是「工具清单本身也要完整」那条断言只是在跟自己比，少登记一个 Tool 也发现不了。
 * 现在改从两个**有生产意义**的来源读：
 *   ① `AGENT_TOOL_NAMES`：六个扩展**实际注册**的 10 个 Tool（`extensions/index.ts`）；
 *   ② `PAYLOAD_TOOL_NAMES`：`kindForTool` 表里的 7 个会发 `payload` 事件的 Tool。
 * 少登记任何一个 → 退出码 1（这才是防「清单漏项」的机器判据）。
 */
const REGISTERED_TOOLS_MODULE = 'src/main/agent/extensions/index.ts'
const PAYLOAD_TOOLS_MODULE = 'src/main/ipc/tool-kinds.ts'

/** 逐个字段比对的边界键（`description` / `title` 是散文，不参与比对）。 */
const BOUND_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'default']

/* ------------------------------------------------------------------ *
 * 3. 真 import 那些 schema 常量（借 Node 的类型擦除 + 一个补扩展名/别名的 hook）
 * ------------------------------------------------------------------ */

registerHooks({
  resolve(specifier, context, nextResolve) {
    // `@shared/*` 是 tsconfig / vite 的别名，Node 不认 —— 在这里映射回真实路径
    if (specifier.startsWith('@shared/')) {
      const target = resolve(ROOT, 'src/shared', specifier.slice('@shared/'.length))
      for (const candidate of [`${target}.ts`, target]) {
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
      }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // 主进程源码按 Vite 的口味写相对导入（可能不带扩展名），这里补 `.ts`
      if (specifier.startsWith('.') && context.parentURL) {
        for (const suffix of ['.ts', '/index.ts']) {
          const candidate = new URL(specifier + suffix, context.parentURL)
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
        }
      }
      throw error
    }
  }
})

/** loadSchema(module, exportName)：import 真实模块并取那个导出的常量。 */
async function loadSchema(modulePath, exportName) {
  const absolute = resolve(ROOT, modulePath)
  if (!existsSync(absolute)) scriptError(`找不到模块：${modulePath}（期望在 ${absolute}）`)
  let loaded
  try {
    loaded = await import(pathToFileURL(absolute).href)
  } catch (error) {
    scriptError(`import ${modulePath} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const schema = loaded[exportName]
  if (typeof schema !== 'object' || schema === null) {
    scriptError(`${modulePath} 没有导出可用的 ${exportName}（Tool 参数的 TypeBox schema 必须导出，才能被本脚本断言）`)
  }
  return schema
}

/* ------------------------------------------------------------------ *
 * 4. JSON Schema（TypeBox 与 OpenAPI 都是它的方言）→ 可比的形状
 * ------------------------------------------------------------------ */

/** 类型描述：数组 → `array<inner>`，联合 → `(a|b)`，枚举 → `enum(…)`。 */
function typeOf(schema) {
  if (typeof schema !== 'object' || schema === null) return '?'
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (union) {
    const members = [...new Set(union.map(typeOf))].sort()
    return members.length === 1 ? members[0] : `(${members.join('|')})`
  }
  if (schema.type === 'array') return `array<${typeOf(schema.items)}>`
  if (schema.type === 'integer') return 'integer'
  if (schema.type === 'number') return 'number'
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').pop()
    return `ref<${name}>`
  }
  if (typeof schema.const === 'string') return 'string'
  if (typeof schema.const === 'number') return 'number'
  if (typeof schema.const === 'boolean') return 'boolean'
  if (typeof schema.type === 'string') return schema.type
  return '?'
}

/**
 * 枚举取值集合（认不出返回 `null`）。
 *
 * 覆盖两种写法：`{enum:[…]}`（pydantic/OpenAPI）与 `{anyOf:[{const:…},…]}`（TypeBox 的 Union(Literal)）。
 * **取值集合必须完全一致** —— 这就是「四学段字面量不能各写一份」的机器断言。
 */
function enumValues(schema) {
  if (typeof schema !== 'object' || schema === null) return null
  if (Array.isArray(schema.enum)) return [...schema.enum].map(String).sort()
  const union = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (union && union.every((member) => typeof member === 'object' && member !== null && 'const' in member)) {
    return union.map((member) => String(member.const)).sort()
  }
  return null
}

/** 边界值（只取两边都可能有意义的键）。 */
function boundsOf(schema) {
  const bounds = {}
  for (const key of BOUND_KEYS) {
    if (typeof schema === 'object' && schema !== null && schema[key] !== undefined) bounds[key] = schema[key]
  }
  return bounds
}

const MAX_CHARS = 200
function clip(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > MAX_CHARS ? `${flat.slice(0, MAX_CHARS)}…` : flat
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 联合类型的成员（不是联合就返回 `null`）。 */
function unionMembers(schema) {
  if (typeof schema !== 'object' || schema === null) return null
  if (Array.isArray(schema.anyOf)) return schema.anyOf
  if (Array.isArray(schema.oneOf)) return schema.oneOf
  return null
}

/**
 * 递归比对联合类型**各分支**的边界。
 *
 * 为什么单独做这一层：`answer` 在两边都是 `string | string[]`，字段一级没有边界键，
 * 只看第一层的话「Tool 给数组分支加了 minItems/maxItems」不会被发现。
 * 分支按类型名排序后一一配对（类型本身已在 compareTool 里断言过一致）。
 */
function compareUnionMemberBounds(entry, field, toolSchema, contractSchema, path, depth) {
  if (depth > 2) return
  const toolMembers = unionMembers(toolSchema)
  const contractMembers = unionMembers(contractSchema)
  if (!toolMembers || !contractMembers) return
  if (toolMembers.length !== contractMembers.length) {
    failures.push(`${entry.tool}.${field}：联合类型的分支数量不一致（Tool=${toolMembers.length}，契约=${contractMembers.length}）`)
    console.log(`      ✗ [漂移] ${path}：联合类型的分支数量不一致（Tool=${toolMembers.length}，契约=${contractMembers.length}）`)
    return
  }

  const byType = (a, b) => typeOf(a).localeCompare(typeOf(b))
  const sortedTool = [...toolMembers].sort(byType)
  const sortedContract = [...contractMembers].sort(byType)

  for (let index = 0; index < sortedTool.length; index += 1) {
    const memberPath = `${path}<${typeOf(sortedTool[index])}>`
    const toolBounds = boundsOf(sortedTool[index])
    const contractBounds = boundsOf(sortedContract[index])
    for (const key of [...new Set([...Object.keys(toolBounds), ...Object.keys(contractBounds)])].sort()) {
      const inTool = key in toolBounds
      const inContract = key in contractBounds
      const toolValue = toolBounds[key]
      const contractValue = contractBounds[key]
      if (inTool && inContract) {
        if (!sameJson(toolValue, contractValue)) {
          failures.push(`${entry.tool}.${memberPath}.${key}：边界值不一致（Tool=${toolValue}，契约=${contractValue}）`)
          console.log(`      ✗ [漂移] ${memberPath}.${key}：边界值不一致（Tool=${toolValue}，契约=${contractValue}）`)
        }
        continue
      }
      const kind = inTool ? 'bounds-tool' : 'bounds-contract'
      diff(
        entry.tool,
        field,
        kind,
        `${key} 只有${inTool ? 'Tool' : '契约'}侧声明（${inTool ? toolValue : contractValue}，位于 ${memberPath}）`
      )
    }
    compareUnionMemberBounds(entry, field, sortedTool[index], sortedContract[index], memberPath, depth + 1)
  }
}

/* ------------------------------------------------------------------ *
 * 5. 比对
 * ------------------------------------------------------------------ */

const failures = []
const warnings = []
/** 已被用到的允许清单条目（用来发现「清单腐烂」）。 */
const usedAllowances = new Set()

function allowanceFor(tool, field, kind) {
  const index = ALLOWED_DIFFS.findIndex(
    (entry) => entry.tool === tool && entry.field === field && entry.kind === kind
  )
  if (index === -1) return null
  usedAllowances.add(index)
  return ALLOWED_DIFFS[index]
}

/**
 * 报一个差异：允许清单里登记过就放过（并计数），没登记就是漂移。
 *
 * `detail` 是一句人能读懂的话（报告里直接打印，不要求读者去翻源码）。
 */
function diff(tool, field, kind, detail) {
  const allowed = allowanceFor(tool, field, kind)
  if (allowed) {
    console.log(`      · [已登记] ${field}（${kind}）：${detail}`)
    return
  }
  const line = `${tool}.${field}（${kind}）：${detail}`
  failures.push(line)
  console.log(`      ✗ [漂移] ${line}`)
}

function compareTool(entry, toolSchema, contractSchema) {
  console.log(`\n── ${entry.tool} / ${entry.exportName} ⇄ ${entry.contract}（${entry.contractNote}）`)

  if (toolSchema.type !== 'object' || typeof toolSchema.properties !== 'object' || toolSchema.properties === null) {
    failures.push(`${entry.tool}.${entry.exportName} 不是 TypeBox Object（Tool 参数必须是对象）`)
    console.log('      ✗ [漂移] Tool 参数 schema 不是对象类型')
    return
  }

  const toolProps = toolSchema.properties
  const toolRequired = new Set(Array.isArray(toolSchema.required) ? toolSchema.required : [])
  const contractProps = typeof contractSchema.properties === 'object' && contractSchema.properties !== null ? contractSchema.properties : {}
  const contractRequired = new Set(Array.isArray(contractSchema.required) ? contractSchema.required : [])

  // ① 共享字段：类型 / 枚举 / 必填性 / 边界
  const shared = Object.keys(toolProps).filter((name) => name in contractProps)
  if (shared.length === 0) {
    failures.push(`${entry.tool}：与 ${entry.contract} 没有一个同名字段（大概率是契约改名了）`)
    console.log(`      ✗ [漂移] 与契约模型 ${entry.contract} 没有同名字段`)
  }

  for (const field of shared) {
    const toolField = toolProps[field]
    const contractField = contractProps[field]

    const toolEnum = enumValues(toolField)
    const contractEnum = enumValues(contractField)
    const toolType = typeOf(toolField)
    const contractType = typeOf(contractField)

    if (toolEnum !== null || contractEnum !== null) {
      if (toolEnum === null || contractEnum === null) {
        diff(entry.tool, field, 'enum', `一边是枚举、另一边是自由取值（Tool=${toolEnum ? toolEnum.join('/') : toolType}，契约=${contractEnum ? contractEnum.join('/') : contractType}）`)
      } else if (!sameJson(toolEnum, contractEnum)) {
        diff(entry.tool, field, 'enum', `枚举取值不一致（Tool=${toolEnum.join('/')}，契约=${contractEnum.join('/')}）`)
      } else {
        console.log(`      ✓ ${field}：枚举一致（${toolEnum.join('/')}）`)
      }
    } else if (toolType !== contractType) {
      // `integer` 与 `number` 是不同方言：TypeBox 的 Type.Integer 对应契约的 integer
      failures.push(`${entry.tool}.${field}：类型不一致（Tool=${toolType}，契约=${contractType}）`)
      console.log(`      ✗ [漂移] ${field}：类型不一致（Tool=${toolType}，契约=${contractType}）`)
    } else {
      console.log(`      ✓ ${field}：类型一致（${toolType}）`)
    }

    const toolMust = toolRequired.has(field)
    const contractMust = contractRequired.has(field)
    if (toolMust !== contractMust) {
      const kind = toolMust ? 'required-tool' : 'required-contract'
      diff(entry.tool, field, kind, `必填性不一致（Tool ${toolMust ? '必填' : '可选'} / 契约 ${contractMust ? '必填' : '可选'}）`)
    }

    const toolBounds = boundsOf(toolField)
    const contractBounds = boundsOf(contractField)
    const boundKeys = [...new Set([...Object.keys(toolBounds), ...Object.keys(contractBounds)])].sort()
    for (const key of boundKeys) {
      const inTool = key in toolBounds
      const inContract = key in contractBounds
      if (inTool && inContract) {
        if (!sameJson(toolBounds[key], contractBounds[key])) {
          failures.push(`${entry.tool}.${field}.${key}：边界值不一致（Tool=${toolBounds[key]}，契约=${contractBounds[key]}）`)
          console.log(`      ✗ [漂移] ${field}.${key}：边界值不一致（Tool=${toolBounds[key]}，契约=${contractBounds[key]}）`)
        }
        continue
      }
      const kind = inTool ? 'bounds-tool' : 'bounds-contract'
      diff(entry.tool, field, kind, `${key} 只有${inTool ? 'Tool' : '契约'}侧声明（${inTool ? toolBounds[key] : contractBounds[key]}）`)
    }

    // 联合类型（`answer: string | string[]`）的**每个分支**也要比边界：
    // 只比字段一级的话，「Tool 给数组分支加了 maxItems」这种差异会看不见。
    compareUnionMemberBounds(entry, field, toolField, contractField, field, 0)
  }

  // ② 只有一边有的字段：逐条登记
  for (const field of Object.keys(toolProps)) {
    if (field in contractProps) continue
    diff(entry.tool, field, 'tool-only', `Tool 参数里有、契约模型 ${entry.contract} 里没有`)
  }
  for (const field of Object.keys(contractProps)) {
    if (field in toolProps) continue
    const requiredText = contractRequired.has(field) ? '必填' : '可选'
    diff(entry.tool, field, 'contract-only', `契约模型 ${entry.contract} 里有（${requiredText}）、Tool 参数里没有`)
  }
}

/* ------------------------------------------------------------------ *
 * 5b. 参数名集合模式（GET 端点没有请求体模型；动画端点不进 OpenAPI）
 * ------------------------------------------------------------------ */

/** camelCase → snake_case（Tool 参数是 camelCase，OpenAPI 的 parameters 是 snake_case）。 */
function toSnakeCase(name) {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

/**
 * 从 OpenAPI 的某条操作里取出参数名集合（路径参数 + 查询参数，都归一成 snake_case）。
 *
 * 没有请求体模型的 GET 端点只能用这个判据：契约里不存在一个「请求体模型」可对照，
 * 而「Tool 把参数发到哪里去」这件事必须被机器钉住（否则改个查询参数名没人发现）。
 */
function endpointParamNames(entry) {
  const operation = spec?.paths?.[entry.paramsFrom.path]?.[entry.paramsFrom.method]
  if (operation === undefined) {
    failures.push(`${entry.tool}：openapi.json 里没有 ${entry.paramsFrom.method.toUpperCase()} ${entry.paramsFrom.path}`)
    console.log(`\n── ${entry.tool} / ${entry.exportName} ⇄ ${entry.paramsFrom.note ?? entry.paramsFrom.path}`)
    console.log(`      ✗ [漂移] openapi.json 里没有这条操作（端点改名或没生成？）`)
    return null
  }
  const names = new Set()
  for (const parameter of operation.parameters ?? []) names.add(toSnakeCase(String(parameter.name)))
  return names
}

/** 比对 Tool 参数名集合 ⇄ 端点参数名集合（差异逐条登记，未登记即漂移）。 */
function compareParamNames(entry, toolSchema, endpointNames) {
  console.log(
    `\n── ${entry.tool} / ${entry.exportName} ⇄ ${entry.paramsFrom.method.toUpperCase()} ` +
      `${entry.paramsFrom.path}（${entry.paramsFrom.note ?? '参数名集合比对'}）`
  )
  const toolProps = typeof toolSchema.properties === 'object' && toolSchema.properties !== null ? toolSchema.properties : {}
  const toolNames = new Set(Object.keys(toolProps).map(toSnakeCase))
  if (toolNames.size === 0) {
    failures.push(`${entry.tool}：参数 schema 是空对象（模型没有任何可填的东西，大概率是写错了）`)
    console.log('      ✗ [漂移] Tool 参数 schema 没有任何属性')
    return
  }

  for (const name of toolNames) {
    if (endpointNames.has(name)) {
      console.log(`      ✓ ${name}：端点接受这个参数`)
      continue
    }
    diff(entry.tool, name, 'params-tool-only', `Tool 有、端点 ${entry.paramsFrom.path} 不接受`)
  }
  for (const name of endpointNames) {
    if (toolNames.has(name)) continue
    diff(entry.tool, name, 'params-contract-only', `端点 ${entry.paramsFrom.path} 接受、Tool 没暴露给模型`)
  }
}

/**
 * 从 Python 路由源码里抽出它接受的**请求体键**（`body.get("x")` / `body["x"]`）。
 *
 * 用于 `include_in_schema=False` 的端点（动画渲染）：它不进 OpenAPI，但主进程真的在发请求，
 * 所以「Tool 的参数能不能被端点接受」必须有机器判据 —— 从**路由源码**抽，而不是再写一份清单。
 */
function readBodyKeys(entry) {
  const absolute = resolve(ROOT, '..', entry.bodyKeysFrom.file)
  if (!existsSync(absolute)) {
    failures.push(`${entry.tool}：读不到 ${entry.bodyKeysFrom.file}（端点源码路径变了？）`)
    console.log(`\n── ${entry.tool} / ${entry.exportName} ⇄ ${entry.bodyKeysFrom.note}`)
    console.log(`      ✗ [漂移] 读不到 ${entry.bodyKeysFrom.file}`)
    return null
  }
  const source = readFileSync(absolute, 'utf8')
  const start = source.indexOf(`def ${entry.bodyKeysFrom.functionName}(`)
  if (start < 0) {
    failures.push(`${entry.tool}：${entry.bodyKeysFrom.file} 里找不到 def ${entry.bodyKeysFrom.functionName}(`)
    console.log(`\n── ${entry.tool} / ${entry.exportName} ⇄ ${entry.bodyKeysFrom.note}`)
    console.log(`      ✗ [漂移] 找不到路由函数 ${entry.bodyKeysFrom.functionName}`)
    return null
  }
  // 取到下一个顶层 def / 文件末尾（路由函数体）
  const nextDef = source.indexOf('\ndef ', start + 10)
  const body = source.slice(start, nextDef < 0 ? undefined : nextDef)
  const keys = new Set([
    ...[...body.matchAll(/body\.get\(\s*"([^"]+)"/g)].map((match) => match[1]),
    ...[...body.matchAll(/body\[\s*"([^"]+)"\s*\]/g)].map((match) => match[1])
  ])
  if (keys.size === 0) {
    failures.push(`${entry.tool}：${entry.bodyKeysFrom.functionName} 里没抽出任何请求体键（解析规则失效了？）`)
    console.log(`\n── ${entry.tool} / ${entry.exportName} ⇄ ${entry.bodyKeysFrom.note}`)
    console.log('      ✗ [漂移] 没有抽到任何 body 键 —— 别让它变成一条恒真的空断言')
    return null
  }
  return keys
}

/**
 * 比对 Tool 参数 ⇄ 端点接受的请求体键（**单向**：Tool 的每个参数都必须被端点接受）。
 *
 * 不反向比对的原因：同一个路由还被「自由生成」路径复用（那里发 html / payloadId，
 * 是模型产出的产物而不是工具参数），反向比对会得到一堆永远需要登记的假差异。
 */
function compareBodyKeys(entry, toolSchema, bodyKeys) {
  console.log(`\n── ${entry.tool} / ${entry.exportName} ⇄ ${entry.bodyKeysFrom.note}`)
  const toolProps = typeof toolSchema.properties === 'object' && toolSchema.properties !== null ? toolSchema.properties : {}
  if (Object.keys(toolProps).length === 0) {
    failures.push(`${entry.tool}：参数 schema 是空对象`)
    console.log('      ✗ [漂移] Tool 参数 schema 没有任何属性')
    return
  }
  for (const field of Object.keys(toolProps)) {
    if (bodyKeys.has(field)) {
      console.log(`      ✓ ${field}：端点接受这个请求体键`)
      continue
    }
    diff(entry.tool, field, 'params-tool-only', `Tool 有、端点的请求体里不接受（未在 ${entry.bodyKeysFrom.functionName} 里读到）`)
  }
}

/* ------------------------------------------------------------------ *
 * 6. 主流程
 * ------------------------------------------------------------------ */

if (!existsSync(OPENAPI_PATH)) {
  scriptError(`读不到契约生成物：${OPENAPI_PATH}\n先跑 \`npm run gen:api\`（或确认 server 侧的 OpenAPI 导出成功）。`)
}

let spec
try {
  spec = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'))
} catch (error) {
  scriptError(`openapi.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
}

const schemas = spec?.components?.schemas
if (typeof schemas !== 'object' || schemas === null) {
  scriptError('openapi.json 里没有 components.schemas（契约没生成全）')
}

console.log('Tool 参数（TypeBox）⇄ 契约（pydantic → OpenAPI）一致性断言')
console.log(`契约来源：${OPENAPI_PATH}`)

/**
 * ★ 工具清单本身也要完整：判据从**真实注册表**派生，不再拿同一份硬编码列表跟自己比。
 *
 *   - `AGENT_TOOL_NAMES`：六个扩展实际注册的全部 10 个 Tool（含不发 payload 的三个）；
 *   - `PAYLOAD_TOOL_NAMES`：`kindForTool` 表里的 7 个 payload Tool（少一个前端会收到未知 kind）。
 *
 * 两个来源都会真的 import（不是读文本 grep）：表被改名 / 被删都会在这里报错。
 */
let registeredTools = []
let payloadTools = []
try {
  const indexModule = await import(pathToFileURL(resolve(ROOT, REGISTERED_TOOLS_MODULE)).href)
  registeredTools = [...(indexModule.AGENT_TOOL_NAMES ?? [])]
  const kindsModule = await import(pathToFileURL(resolve(ROOT, PAYLOAD_TOOLS_MODULE)).href)
  payloadTools = [...(kindsModule.PAYLOAD_TOOL_NAMES ?? [])]
} catch (error) {
  scriptError(
    `读注册表失败（${REGISTERED_TOOLS_MODULE} / ${PAYLOAD_TOOLS_MODULE}）：` +
      `${error instanceof Error ? error.message : String(error)}`
  )
}
if (registeredTools.length === 0 || payloadTools.length === 0) {
  scriptError('注册表里没读到任何 Tool 名 —— 别让「清单完整性」变成一条空断言')
}

console.log(
  `Tool 清单来源：${registeredTools.length} 个已注册 Tool（${REGISTERED_TOOLS_MODULE}）、` +
    `${payloadTools.length} 个 payload Tool（${PAYLOAD_TOOLS_MODULE}）`
)

const registered = new Set(TOOLS.map((entry) => entry.tool))
const missingRegistered = registeredTools.filter((name) => !registered.has(name))
if (missingRegistered.length > 0) {
  failures.push(`工具清单缺少（已注册但本脚本未登记）：${missingRegistered.join('、')}`)
  console.log(`\n✗ [漂移] 本脚本没有登记这些**已注册**的 Tool：${missingRegistered.join('、')}`)
  console.log('      （在 TOOLS 里补一条，并选好对照模式：contract / paramsFrom / bodyKeysFrom）')
}
const missingPayload = payloadTools.filter((name) => !registered.has(name))
if (missingPayload.length > 0) {
  failures.push(`工具清单缺少（payload Tool 未登记）：${missingPayload.join('、')}`)
  console.log(`\n✗ [漂移] 会发 payload 事件的 Tool 没被登记：${missingPayload.join('、')}`)
}
/** 反向：登记了但**没有**注册（清单腐烂的另一半 —— 表里留着已经不存在的 Tool）。 */
const staleEntries = registeredTools.length > 0 ? TOOLS.map((entry) => entry.tool).filter((name) => !registeredTools.includes(name)) : []
if (staleEntries.length > 0) {
  failures.push(`工具清单里有已不存在的 Tool（注册表里没有）：${staleEntries.join('、')}`)
  console.log(`\n✗ [漂移] 清单里有注册表里**不存在**的 Tool（请删掉或改名）：${staleEntries.join('、')}`)
}

for (const entry of TOOLS) {
  if (entry.paramsFrom) {
    const endpointNames = endpointParamNames(entry)
    if (endpointNames === null) continue
    compareParamNames(entry, await loadSchema(entry.module, entry.exportName), endpointNames)
    continue
  }
  if (entry.bodyKeysFrom) {
    const bodyKeys = readBodyKeys(entry)
    if (bodyKeys === null) continue
    compareBodyKeys(entry, await loadSchema(entry.module, entry.exportName), bodyKeys)
    continue
  }
  const contractSchema = schemas[entry.contract]
  if (contractSchema === undefined) {
    failures.push(`${entry.tool}：契约里没有模型 ${entry.contract}`)
    console.log(`\n── ${entry.tool} / ${entry.exportName} ⇄ ${entry.contract}`)
    console.log(`      ✗ [漂移] 契约里没有 ${entry.contract}（契约改名或没生成？）`)
    continue
  }
  const toolSchema = await loadSchema(entry.module, entry.exportName)
  compareTool(entry, toolSchema, contractSchema)
}

// 允许清单是否还有效（清单一腐烂，这条断言就名存实亡）
const stale = ALLOWED_DIFFS.filter((_, index) => !usedAllowances.has(index))
if (stale.length > 0) {
  console.log('\n✗ [漂移] 允许清单里有已失效的条目（差异已不存在，请删掉，别让清单变成空话）：')
  for (const entry of stale) {
    failures.push(`允许清单失效：${entry.tool}.${entry.field}（${entry.kind}）`)
    console.log(`      ✗ ${entry.tool}.${entry.field}（${entry.kind}）—— ${clip(entry.reason)}`)
  }
}

console.log(
  `\n已登记的差异：${usedAllowances.size} / ${ALLOWED_DIFFS.length} 条生效` +
    (warnings.length > 0 ? `；提示 ${warnings.length} 条` : '')
)

if (failures.length > 0) {
  console.log(`\n结果：发现 ${failures.length} 处漂移（Tool 参数与契约不一致）——`)
  for (const line of failures) console.log(`  - ${line}`)
  console.log(
    '\n怎么修：改 Tool 的 TypeBox 参数去对齐 pydantic 契约（契约是唯一来源）；' +
      '若差异是**有意**的，就在本脚本的 ALLOWED_DIFFS 里逐条登记并写清理由（不要放宽比对规则）。'
  )
  process.exit(1)
}

console.log(`\n结果：${TOOLS.length} 个 Tool 参数与契约一致（未登记的差异 = 0）`)
process.exit(0)
