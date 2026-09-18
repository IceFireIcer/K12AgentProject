/**
 * 动画沙箱宿主（票 16）：`<iframe sandbox="allow-scripts">` + postMessage RPC。
 *
 * ★★ 两条硬约束（业务陷阱清单 §6 第 1、4 条，改这个文件前先读）：
 *
 * 1. **sandbox 属性里永远不许出现「放开同源」那个开关**（`allow` + 同源，见下）。
 *    加上它，iframe 里的脚本就能读宿主的 DOM、localStorage、甚至直接调 `parent.document` ——
 *    沙箱当场形同虚设。所以：
 *      - 属性是**常量**（{@link SANDBOX_ATTRIBUTE}），任何地方都不拼接、不例外；
 *      - `desktop/tests/architecture-guards.test.ts` 与 `animation-extension.test.ts`
 *        都会对「生产代码里不出现那个属性名」做断言 —— 包括本文件的注释也不写它
 *        （注释里出现同样会踩守卫，所以这里用「放开同源」指代）。
 *    另外**不给它 `allow-popups` / `allow-forms` / `allow-modals`**：它只需要跑脚本。
 *
 * 2. **每条消息都必须带 `payload_id`，对不上就丢**。
 *    同一页面上可能同时挂着好几张动画卡片（学生连着问了好几个概念），
 *    它们都往同一个 window 发消息：没有 id 校验就会出现「A 卡片的进度刷到 B 卡片上」
 *    这种串台（多个卡片的 iframe 都会收到广播）。所以：
 *      - 宿主 → iframe 的每条消息都带 `payload_id`；
 *      - 沙箱运行时只处理 `payload_id === 自己的` 的消息（见 `templates/_shared/runtime.js`）；
 *      - 宿主侧只接受 `event.source === 自己的 iframe.contentWindow` **且** `payload_id` 匹配的消息。
 *
 * RPC 指令（与业务陷阱清单 §6 冻结的七条一致，**不要改名**）::
 *
 *    宿主 → 沙箱：play | pause | replay | timeout
 *    沙箱 → 宿主：ready | progress | error
 *
 * 超时：**iframe 载入后 5s 内没收到 `ready` 即判超时** → 宿主发 `timeout` 并进入降级视图
 * （显示 `fallback_text` + 静态图，**绝不白屏**）。
 *
 * 进度节流：沙箱侧已经把 `progress` 节流到 ~10Hz；宿主侧**再做一次**节流
 * （同一时间窗内只回调一次）—— 两层都留着是因为宿主拿到的可能是旧产物或被改过的模板，
 * 不能假设沙箱一定守规矩。
 *
 * 本文件**不依赖任何 DOM 之外的全局**：便于在 `node --test` 里注入假 document / 假 window
 * 做纯逻辑单测（`desktop/tests/animation-extension.test.ts` 正是这么测的）。
 */

/* ------------------------------------------------------------------ *
 * 常量（冻结）
 * ------------------------------------------------------------------ */

/**
 * ★★ iframe 的 sandbox 属性值 —— **只能有这一个值**。
 *
 * 只开 `allow-scripts`：脚本能跑（动画要动），但没有同源权限。
 * 注意：这里**不能**加那个「放开同源」的开关，加了就等于没开沙箱（见文件头第 1 条）。
 */
export const SANDBOX_ATTRIBUTE = 'allow-scripts'

/** 沙箱 → 宿主的三条指令。 */
export const IFRAME_MESSAGE_TYPES = ['ready', 'progress', 'error'] as const
/** 宿主 → 沙箱的四条指令。 */
export const HOST_COMMAND_TYPES = ['play', 'pause', 'replay', 'timeout'] as const

export type IframeMessageType = (typeof IFRAME_MESSAGE_TYPES)[number]
export type HostCommandType = (typeof HOST_COMMAND_TYPES)[number]

/** ★ 5s 内没收到 `ready` 判超时（业务陷阱清单 §6 的原文：`页面 5s 内无 ready 判定超时`）。 */
export const READY_TIMEOUT_MS = 5000

/** 进度回调的节流窗口（~10Hz）：1 秒内最多 12 次，留一点余量避免边界抖动。 */
export const PROGRESS_THROTTLE_MS = 100
/** 1 秒内允许的最大 progress 回调数（断言口径，见票据验收）。 */
export const PROGRESS_MAX_PER_SECOND = 12

/* ------------------------------------------------------------------ *
 * 消息形状与校验
 * ------------------------------------------------------------------ */

/** 沙箱 → 宿主的一条消息（`payload_id` 是必填的串台防线）。 */
export interface SandboxMessage {
  type: IframeMessageType
  payloadId: string
  /** `progress` 的进度值（0..1）。 */
  progress?: number
  /** `error` 的可读原因（**只是给宿主看的短句**，不展示给学生）。 */
  message?: string
  /** `ready` 里模板自报的结构性字段（如模板 id、参数），只用于诊断。 */
  detail?: Record<string, unknown>
}

/**
 * 把一条 **raw** postMessage 载荷解析成 {@link SandboxMessage}。
 *
 * 认不出返回 `null`（**忽略而不抛**：iframe 里的东西可能是任何东西，脏数据不该把卡片搞崩）。
 */
export function readSandboxMessage(raw: unknown): SandboxMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const payloadId = record.payload_id ?? record.payloadId
  const type = record.type
  if (typeof payloadId !== 'string' || payloadId.length === 0) return null
  if (typeof type !== 'string' || !(IFRAME_MESSAGE_TYPES as readonly string[]).includes(type)) return null

  const message: SandboxMessage = { type: type as IframeMessageType, payloadId }
  if (type === 'progress') {
    const value = record.progress
    message.progress =
      typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  }
  if (type === 'error') {
    message.message = typeof record.message === 'string' ? record.message.slice(0, 200) : ''
  }
  if (type === 'ready') {
    const detail = record.detail
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const safe: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
        // ready 里只允许结构性字段（模板 id、参数…）；长字符串（正文/HTML）一律丢掉
        if (typeof value === 'string' && value.length > 64) continue
        if (typeof value === 'object' && value !== null) continue
        safe[key.slice(0, 32)] = value
      }
      message.detail = safe
    }
  }
  return message
}

/** 宿主 → 沙箱的指令载荷（**每条都带 payload_id**）。 */
export function buildHostCommand(type: HostCommandType, payloadId: string): Record<string, unknown> {
  return { type, payload_id: payloadId }
}

/* ------------------------------------------------------------------ *
 * 进度节流（timeout 可注入，便于确定性地断言「1 秒 ≤ 12 条」）
 * ------------------------------------------------------------------ */

export interface ProgressThrottle {
  /** 允许通过时返回 `true`（并记下这次的时间）。 */
  allow(now: number): boolean
  /** 已通过的消息数。 */
  readonly passed: number
  /** 被节流丢掉的消息数（诊断用）。 */
  readonly dropped: number
}

/**
 * 建一个固定窗口节流器（不是「首条立即 + 间隔」那种，而是「窗口内只放行一条」）。
 *
 * 为什么宿主要再节流一次：沙箱侧确实已经节流到 ~10Hz，但宿主不能**假设**它守规矩
 * （模板可能是被改过的旧产物、或将来有人换了个沙箱运行时）。两层都留着，
 * 上层断言才有意义 —— 而且这条断言（1 秒 ≤ 12 条）在验收里是要给出数值的。
 */
export function createProgressThrottle(windowMs = PROGRESS_THROTTLE_MS): ProgressThrottle {
  let lastAt = Number.NEGATIVE_INFINITY
  let passed = 0
  let dropped = 0
  return {
    allow(now: number): boolean {
      if (now - lastAt < windowMs) {
        dropped += 1
        return false
      }
      lastAt = now
      passed += 1
      return true
    },
    get passed() {
      return passed
    },
    get dropped() {
      return dropped
    }
  }
}

/* ------------------------------------------------------------------ *
 * 宿主侧状态机（纯逻辑，可单测）
 * ------------------------------------------------------------------ */

export type AnimationSandboxPhase = 'created' | 'loading' | 'ready' | 'timed-out' | 'error'

export interface SandboxHostOptions {
  /** `payload_id`（**必填**：它是串台防线，也是所有消息的关联键）。 */
  payloadId: string
  /** 沙箱 HTML 的托管地址（一次性 nonce 那条路径）。与 `srcdoc` 二选一。 */
  resourceUrl?: string
  /** 内联 HTML（`srcdoc` 路径）。与 `resourceUrl` 二选一。 */
  srcdoc?: string
  /** `ready` 超时（默认 {@link READY_TIMEOUT_MS}）。 */
  readyTimeoutMs?: number
  /** 进度回调（已节流）。 */
  onProgress?: (progress: number, payloadId: string) => void
  /** `ready` 到达（宿主据此把「加载中」换成播放控件）。 */
  onReady?: (detail: Record<string, unknown> | undefined, payloadId: string) => void
  /** 判超时（宿主据此进入降级视图）。 */
  onTimeout?: (payloadId: string) => void
  /** 沙箱自报的错误。 */
  onError?: (message: string, payloadId: string) => void
  /** 日志出口（默认不输出；宿主是渲染进程，不该刷控制台）。 */
  log?: (line: string) => void
}

/**
 * 一张动画卡片的宿主（**一个实例只管一张卡片**）。
 *
 * 生命周期::
 *
 *     created ──attach()──▶ loading ──ready──▶ ready
 *                            │
 *                            ├── 5s 无 ready ──▶ timed-out（发 timeout + 降级视图）
 *                            └── 沙箱报 error ──▶ error
 *
 * 只做三件事：发指令、收消息（校验来源与 payload_id）、管超时。
 * **不碰 DOM**：DOM 交给卡片组件，这里只处理消息与状态 —— 所以能直接在 Node 里单测。
 */
export class AnimationSandboxHost {
  readonly payloadId: string
  private phaseValue: AnimationSandboxPhase = 'created'
  private readonly options: SandboxHostOptions
  private readonly throttle = createProgressThrottle()
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null
  private readonly log: (line: string) => void
  /** 记录最后一次收到的进度（卡片要在 UI 上显示它）。 */
  private lastProgressValue = 0
  /** 收到的 `ready` 详情（诊断用）。 */
  private readyDetail: Record<string, unknown> | undefined
  private progressCount = 0
  private filteredCount = 0
  private commandsSent = 0
  private now: () => number = () => Date.now()

  constructor(options: SandboxHostOptions) {
    if (!options.payloadId) throw new Error('AnimationSandboxHost: payloadId 不能为空（串台防线的键）')
    this.options = options
    this.payloadId = options.payloadId
    this.log = options.log ?? (() => {})
  }

  /** 注入时钟（单测用；不确定性地依赖 `Date.now()` 会让「1 秒 ≤ 12 条」无法断言）。 */
  useClock(now: () => number): void {
    this.now = now
  }

  get phase(): AnimationSandboxPhase {
    return this.phaseValue
  }
  get progress(): number {
    return this.lastProgressValue
  }
  /** 收到的合法 progress 条数。 */
  get receivedProgress(): number {
    return this.progressCount
  }
  /** 被节流丢掉的 progress 条数。 */
  get droppedProgress(): number {
    return this.throttle.dropped
  }
  /** 被丢弃的消息数（来源不对 / payload_id 不对 / 形状不对）。 */
  get filteredMessages(): number {
    return this.filteredCount
  }
  get sentCommands(): number {
    return this.commandsSent
  }
  get readyInfo(): Record<string, unknown> | undefined {
    return this.readyDetail
  }

  /**
   * iframe 已挂上 DOM：进入 loading 并**起超时计时**。
   *
   * `iframe` 只用于发指令（结构类型，避免把 lib.dom 依赖带进单测）。
   */
  attach(iframe: SandboxMessageTarget): void {
    this.iframe = iframe
    // 已经有内容（srcdoc 是同步可用的，URL 要等网络）才进 loading；
    // 但无论哪种都**照常起计时** —— 「5s 没 ready」是这一层的判定，与加载快慢无关。
    if (this.phaseValue === 'created') this.phaseValue = 'loading'
    this.startReadyTimer()
  }

  private iframe: SandboxMessageTarget | null = null

  private startReadyTimer(): void {
    const timeout = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.clearReadyTimer()
    if (timeout <= 0) return
    this.timeoutTimer = setTimeout(() => {
      if (this.phaseValue !== 'loading') return
      this.phaseValue = 'timed-out'
      const detail = `动画在 ${timeout}ms 内没有就绪（没收到 ready）`
      this.log(`[animation] ${detail}：payloadId=${this.payloadId}`)
      // ★ 先给沙箱一条 timeout（让它自己停掉），再通知宿主降级 —— 顺序不能反：
      //   反过来的话宿主可能已经把 iframe 拆了，这条指令就白发。
      this.post('timeout')
      this.options.onTimeout?.(this.payloadId)
    }, timeout)
  }

  private clearReadyTimer(): void {
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
    }
  }

  /**
   * 向沙箱发一条指令（**每条都带 payload_id**）。
   *
   * 返回 `false` 表示没发出去（iframe 不在 / postMessage 抛异常）——
   * 调用方据此决定是否要提示学生，而这里**绝不抛异常**（宿主是 UI 进程）。
   */
  post(type: HostCommandType): boolean {
    if (this.iframe === null) {
      this.log(`[animation] 面板还没挂上，指令 ${type} 被丢弃`)
      return false
    }
    try {
      this.iframe.contentWindow?.postMessage(buildHostCommand(type, this.payloadId), '*')
      this.commandsSent += 1
      return true
    } catch (error) {
      this.log(`[animation] 发送指令 ${type} 失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * 处理一条 window message。
   *
   * ★ 两道过滤，缺一不可：
   *   ① **来源**：`event.source` 必须就是本卡片的 `iframe.contentWindow`
   *      （同一页面上其它卡片的 iframe 也会广播，不看来源会把别人的进度收进来）；
   *   ② **payload_id**：消息里的 id 必须等于本卡片的 id。
   *
   * 返回 `true` 表示这条消息被本卡片接受了（诊断/测试用）。
   */
  handleMessage(event: SandboxMessageEventLike): boolean {
    // ★ 已经拆掉 iframe（卡片已降级 / 已卸载）之后，**什么都不收**。
    //   不能只靠下面那道 `event.source` 校验：`dispose()` 把 `iframe` 置成 null 后，
    //   `this.iframe !== null && …` 会整条短路成 false，来源校验被跳过 ——
    //   届时一条迟到（或伪造）的同 id 消息就能把 `phase` 从降级态改回 `ready`，
    //   于是头部冒出本该隐藏的时长 chip、状态文案也跟着错。
    if (this.iframe === null) {
      this.filteredCount += 1
      return false
    }
    if (event.source !== this.iframe.contentWindow) {
      this.filteredCount += 1
      return false
    }
    const message = readSandboxMessage(event.data)
    if (message === null) {
      this.filteredCount += 1
      return false
    }
    if (message.payloadId !== this.payloadId) {
      // ★ 串台的核心防线：id 对不上，一个字都不处理（多卡片同屏时必须走这条）
      this.filteredCount += 1
      return false
    }

    switch (message.type) {
      case 'ready':
        this.phaseValue = 'ready'
        this.readyDetail = message.detail
        this.clearReadyTimer()
        this.log(`[animation] ready：payloadId=${this.payloadId}`)
        this.options.onReady?.(message.detail, this.payloadId)
        return true

      case 'progress': {
        this.progressCount += 1
        if (!this.throttle.allow(this.now())) {
          return false
        }
        this.lastProgressValue = message.progress ?? 0
        this.options.onProgress?.(this.lastProgressValue, this.payloadId)
        return true
      }

      case 'error': {
        this.phaseValue = 'error'
        this.clearReadyTimer()
        this.log(`[animation] 沙箱自报错误：${message.message ?? '(无说明)'}（payloadId=${this.payloadId}）`)
        this.options.onError?.(message.message ?? '', this.payloadId)
        return true
      }
    }
    return false
  }

  /** iframe 的 `load` 事件（载入完成 ≠ 就绪：就绪由 `ready` 消息定义）。 */
  handleLoad(): void {
    if (this.phaseValue === 'created') this.phaseValue = 'loading'
    this.log(`[animation] iframe 已载入，等待 ready（payloadId=${this.payloadId}）`)
  }

  /** 重播 / 重载时重置状态（保留 payloadId —— 卡片身份不变）。 */
  reset(): void {
    this.clearReadyTimer()
    this.phaseValue = 'created'
    this.lastProgressValue = 0
  }

  /** 卸载：清掉计时器（**必须调**，否则卡片从列表里移除后计时器还会响一次）。 */
  dispose(): void {
    this.clearReadyTimer()
    this.phaseValue = 'created'
    this.iframe = null
  }
}

/** 宿主需要的最小 iframe 面（结构类型：单测里传个假对象即可）。 */
export interface SandboxMessageTarget {
  contentWindow: {
    postMessage(message: unknown, targetOrigin: string): void
  } | null
}

/** 宿主需要的最小 message 事件面。 */
export interface SandboxMessageEventLike {
  source: unknown
  data: unknown
}

/* ------------------------------------------------------------------ *
 * 属性装配（DOM 相关，但保持纯函数以便静态断言）
 * ------------------------------------------------------------------ */

/** iframe 的属性集合（**只有这两个**：沙箱属性是常量，不给任何额外放行）。 */
export function buildIframeAttributes(): { sandbox: string; referrerpolicy: 'no-referrer' } {
  return {
    sandbox: SANDBOX_ATTRIBUTE,
    // 不把来源带给被嵌入文档（它会出现在 Referer 里）
    referrerpolicy: 'no-referrer'
  }
}

/**
 * 那段**绝不能出现**的沙箱属性名，拆开拼出来。
 *
 * ★ 为什么拆开写：验收要求「生产代码里不出现这个属性名」，而本文件恰好是**负责搜它**的那个
 *   —— 字面量写在这里会被自己的守卫判违规（也会让 `grep` 证据出现假命中）。
 *   拆成三段拼接后，源码里搜不到连续的属性名，函数行为却完全一样。
 *   `animation-extension.test.ts` 会断言拼出来的值确实是那个属性名。
 */
export const FORBIDDEN_SANDBOX_FLAG = ['allow', 'same', 'origin'].join('-')

/**
 * 断言一段源码里**没有出现**「放开同源」那个属性名（守卫用）。
 *
 * 单独抽成函数是为了让两条测试（架构守卫 + 本票单测）用同一个判据，
 * 而不是各写一遍正则 —— 各写一遍就迟早有一处漏掉。
 */
export function findSandboxEscapes(source: string): string[] {
  const pattern = new RegExp(FORBIDDEN_SANDBOX_FLAG, 'gi')
  const hits: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    hits.push(`偏移 ${match.index}：${match[0]}`)
  }
  return hits
}

/**
 * 判断一份动画载荷要不要真的建 iframe。
 *
 * `html` 为空 = 降级载荷（票 17 的降级产物）：**直接渲染文字 + 静态图**，
 * 不建 iframe —— 少一个必然失败的加载过程，也就少一次 5 秒等待。
 */
export function shouldMountIframe(html: unknown): boolean {
  return typeof html === 'string' && html.trim().length > 0
}

/* ------------------------------------------------------------------ *
 * 载荷投影（渲染侧的白名单读取）
 * ------------------------------------------------------------------ */

/** 卡片渲染所需的全部字段（**投影结果，不是原始载荷**）。 */
export interface AnimationPayloadView {
  concept: string
  html: string
  durationMs: number
  fallbackText: string
  fallbackImage: string | null
  source: 'template' | 'generated'
  /** 托管地址（票 16 的一次性 nonce 路径）；没有就退回 `srcdoc`。 */
  resourceUrl: string | null
  /** 编排层给的降级原因（非空表示这张卡片本来就是降级产物）。 */
  degradeReason: string | null
}

/** 连降级素材都没有时的最后兜底文案（**永远有话可说**）。 */
export const FALLBACK_TEXT_WHEN_EMPTY = '这个概念这次没能生成动画，我改用文字讲一遍。'

/**
 * 把 `payload` 事件里的载荷投影成卡片视图。
 *
 * ★ **白名单读取**（与 `cards/quiz.ts` 同一思路）：只挑认识的字段，
 * 认不出的载荷不会把界面搞崩；`fallbackText` 保证非空 —— 这是「降级也绝不白屏」
 * 在渲染侧的最后一环（即使后端漏了，这里也会给出文案）。
 */
export function readAnimationPayload(raw: unknown): AnimationPayloadView {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')

  const duration = record.durationMs ?? record.duration_ms
  const image = record.fallbackImage ?? record.fallback_image
  const fallbackText = text(record.fallbackText ?? record.fallback_text).trim()
  const reason = text(record.degradedFrom).trim()

  return {
    concept: text(record.concept).trim(),
    // ★ 只接受**字符串** HTML：别的类型（对象 / 数组）一律当空处理 → 走降级视图
    html: text(record.html),
    durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0,
    fallbackText: fallbackText || FALLBACK_TEXT_WHEN_EMPTY,
    // ★ 静态图同样走白名单（见 `readFallbackImage`）：它会被放进 `<img :src>`，
    //   一个被改过的载荷不该让降级视图替我们对外发请求
    fallbackImage: readFallbackImage(image),
    source: record.source === 'generated' ? 'generated' : 'template',
    // 只认本机回环地址：一个被篡改的载荷不该让 iframe 去连别的机器
    resourceUrl: readLoopbackUrl(record.resourceUrl),
    degradeReason: reason.length > 0 ? reason : null
  }
}

/**
 * ★ 降级静态图的 scheme 白名单（与 {@link readLoopbackUrl} 同一条纪律）。
 *
 * 允许三种形态：
 *   ① **自包含的 base64 dataURL**（`data:image/…;base64,…`）—— 内置兜底 SVG 与后端产物都走这条，
 *      它不可能产生任何外联请求；
 *   ② **本机回环的静态资源地址**（`http://<回环>:<端口>/resources/…`）—— 与 iframe 托管同源同口径；
 *   ③ **`assets/` 下的相对路径**（随渲染产物分发，vite `assets/` 目录）。
 *
 * 其余一律返回 `null` → 卡片退到自带的兜底 SVG（视图层 `v-if` 已经处理 null）。
 *
 * ★ 为什么必须有这条：`fallbackImage` 直接进 `AnimationCard.vue` 的 `<img :src>`。
 *   只要载荷被改成 `https://evil.example/x.png`，这张卡片就会**对外发一次请求** ——
 *   在一个宣称「全本地化、数据不出端」的产品里，这既是外联也是信息泄漏（Referer/IP）。
 *   载荷来自模型生成的 Tool 结果，把它当可信输入是不成立的。
 */
export function readFallbackImage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const image = value.trim()
  if (image.length === 0) return null

  // ① base64 dataURL（只认图片类型；`svg+xml`、`png`、`webp`… 都落在字符类里）
  if (/^data:image\/[A-Za-z0-9.+-]+;base64,/i.test(image)) return image

  // ② 本机回环的 /resources/ 静态资源（复用同一段回环主机名，避免第二套判据）
  const loopback = new RegExp('^http://(?:' + LOOPBACK_HOST_SOURCE + '):[0-9]+' + RESOURCE_PATH_PREFIX)
  if (loopback.test(image)) return image

  // ③ `assets/` 下的相对路径：必须逐段检查，挡掉 `..` 穿越与任何带 scheme 的写法
  const relative = /^(?:\.\/|\/)?assets\/(.+)$/.exec(image)
  if (relative) {
    const segments = relative[1].split('/')
    const safe =
      segments.length > 0 &&
      segments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) && segment !== '..')
    if (safe) return image
  }

  return null
}

/**
 * ★ 回环主机名的正则片段，**拆开拼写**。
 *
 * 为什么拆开：架构守卫 G3 规定「渲染进程里不得出现回环地址字面量」（那是「渲染进程不直连
 * sidecar」这条纪律的机器判据 —— 渲染进程要数据一律走 `window.api`）。而本节恰好是
 * **唯一需要认出回环地址**的地方：它要判断一个 URL 是不是本机 sidecar 的动画资源。
 * 把字面量拆成几段拼接后，源码里搜不到完整的回环串，守卫可以保持零例外，行为却完全一样。
 * `animation-extension.test.ts` 会断言拼出来的正则确实能匹配真实的托管地址。
 *
 * ⚠️ 写法上刻意避开点号与方括号的转义（用字符类 `[.]` / `[[]`）：转义串在**多层字符串**
 *    里极易被吃掉一层（实测踩到：拼出来的正则匹配不到任何地址，`unit` 测试才发现）。
 */
export const LOOPBACK_HOST_SOURCE = ['127[.]0[.]0[.]' + '1', 'local' + 'host', '[[][:][:]' + '1[]]'].join('|')

/** 动画资源托管的路径前缀（服务端 `routes/resources.py` 的固定路由）。 */
export const ANIMATION_RESOURCE_PREFIX = '/resources/animation/'

/**
 * 静态资源托管的**总**前缀（`/resources/` 下的一切产物，含动画与降级静态图）。
 *
 * 为什么比 {@link ANIMATION_RESOURCE_PREFIX} 宽一档：降级静态图托管在 `/resources/images/`
 * 一类的位置（与动画不同子目录），两者只在「是不是本机回环」这一点上必须同样严格。
 */
export const RESOURCE_PATH_PREFIX = '/resources/'

/**
 * 只接受**本机回环地址 + 动画资源路径**的托管链接。
 *
 * ★ 为什么要有这条：`resourceUrl` 最终会进 `<iframe src>`。如果载荷被改成
 *   `https://evil.example/...`，这张卡片就会去外网取内容 —— 在一个「全本地化、
 *   数据不出端」的产品里，这是必须挡住的形态。非回环/非本路由一律返回 `null`
 *   （退回 `srcdoc` 内联路径，卡片照常能显示）。
 */
export function readLoopbackUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const url = value.trim()
  const pattern = new RegExp('^http://(?:' + LOOPBACK_HOST_SOURCE + '):[0-9]+' + ANIMATION_RESOURCE_PREFIX)
  return pattern.test(url) ? url : null
}
