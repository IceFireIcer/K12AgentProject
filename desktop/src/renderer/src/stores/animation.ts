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
  type AnimationTemplatesView,
  type DataBridge
} from '../api/data'
// ★ 面向学生的失败文案只有一处实现（HTTP 状态码 / 服务器路径 / 内部 kp_id 都要翻掉）
import { describeClientError, toStudentFacingMessage } from '../api/student-facing'

/** 供 `AnimationSandboxHost` 使用的托管结果（含防串台标识）。 */
export interface HostedAnimation {
  payloadId: string
  url: string
  expiresInMs: number
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
   * 按模板渲染。
   *
   * ★ 渲染失败是**预期内**的（模板校验不过 / 没有匹配的模板），
   *   所以错误文案要能直接显示给学生看（后端给的是可读中文 + 具体原因）。
   * ★ 渲染成功后清掉上一次的托管结果：那个 nonce 已经不该再用了。
   */
  async function render(
    input: { templateId?: string; kpId?: string; gradeLevel?: GradeLevel } = {}
  ): Promise<void> {
    const templateId = input.templateId ?? activeTemplateId.value
    if (!templateId && !input.kpId) {
      // ★ 这句会**原样显示给学生**（`Animation.vue` 的错误态直接渲染 `renderError`）：
      //   说清下一步做什么，不要写成写给我们自己的断言（旧句「没有可渲染的模板」）。
      renderError.value = '还没有挑动画 —— 先从下面的动画里选一个吧。'
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
    try {
      const result = await lookup.bridge.renderAnimation({
        ...(templateId ? { templateId } : {}),
        ...(input.kpId ? { kpId: input.kpId } : {}),
        ...(input.gradeLevel ? { gradeLevel: input.gradeLevel } : {})
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
      hostError.value = '这段动画这次放不出来 —— 换一段，或者先去对话里问问智团团。'
      return null
    }
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return null
    }
    const id = payloadId ?? newPayloadId()
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
    selectTemplate
  }
})

/** 生成一个防串台标识（`crypto.randomUUID` 优先，缺失时退到时间戳 + 随机数）。 */
export function newPayloadId(): string {
  const cryptoRef = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID()
  return `anim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
