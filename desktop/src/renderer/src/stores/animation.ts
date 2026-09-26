/**
 * 动画（Pinia）：模板库 → 渲染 → 一次性 nonce 托管。
 *
 * 三步链路（每一步都是后端的一个端点，**这里不做任何生成**）：
 *   ① `GET  /api/animation/templates`  列出 8 份真模板（含参数定义）；
 *   ② `POST /api/animation/render`     按模板渲染成**自包含**的沙箱 HTML；
 *   ③ `POST /api/animation/host/…`     把 HTML 托管成一个**一次性 nonce 地址**，
 *      交给 `sandbox/iframe-host.ts` 的 `AnimationSandboxHost` 挂进沙箱 iframe。
 *
 * ★★ 为什么第 ③ 步必须存在（而不是直接把 HTML 塞进 iframe 的 `srcdoc`）：
 *   iframe 带不了自定义 header，所以资源地址不能用 token 鉴权；
 *   而做成「无鉴权的公开路由」等于让任何人都能取到学生的动画内容。
 *   一次性 nonce 绑定「学生 + 知识点 + 有效期」、用一次即失效 —— 这是那条约束的解。
 *
 * ★ 断网可用：模板与动画库都随包分发（HTML 里内联，无 CDN 引用），
 *   所以断网演示时这一步照常工作，唯一的失败点是**模板没匹配上**（那时走降级文案）。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { GradeLevel } from '@shared/ipc-events'
import {
  resolveDataBridge,
  type AnimationHostView,
  type AnimationPayloadView,
  type AnimationSavedItemView,
  type AnimationSavedListView,
  type AnimationSavedView,
  type AnimationTemplatesView,
  type DataBridge
} from '../api/data'
// ★ 面向学生的失败文案只有一处实现（HTTP 状态码 / 服务器路径 / 内部 kp_id 都要翻掉）
import { describeClientError, toStudentFacingMessage } from '../api/student-facing'
import { GRADE_LABELS } from '../labels'

/** 供 `AnimationSandboxHost` 使用的托管结果（含防串台标识）。 */
export interface HostedAnimation {
  payloadId: string
  url: string
  expiresInMs: number
}

/** 动画讲解页的两个分页（注册表在页面 `views/Animation.vue`，当前页在这里）。 */
export type AnimationTab = 'builtin' | 'mine'

/**
 * 一条**可以交给沙箱播**的库产物（`html` + 它自己那把 `payloadId`）。
 *
 * ★★ `payloadId` 为什么必须从 HTML 里取回来：沙箱 HTML 是**成品**，
 * `window.__K12_PAYLOAD_ID__` 在当初拼装时就烘焙进去了（`server/app/animation/compose.py`），
 * 卡片按**自己手里那个 id** 校验每条 postMessage。如果播库里那份时另造一个 id，
 * 沙箱回的每条消息都会被当成别人的 → 永远等不到 ready → 5 秒后必然降级
 * （学生看到的是「加载不出来」，而库里那份明明是好的）。
 * 同一条判据有两个调用方：这里（「我的动画」回放）与动画讲解页的舞台 —— 后者的
 * `renderPayloadId` 是**请求发出前**就写下的，拿它配上一次的 HTML 会错配（见 D-080 / D-084）。
 * 主进程 `agent/extensions/animation.ts` 的 `readSavedPayloadId` 是同一判据的另一份实现
 * （那边给 Tool 用）；渲染进程这一份是必要重复 —— 缺了它，页面上的「我的动画」全播不出来。
 */
export interface SavedAnimationPlayable {
  /** 库里那条的元信息（标题 / 学段 / 概念，界面按它显示）。 */
  item: AnimationSavedItemView
  /** 直接喂给沙箱的那份 HTML。 */
  html: string
  /** 产物里烘焙的那把串台防线 id（取不回来时是空串 → 调用方宁可重新生成）。 */
  payloadId: string
  /** 打包成载荷形状（`readAnimationPayload` 的白名单字段 + `payloadId`）。 */
  payload: Record<string, unknown>
}

/** 从沙箱 HTML 里取回**烘焙在产物里**的 `payload_id`（认不出返回 `null`）。 */
export function readBakedPayloadId(html: string): string | null {
  const matched = /window\.__K12_PAYLOAD_ID__\s*=\s*"([^"]*)"/.exec(html)
  const candidate = matched?.[1] ?? ''
  return /^[A-Za-z0-9_-]{1,64}$/.test(candidate) ? candidate : null
}

/**
 * 从载荷里读**实际生效的学段**（主进程注入的那个）。
 *
 * ★ 认不出就返回 `null`（**不猜**）：猜测的后果是卡片标错年级、以及「按当前学段重画」
 *   在不该出现的时候冒出来。真值只有一条链（服务端推断 → 主进程透传），
 *   前端只是读它，不算它。
 */
export function readPayloadGrade(payload: unknown): GradeLevel | null {
  const raw = (payload && typeof payload === 'object' ? payload : {}) as { gradeLevel?: unknown }
  const value = typeof raw.gradeLevel === 'string' ? raw.gradeLevel : ''
  return value in GRADE_LABELS ? (value as GradeLevel) : null
}

/* ------------------------------------------------------------------ *
 * 「在线生成」那条消息的两半（**学生看的 / 模型读的**）
 *
 * ★★ 为什么要分两半（与 `cards/coding.ts` 同一纪律）：发给模型的那段里带着做法上的要求
 *   （「重新做一份、不要复用上次那份」），而学生气泡里该显示的是**他自己那句话的意思**。
 *   两半由 `stores/chat.ts` 的 `send(显示文本, wire 文本)` 分开承载。
 *
 * ★★ 这里**刻意不写任何工具名与内部说法**（`compose_animation` / `kpId` / 端点之类）：
 *   wire 文本会**原样落进会话记录**，而历史回看那条路只对「编程 / 练习」两类消息做了译文
 *   （`chat.ts` 的 `studentFacingUserText`）。往里塞工具名，学生回看时就会读到一句
 *   写给模型的内部指令。用自然语言说清「重新做一份」，模型凭 System Prompt 里的工具清单
 *   照样会调对工具，而这几句话在任何界面上读起来都是一句正常的请求。
 *
 * ⚠️ 文案里**不许出现** `**` 与反引号（学生看到的是字面星号），也不许用 `——` 连接句子
 *   （`student-view-discipline.test.ts` 的两条守卫都扫这些字符串）。
 * ------------------------------------------------------------------ */

/** 「在线生成」时**学生气泡里**显示的那一句。 */
export function animationRequestDisplayText(): string {
  return '用动画再讲一遍这个概念吧。'
}

/** 「按当前学段重画」时学生气泡里显示的那一句。 */
export function animationRedrawDisplayText(): string {
  return '用我现在这个年级能听懂的说法，再讲一遍这个概念吧。'
}

/**
 * 「在线生成」**发给模型**的那段（wire）。
 *
 * `redraw` 为 true 时是「按当前学段重画」那条路：把「按我现在这个年级讲」说出来。
 */
export function animationRequestWireText(
  concept: string,
  gradeLevel: GradeLevel | null,
  redraw = false
): string {
  const name = concept.trim() || '这个概念'
  const gradeName = gradeLevel ? GRADE_LABELS[gradeLevel] : ''
  const gradeLine = redraw && gradeName ? `按${gradeName}讲` : '再讲一遍'
  return (
    `我想再看一张「${name}」的动画卡片，${gradeLine}。\n` +
    '（这是学生点「在线生成」发起的：请重新做一份动画，不要直接复用之前做过的那一份，' +
    '做好后卡片上下发即可；不要自己写 HTML，也不要把动画里的解说词念一遍。）'
  )
}

/**
 * 「在线生成」的两条腿（**顺序不能反**）。
 *
 * ★★ 为什么对话优先：动画是模型的 Tool 做出来的，走一轮对话意味着这件事**在上下文里**
 *   （学生接着能问「刚才那个再慢一点」），而直连那条路做出来的卡片不进对话历史。
 *   只有当这一轮**根本开不起来**（没有配置模型 / 发送失败）才退到直连 —— 那时聊也聊不了。
 * ★ 两条腿的产物**都不在这里落库**：对话那条由 Tool 自己存，直连那条由主进程存
 *   （见 `IPC.animationCompose` 的说明）。这里只编排「先试哪条、失败怎么办」。
 * ★ 依赖是**注入**的（`startTurn` / `compose`）：这条决策值得单测，而它一旦绑死
 *   `useChatStore` 就只能靠组件挂载才能验（本仓 `node --test` 里没有 Vue 运行时）。
 */
export interface NewAnimationDeps {
  /** 开一轮对话（返回 `false` = 这一轮没开起来）。 */
  startTurn: () => Promise<boolean>
  /** 直连生成（兜底）；失败返回 `null`。 */
  compose: () => Promise<Record<string, unknown> | null>
  /** 两条都不行时给学生看的那句（默认见下）。 */
  failureMessage?: string
}

/** 「在线生成」的结论：走了对话 / 直连拿到新产物 / 两条都没成。 */
export type NewAnimationOutcome =
  | { kind: 'conversation' }
  | { kind: 'composed'; payload: Record<string, unknown> }
  | { kind: 'failed'; message: string }

/** 两条路都不行时的兜底话术（**永远有话可说**，且不指向任何技术细节）。 */
export const NEW_ANIMATION_FAILED_TEXT = '新的动画这次没做出来，先看这一段就好。'

export async function requestNewAnimation(deps: NewAnimationDeps): Promise<NewAnimationOutcome> {
  let started = false
  try {
    started = await deps.startTurn()
  } catch {
    // 发送本身抛了（IPC 断了这类）：按「这一轮没开起来」处理，走下面那条兜底
    started = false
  }
  if (started) return { kind: 'conversation' }

  let payload: Record<string, unknown> | null = null
  try {
    payload = await deps.compose()
  } catch {
    payload = null
  }
  if (payload !== null) return { kind: 'composed', payload }
  return { kind: 'failed', message: deps.failureMessage ?? NEW_ANIMATION_FAILED_TEXT }
}

export const useAnimationStore = defineStore('animation', () => {
  const templates = ref<AnimationTemplatesView | null>(null)
  const templatesLoading = ref(false)
  const templatesError = ref<string | null>(null)

  /** 当前选中的模板 id（空串 = 还没选）。 */
  const activeTemplateId = ref('')
  const payload = ref<AnimationPayloadView | null>(null)
  const rendering = ref(false)
  const renderError = ref<string | null>(null)

  const hosted = ref<HostedAnimation | null>(null)
  const hosting = ref(false)
  const hostError = ref<string | null>(null)

  const bridgeError = ref<string | null>(null)
  /**
   * 非响应式：**同一请求键**的并发取模板清单只发一次（键 = `kpId` + `gradeLevel`）。
   *
   * ★★ 去重必须看请求键：旧写法 `if (templatesInFlight) return await templatesInFlight`
   *   会在学生连点两个不同知识点时把**第二个请求静默丢掉** —— 而 `templates`
   *   还是上一个知识点的那一份（舞台上播的与所选知识点对不上）。
   *   键相同才复用，键不同就并发发新的，且**只让最后一次写结果**。
   *   对照组是 `stores/study.ts` 的 `chaptersInFlight === gradeLevel`。
   */
  let templatesInFlight: { key: string; promise: Promise<void> } | null = null
  /** 取模板清单的请求序号（只让最后一次发出的请求写结果）。 */
  let templatesRequestSeq = 0

  /** 模板清单（`available` 是全部可用 id，`matched` 是与本次查询匹配上的）。 */
  const matched = computed(() => templates.value?.matched ?? [])
  const availableIds = computed(() => templates.value?.available ?? [])
  /** 当前选中的模板定义（渲染参数用它）。 */
  const activeTemplate = computed(
    () => matched.value.find((item) => item.id === activeTemplateId.value) ?? null
  )
  /** 是否已经有一份可以交给沙箱的托管结果。 */
  const canPlay = computed(() => hosted.value !== null)

  /** 列模板（可按知识点 / 学段过滤）。 */
  async function loadTemplates(
    input: { kpId?: string; gradeLevel?: GradeLevel } = {},
    force = false
  ): Promise<void> {
    const key = `${input.kpId ?? ''}#${input.gradeLevel ?? ''}`
    // 键相同 → 复用那次在途请求；键不同 → 往下走，**并发发新的**（不静默丢掉）
    if (templatesInFlight !== null && templatesInFlight.key === key) {
      return await templatesInFlight.promise
    }
    if (templates.value !== null && !force && !input.kpId && !input.gradeLevel) return
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    bridgeError.value = null
    templatesLoading.value = true
    templatesError.value = null
    const request = fetchTemplates(input, lookup.bridge)
    templatesInFlight = { key, promise: request }
    try {
      await request
    } finally {
      // 只有仍然登记在案的那次负责收尾（被更新的一次顶掉的请求不该关掉新请求的加载态）
      if (templatesInFlight !== null && templatesInFlight.promise === request) {
        templatesInFlight = null
        templatesLoading.value = false
      }
    }
  }

  /**
   * 发一次取模板清单的请求（拆出来是为了有一个**绝不同步抛**的边界）。
   *
   * ★ 只有**最后一次**发出的请求能写结果（迟到的旧响应不许把新知识点的清单盖回去）。
   * ★ 失败也过翻译：后端 detail 里带着服务器上的模板目录
   *   （`本机没有可用的动画模板（server/resources/templates/ 为空）`）。
   */
  async function fetchTemplates(
    input: { kpId?: string; gradeLevel?: GradeLevel },
    bridge: DataBridge
  ): Promise<void> {
    const seq = (templatesRequestSeq += 1)
    const isLatest = (): boolean => seq === templatesRequestSeq
    try {
      const result = await bridge.readAnimationTemplates(input)
      if (!isLatest()) return
      if (result.ok) {
        templates.value = result.data as AnimationTemplatesView
        // 默认选中第一个匹配上的（学生进来就该看到东西，而不是空白舞台）
        if (!activeTemplateId.value && matched.value.length > 0) {
          activeTemplateId.value = matched.value[0]!.id
        }
      } else {
        templatesError.value = toStudentFacingMessage(result.message, { topic: 'animation' })
      }
    } catch (thrown) {
      if (!isLatest()) return
      templatesError.value = describeClientError(thrown, { topic: 'animation' })
    }
  }

  /**
   * 当前渲染产物对应的 `payload_id`（渲染与托管**共用**这一个值）。
   *
   * ★★ 2026-09-23 实测缺陷：动画讲解页的动画**全部**降级成文字，
   *   `data-degrade-reason` 全是「沙箱在 5 秒内没有就绪」。抓包看沙箱其实发了
   *   `ready(payload_id="preview")`，而宿主等的是自己新造的 UUID —— 两边对不上，
   *   每条消息都被宿主当别人的丢掉，于是永远等不到 ready。
   *   两个 id 的来源：产物里那个由**渲染**决定（不传时服务端落 `"preview"`，
   *   见 `server/app/routes/resources.py`），宿主那个由**托管**决定。
   *   ⇒ 一次生成、两处回传；主进程工具路径早就是这么做的
   *   （`agent/extensions/animation.ts` 的「卡片手里的那个 payload_id」注释）。
   */
  const renderPayloadId = ref('')

  /**
   * 按模板渲染。
   *
   * ★ 渲染失败是**预期内**的（模板校验不过 / 没有匹配的模板），
   *   所以错误文案要能直接显示给学生看（后端给的是可读中文 + 具体原因）。
   * ★ 渲染成功后清掉上一次的托管结果：那个 nonce 已经不该再用了。
   */  async function render(
    input: { templateId?: string; kpId?: string; gradeLevel?: GradeLevel } = {},
    explicitPayloadId?: string
  ): Promise<void> {
    const templateId = input.templateId ?? activeTemplateId.value
    if (!templateId && !input.kpId) {
      // ★ 这句会**原样显示给学生**（`Animation.vue` 的错误态直接渲染 `renderError`）：
      //   说清下一步做什么，不要写成写给我们自己的断言（旧句「没有可渲染的模板」）。
      renderError.value = '还没有挑动画，先从下面的动画里选一个吧。'
      return
    }
    if (templateId) activeTemplateId.value = templateId
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    rendering.value = true
    renderError.value = null
    hosted.value = null
    hostError.value = null
    // ★ 与随后托管共用的那一个 id（默认新造；显式传入是为了「同一 id 贯穿两步」的调用方/测试）。
    const payloadId = explicitPayloadId || newPayloadId()
    renderPayloadId.value = payloadId
    try {
      const result = await lookup.bridge.renderAnimation({
        ...(templateId ? { templateId } : {}),
        ...(input.kpId ? { kpId: input.kpId } : {}),
        ...(input.gradeLevel ? { gradeLevel: input.gradeLevel } : {}),
        payloadId
      })
      if (result.ok) payload.value = result.data as AnimationPayloadView
      else {
        // ★ 渲染失败是**预期内**的（模板校验不过 / 没有匹配的模板），文案要能直接给学生看：
        //   后端给的是可读中文，但 404/503 那几条会带上服务器上的模板目录，过一遍翻译。
        renderError.value = toStudentFacingMessage(result.message, { topic: 'animation' })
        payload.value = null
      }
    } catch (thrown) {
      renderError.value = describeClientError(thrown, { topic: 'animation' })
    } finally {
      rendering.value = false
    }
  }

  /**
   * 把渲染好的 HTML 托管成一次性地址。
   *
   * ★ `payloadId` 由这里生成并**原样回传**：沙箱的 `postMessage` 靠它防多卡串台
   *   （页面上可能同时有多张动画卡，消息必须能对上是哪一张的）。
   * ★ 生成方式用 `crypto.randomUUID()`（浏览器内建，无依赖）；
   *   降级到「时间戳 + 随机数」是为了兼容极老的运行时 —— 它只用于防串台，**不是凭据**。
   */
  async function host(payloadId?: string): Promise<HostedAnimation | null> {
    const current = payload.value
    if (current === null) {
      hostError.value = '这段动画还没准备好，先点一次播放吧。'
      return null
    }
    const kpId = activeTemplate.value?.kpIds?.[0] ?? ''
    if (!kpId) {
      // 「按学生托管」「没有关联的知识点」是**实现侧口径**（会原样显示给学生）：
      // 学生的处境是「这段动画这次放不出来」，不是「nonce 绑不上 kp_id」。
      hostError.value = '这段动画这次放不出来。换一段，或者先去对话里问问智团团。'
      return null
    }
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return null
    }
    // ★★ 默认用**渲染时烙进产物的那一个 id**（见 `renderPayloadId`）。
    //   不这么做的后果不是「重试一次」，而是**必然降级**：产物里是别的 id，
    //   沙箱回的 `ready` 永远被宿主过滤 → 5 秒超时 → 整段动画变成文字。
    //   显式传入只允许用于「你同时也把同一个 id 传给了渲染」的场景（调用方/测试）。
    const id = payloadId || renderPayloadId.value || newPayloadId()
    hosting.value = true
    hostError.value = null
    try {
      const result = await lookup.bridge.hostAnimation({ kpId, html: current.html, payloadId: id })
      if (!result.ok) {
        hostError.value = toStudentFacingMessage(result.message, { topic: 'animation' })
        return null
      }
      const data = result.data as AnimationHostView
      const next: HostedAnimation = {
        payloadId: data.payloadId,
        url: data.url,
        expiresInMs: data.expiresInMs
      }
      hosted.value = next
      return next
    } catch (thrown) {
      hostError.value = describeClientError(thrown, { topic: 'animation' })
      return null
    } finally {
      hosting.value = false
    }
  }

  /** 渲染 + 托管（一步到位；失败时保留可读原因，界面按原因给不同的兜底）。 */
  async function renderAndHost(
    input: { templateId?: string; kpId?: string; gradeLevel?: GradeLevel } = {}
  ): Promise<void> {
    await render(input)
    if (payload.value !== null) await host()
  }

  function selectTemplate(id: string): void {
    activeTemplateId.value = id
    // 换模板就作废上一份渲染 / 托管结果（否则舞台上播的还是上一个模板的动画）
    payload.value = null
    hosted.value = null
    renderError.value = null
    hostError.value = null
  }

  /* ================================================================== *
   * 学生动画库（「我的动画」）：清单 / 取一条 / 删一条 / 按需现做
   *
   * ★★ 三条纪律（与 Tool 那侧同口径）：
   *   ① **学生身份不在这里**：请求里没有任何 studentId 字段，主进程自己解析
   *      （渲染进程能指定身份 = 能读别人做过的动画）；
   *   ② **学段是复用键的一维**：同一个知识点在不同学段是两份不同的产物，
   *      所以清单按学段分开存（跨年级预览就是换一档再查一次）；
   *   ③ **失败只说学生话**：后端那些面向排障的 detail 一律过 `toStudentFacingMessage`。
   * ================================================================== */

  /**
   * 已取回的清单，**按查询条件分片**存。
   *
   * ★★ 为什么要分片（而不是一个 `savedItems` + 一个 filter）：两个消费方要的清单**不是同一份** ——
   *   对话里的动画卡片按**那张卡片的学段**对齐库里有没有做过，而「我的动画」页按**当前（或预览）学段**
   *   列出来。共用一份的话，后查的那次会把前一个的清单顶掉，表现是「卡片上的『我的』时有时无」。
   *   分片之后每个条件各存一份，谁也不盖谁。
   */
  const savedByKey = ref<Record<string, AnimationSavedItemView[]>>({})
  const savedLoading = ref(false)
  const savedError = ref<string | null>(null)
  /** 最近一次清单查询的条件（页面上的「我的动画」按它显示来源学段与筛选状态）。 */
  const savedQuery = ref<{ gradeLevel: GradeLevel | null; kpId: string }>({ gradeLevel: null, kpId: '' })
  /** 清单里一共几条（服务端口径）。 */
  const savedTotal = ref(0)
  /** 每个条件各自的在途请求（同条件复用，不同条件并发、各写各的分片）。 */
  const savedInFlight = new Map<string, Promise<void>>()

  /** 分片的键（学段 + 知识点；两者都空 = 「全都要」）。 */
  function savedKeyOf(input: { gradeLevel?: GradeLevel | null; kpId?: string }): string {
    return `${input.gradeLevel ?? ''}#${input.kpId ?? ''}`
  }

  /** 某个条件下已取回的清单（没查过是空数组 —— 界面据此说「还没有」而不是说「查不到」）。 */
  function savedFor(input: { gradeLevel?: GradeLevel | null; kpId?: string } = {}): AnimationSavedItemView[] {
    return savedByKey.value[savedKeyOf(input)] ?? []
  }

  /** 最近一次查询的结果（「我的动画」页用它）。 */
  const savedItems = computed(() => savedFor(savedQuery.value))

  /**
   * 取某一档学段的清单（按请求键去重）。
   *
   * ★ 学段省略 = 不过滤（服务端回全部；回显的 `gradeLevel` 为 null 表示没过滤）。
   * ★ 失败**不抛**：留下可读原因并把该分片清空 —— 界面显示「还没有」而不是一屏空白。
   */
  async function loadSaved(
    input: { gradeLevel?: GradeLevel | null; kpId?: string } = {},
    force = false
  ): Promise<void> {
    const query = { gradeLevel: input.gradeLevel ?? null, kpId: input.kpId ?? '' }
    const key = savedKeyOf(query)
    savedQuery.value = query
    if (!force && savedByKey.value[key] !== undefined) return
    const inFlight = savedInFlight.get(key)
    if (inFlight !== undefined) return await inFlight

    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    const request = (async (): Promise<void> => {
      savedLoading.value = true
      try {
        const result = await lookup.bridge.readSavedAnimations({
          ...(query.gradeLevel ? { gradeLevel: query.gradeLevel } : {}),
          ...(query.kpId ? { kpId: query.kpId } : {})
        })
        if (result.ok) {
          const data = result.data as AnimationSavedListView
          savedByKey.value = { ...savedByKey.value, [key]: data.items ?? [] }
          savedTotal.value = data.total ?? (data.items ?? []).length
          savedError.value = null
        } else {
          savedByKey.value = { ...savedByKey.value, [key]: [] }
          savedError.value = toStudentFacingMessage(result.message, { topic: 'animation' })
        }
      } catch (thrown) {
        savedByKey.value = { ...savedByKey.value, [key]: [] }
        savedError.value = describeClientError(thrown, { topic: 'animation' })
      } finally {
        savedInFlight.delete(key)
        // 别的条件的请求可能还在飞 → 只在没有在途请求时收加载态
        if (savedInFlight.size === 0) savedLoading.value = false
      }
    })()
    savedInFlight.set(key, request)
    await request
  }

  /**
   * 取库里一条（**带 HTML**）→ 打包成能直接喂给沙箱的载荷。
   *
   * ★ 取不到时返回 `null` 并留下可读原因；**绝不抛**（它在卡片的点击处理器里被 await）。
   * ★ 产物里的 `payload_id` 取不回来时**同样返回 `null`**（宁可让调用方重新生成，
   *   也不发一张永远收不到 ready 的卡片 —— 那条路的表现是「5 秒后降级」）。
   */
  async function readSavedAnimation(savedId: string): Promise<SavedAnimationPlayable | null> {
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return null
    }
    try {
      const result = await lookup.bridge.readSavedAnimation({ savedId })
      if (!result.ok) {
        savedError.value = toStudentFacingMessage(result.message, { topic: 'animation' })
        return null
      }
      const view = result.data as AnimationSavedView
      const html = typeof view.html === 'string' ? view.html : ''
      const payloadId = readBakedPayloadId(html)
      if (html.trim().length === 0 || payloadId === null) {
        // 记录在、文件没了（后端 404 之外的可能）或 id 取不回来：都不给一张播不出来的卡片
        savedError.value = '这条动画这次打不开，换一条试试。'
        return null
      }
      return {
        item: view,
        html,
        payloadId,
        payload: {
          concept: view.concept,
          html,
          durationMs: view.durationMs,
          fallbackText: view.fallbackText,
          fallbackImage: view.fallbackImage ?? null,
          // ★ 存进库里的都是**做出来的**那一种（内置模板直取不入库）：标成即时生成，
          //   否则卡片会把一份做出来的动画标成「内置模板」（那是对学生撒谎）。
          source: 'generated',
          payloadId,
          gradeLevel: view.gradeLevel
        }
      }
    } catch (thrown) {
      savedError.value = describeClientError(thrown, { topic: 'animation' })
      return null
    }
  }

  /**
   * 删一条（**确认由调用方负责** —— 这里只发请求）。
   *
   * ★ 成功后就地把它从各分片里摘掉（**不重取**也能立刻看见），再让当前条件重取一次
   *   （后端才是权威：它连磁盘上的 HTML 一起删了）。重取失败只影响清单的新鲜度，
   *   删除本身已经成功 —— 所以返回值只反映删除。
   */
  async function deleteSaved(savedId: string): Promise<{ ok: boolean; message?: string }> {
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return { ok: false, message: lookup.message }
    }
    try {
      const result = await lookup.bridge.deleteSavedAnimation({ savedId })
      if (!result.ok) {
        return { ok: false, message: toStudentFacingMessage(result.message, { topic: 'animation' }) }
      }
      const next: Record<string, AnimationSavedItemView[]> = {}
      for (const [key, items] of Object.entries(savedByKey.value)) {
        next[key] = items.filter((item) => item.id !== savedId)
      }
      savedByKey.value = next
      savedTotal.value = Math.max(0, savedTotal.value - 1)
      await loadSaved(savedQuery.value, true)
      return { ok: true }
    } catch (thrown) {
      return { ok: false, message: describeClientError(thrown, { topic: 'animation' }) }
    }
  }

  /** 「按需现做」进行中（卡片上的按钮据此显示「正在做」并禁用）。 */
  const composing = ref(false)
  /** 「按需现做」失败的可读原因（`null` = 这次没失败）。 */
  const composeError = ref<string | null>(null)

  /**
   * ★★ **按需现做一份动画**（不走对话那条路）。
   *
   * 它是「在线生成」的**兜底**：正常情况下这句话走一轮对话（模型调做动画的工具），
   * 只有当那一轮根本开不起来时，才由主进程自己把动画做出来。
   * 主进程做完会**自动存库**，所以这里不再调保存。
   *
   * 返回打包好的载荷（可以直接重挂卡片播它），失败返回 `null` 并留下可读原因。
   */
  async function composeNow(input: {
    kpId?: string
    gradeLevel?: GradeLevel | null
    concept: string
    request: string
    caption?: string
  }): Promise<Record<string, unknown> | null> {
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return null
    }
    composeError.value = null
    composing.value = true
    try {
      const result = await lookup.bridge.composeAnimation({
        ...(input.kpId ? { kpId: input.kpId } : {}),
        ...(input.gradeLevel ? { gradeLevel: input.gradeLevel } : {}),
        ...(input.caption ? { caption: input.caption } : {}),
        concept: input.concept,
        request: input.request
      })
      if (!result.ok) {
        composeError.value = toStudentFacingMessage(result.message, { topic: 'animation' })
        return null
      }
      const data = result.data as Record<string, unknown>
      // ★ 学段等渲染侧附加字段由主进程回传（`gradeLevel` / `payloadId`），这里原样转交；
      //   但产物里**必须**有一份能播的 HTML，否则不给卡片（那是白屏的成因）。
      if (typeof data.html !== 'string' || data.html.trim().length === 0) {
        composeError.value = '新的动画这次没做出来，先看现在这段就好。'
        return null
      }
      return data
    } catch (thrown) {
      composeError.value = describeClientError(thrown, { topic: 'animation' })
      return null
    } finally {
      composing.value = false
    }
  }

  /** 清掉「按需现做」的上一条失败原因（下一次点按钮时调）。 */
  function clearComposeError(): void {
    composeError.value = null
  }

  /* ================================================================== *
   * 动画讲解页的两个分页（内置模板 / 我的动画）
   *
   * ★ 分页状态放 store 而不是组件本地：动画讲解页在 `App.vue` 的 `<KeepAlive>` 里，
   *   切到别的页再回来时组件被复用 —— 状态留在组件里也能活，但**跨页跳转**
   *   （例如以后从别处带着「去我的动画」的意图进来）需要它能被外部设置。
   *   与学习档案页的 `ui.studyTab` 同一条分工：分页注册表在页面、当前页在那一个 store。
   * ================================================================== */

  /** 当前分页（`builtin` = 内置模板，`mine` = 我的动画）。 */
  const activeTab = ref<AnimationTab>('builtin')

  function setTab(tab: AnimationTab): void {
    activeTab.value = tab
  }

  return {
    templates,
    templatesLoading,
    templatesError,
    matched,
    availableIds,
    activeTemplateId,
    activeTemplate,
    payload,
    rendering,
    renderError,
    hosted,
    hosting,
    hostError,
    canPlay,
    bridgeError,
    loadTemplates,
    render,
    host,
    renderAndHost,
    selectTemplate,
    /* ── 学生动画库（「我的动画」）────────────────────────────────────────── */
    savedItems,
    savedQuery,
    savedTotal,
    savedLoading,
    savedError,
    savedFor,
    loadSaved,
    readSavedAnimation,
    deleteSaved,
    /* ── 按需现做（「在线生成」的兜底）────────────────────────────────────── */
    composing,
    composeError,
    clearComposeError,
    composeNow,
    /* ── 分页（内置模板 / 我的动画）───────────────────────────────────────── */
    activeTab,
    setTab
  }
})

/** 生成一个防串台标识（`crypto.randomUUID` 优先，缺失时退到时间戳 + 随机数）。 */
export function newPayloadId(): string {
  const cryptoRef = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID()
  return `anim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
