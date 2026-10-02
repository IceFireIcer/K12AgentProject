/**
 * 演示沙箱（预置数据）：渲染进程这一半 —— 开关状态 + 三轮脚本的**本机回放**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 分工（跨进程）
 * ══════════════════════════════════════════════════════════════════════════
 *   主进程：学生态的真值（画像 / 掌握度 / 闯关进度 / 会话 / 动画库 …）与三轮脚本、
 *           以及「现在是不是沙箱态」这个开关本身（见 `@shared/demo-seed`）；
 *   渲染进程（本文件）：那颗按钮的状态，以及**脚本在本机的事件回放**。
 *
 * ★★ 回放为什么在渲染进程而不是主进程：脚本要驱的是**对话状态机**
 *   （`stores/chat.ts` 的 `applyChatEvent`）。从主进程推真事件的话，它就变成
 *   「第 7 种事件来源」，每个消费方都得重新判断「这条是真的还是脚本」——
 *   而这里走的是**同一条折叠路径**（`chat.pushScriptedEvent`），
 *   卡片 / 引用 / 正文 / 收尾与真实轮次逐字同形。
 *
 * ★★ 三条纪律（守卫会红）：
 *   ① 脚本内容**一个字节都不写进渲染进程**：预置载荷里带着 `kpId` 这类内部标识，
 *      源码级守卫会扫到 —— 全部由主进程 `demo:script` 下发（见 `@shared/demo-seed`）；
 *   ② 本 store **绝不抛异常到界面**：桥缺失 / 回执失败都只写一句可读中文，
 *      技术原因走 `warnWiring`（接线人才需要看，见 `api/wiring-notice.ts`）；
 *   ③ 退出沙箱后**迟到的回执不许改状态**（见下面的 `epoch`）。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
/**
 * ⚠️ 这里用**相对路径**而不是渲染进程惯用的 `@shared/demo-seed` 别名。
 *
 * 判据是「谁会被 Node 直接加载」：本文件被 `stores/chat.ts` **静态** import，
 * 而一批单测（`session-switch` / `session-boot` / `opening-guidance` / `ui-shell` …）
 * 直接 import `chat.ts`。那些测试的解析钩子只认「相对且没写扩展名的导入」——
 * `@shared/*` 是 vite/tsconfig 的别名，Node 不认，值导入会让它们当场找不到模块。
 * （`src/preload/index.ts` 里 import `../shared/demo-seed` 用的是同一条路径写法。）
 * ★ 只把**类型**写成 `@shared/...` 是不行的：`DEMO_BLOCKED_MESSAGE` 与
 *   `isDemoScriptPayload` 都是运行期要用的值。
 */
import {
  DEMO_BLOCKED_MESSAGE,
  isDemoScriptPayload,
  type DemoScriptPayload,
  type DemoScriptTurn,
  type DemoSeedCard,
  type DemoSeedState
} from '../../../shared/demo-seed'
import {
  DIAGNOSTICS_TURN_LIMIT,
  type RuntimeSpan,
  type TurnDiagnostics
} from '../../../shared/diagnostics'
import { useDiagnosticsStore } from './diagnostics'
import type { K12Api } from '../../../preload/index'
import { warnWiring } from '../api/wiring-notice'
import { useChatStore } from './chat'

/**
 * 脚本轮次的 `requestId` 前缀（**模块级常量，不要内联**）。
 *
 * ★★ 它必须与真实轮次的 `turn_` 前缀**不同**：任何按 `requestId` 认领轮次的逻辑
 *    （悬浮追问窗、条目 id 的补齐）都不该认领一条脚本轮次 ——
 *    与历史回看用 `restored-` 前缀是同一个理由（见 `api/events.ts` 的 `restoredTurn`）。
 */
const DEMO_REQUEST_PREFIX = 'script-'

/** 逐字回放的速度：每 18ms 一个字（150~200 字的正文 ≈ 3s，落在 3–5 秒的口径里）。 */
const DEMO_DELTA_INTERVAL_MS = 18

/**
 * 演示沙箱里的一轮信封**补上子代理 span**（V1 的 `spans`）。
 *
 * ★ 为什么必须补：子代理的真实 span 由主进程**唯一的模型出网口**采集（V1），
 *   而演示沙箱放的是**预置脚本轮次** —— 它们不经过真实出网口，信封里天然没有 spans。
 *   而演示最该被看见的恰恰是「学生看不见的那几次旁路调用」（五问概括 / 画像刷新 /
 *   画像小结），所以演示数据自带三条：两条在本轮内、一条轮外（启动补跑），
 *   时间轴上的**子代理泳道**与**轮外那一段**因此都能在演示里被看到。
 * ★ 只作用于演示沙箱这两个调用点（`seedHistory` / `publishEnvelope`）——
 *   真实运行那一侧的信封一个字节都不补。
 * ★ 已经带了 spans 的信封**原样返回**：真数据永远优先于演示数据。
 */
function withDemoSpans(turn: TurnDiagnostics): TurnDiagnostics {
  const existing = (turn as TurnDiagnostics & { spans?: unknown }).spans
  if (Array.isArray(existing) && existing.length > 0) return turn
  const spans: RuntimeSpan[] = [
    {
      id: `demo-span-${turn.turn}-a`,
      kind: 'subagent',
      purpose: '五问概括',
      label: '五问概括',
      startedAt: turn.at + 600,
      ms: 1_800,
      model: 'demo-model',
      promptChars: 640,
      promptTokEst: 320,
      ok: true,
      note: null,
      offTurn: false,
      turnIndex: turn.turn
    },
    {
      id: `demo-span-${turn.turn}-b`,
      kind: 'subagent',
      purpose: '画像刷新',
      label: '画像刷新',
      startedAt: turn.at + 3_200,
      ms: 900,
      model: 'demo-model',
      promptChars: 410,
      promptTokEst: 205,
      ok: true,
      note: null,
      offTurn: false,
      turnIndex: turn.turn
    },
    {
      id: `demo-span-${turn.turn}-c`,
      kind: 'subagent',
      purpose: '画像小结',
      label: '画像小结',
      // 轮外：发生在这一轮之前（启动补跑），时间轴上另起一段
      startedAt: turn.at - 60_000,
      ms: 1_200,
      model: 'demo-model',
      promptChars: 520,
      promptTokEst: 260,
      ok: true,
      note: null,
      offTurn: true,
      turnIndex: null
    }
  ]
  return { ...turn, spans }
}

/** 投第一句之前的停顿：引用先亮，正文再开始（≈120ms，与真实路径的观感一致）。 */
const DEMO_DELTA_DELAY_MS = 120

/** 卡片在正文流到这个比例处投（不是讲完才投）。 */
const DEMO_CARD_AT_RATIO = 0.7

/** 在飞的那一轮回放（`cancel()` 据此把剩余事件一次性投完）。 */
interface ScriptedPlayback {
  requestId: string
  answer: string
  /** 已经推出去的字数。 */
  shown: number
  cards: readonly DemoSeedCard[]
  cardsPushed: boolean
  /** 这一轮对应的脚本轮（收尾时要把它的信封交给驾驶舱）。 */
  turn: DemoScriptTurn
}

/**
 * 计时器登记表 + 在飞的回放（**模块级**：定时器回调不属于任何组件实例，
 * 而 `cancel()` 要能把它们一次清干净）。
 *
 * ★ 本 store 是单例（Pinia），所以这两个变量与实例状态一一对应，不会互相踩。
 */
const timers: ReturnType<typeof setTimeout>[] = []
let playback: ScriptedPlayback | null = null

/** 清掉全部计时器（取消 / 收尾共用；对已经触发的 id 再 clear 一次是无害的）。 */
function clearTimers(): void {
  for (const id of timers) clearTimeout(id)
  timers.length = 0
}

/** 登记一个计时器（**唯一的排期入口**：不登记的话 `cancel()` 清不到它）。 */
function later(delay: number, run: () => void): void {
  timers.push(setTimeout(run, delay))
}

/**
 * 取对话 store。
 *
 * ★ 每个动作里**现取**，不在文件顶层拿：本文件与 `stores/chat.ts` 互相 import
 *   （它要读 `seeded`，这里要往对话里投事件），而「在动作里再取一次」是 Pinia
 *   明确支持的用法 —— 顶层拿会落在模块求值的循环上。
 */
function chatStore(): ReturnType<typeof useChatStore> {
  return useChatStore()
}

export const useDemoSeedStore = defineStore('demoSeed', () => {
  /**
   * 现在是不是沙箱态。
   *
   * ★ 真值在主进程：这里只反映「主进程最近一次告诉我们的事实」——
   *   切换成功后主进程会重载所有窗口，届时 {@link refresh} 再问一次。
   */
  const seeded = ref(false)
  /** 三轮脚本（`seeded` 且取到之前是 `null`；`advance()` 拿不到就如实返回 false）。 */
  const script = ref<DemoScriptPayload | null>(null)
  /**
   * 桥缺失 / 读脚本失败时的**学生话**说明（一句话）。
   * ★ 技术原因（缺哪个方法、要走哪条通道）只进控制台：`warnWiring`。
   */
  const bridgeError = ref<string | null>(null)
  /** 下一轮要放第几个（0-based；放到末尾**循环回 0**）。 */
  const cursor = ref(0)
  /** 这一轮正在回放（回放中不再接新一轮）。 */
  const playing = ref(false)

  /**
   * 这份脚本放到第几遍了（0-based；放完最后一段、绕回第 1 段时 +1）。
   *
   * ★★ 为什么必须有它（不是可选的花样）：`requestId` 里带着轮次号，于是**第 2 遍**的
   *   `script-1` 与第 1 遍撞名 —— 而 `startTurn` 认出重名会**不建轮**（`api/events.ts`）。
   *   那一下的表现是「按了发送、字没了、什么都没发生」：正文被折叠进一条**已经结束**的
   *   轮次，界面上一个像素都不动。循环放三遍恰恰是演示里最常见的用法。
   *   ⇒ 第 2 遍起带 `.<遍数>` 后缀；它仍以 `script-` 开头（「不被按 requestId 认领轮次的
   *   逻辑误认」这个前提一个字都没变）。
   * ★ 它只增不减（`resetProgress()` 也不重置）：屏幕上那些轮次还在，同名 id 就会撞。
   */
  let pass = 0

  /**
   * 取数代次：每次「问状态 / 改状态」都 +1。
   *
   * ★★ 迟到的回执按代次丢掉：学生在读取还没回来时点了那颗按钮、或者两次读取
   *   叠在一起时，只有**最新**那次说了算 —— 否则一条过期的回执会把刚切好的状态
   *   改回去（界面上表现为「点了没反应」或者「自己弹回原样」）。
   */
  let epoch = 0

  /** 桥缺失时的统一处置：一句学生话 + 一条控制台诊断（不算异常、不抛）。 */
  function bridgeMissing(detail: string): null {
    warnWiring('demoSeed', detail)
    // ★ 用它而不是另写一句：它是共享模块里那句「当前不可用」的唯一来源，
    //   两处各写一句的话，两句话迟早不一样（见 shared/demo-seed.ts 的说明）。
    bridgeError.value = DEMO_BLOCKED_MESSAGE
    return null
  }

  /** 探测三条通道（缺一条就判定「这条线还没接完」，与 `api/diagnostics.ts` 同一手法）。 */
  function resolveBridge(): Pick<
    K12Api,
    'readDemoState' | 'seedDemo' | 'readDemoScript'
  > | null {
    if (typeof window === 'undefined' || typeof window.api === 'undefined') {
      return bridgeMissing('window.api 缺失：preload 没有加载（演示沙箱那三条通道不可用）。')
    }
    const api = window.api
    if (
      typeof api.readDemoState !== 'function' ||
      typeof api.seedDemo !== 'function' ||
      typeof api.readDemoScript !== 'function'
    ) {
      return bridgeMissing(
        'preload 白名单缺少 readDemoState / seedDemo / readDemoScript 中的一个或多个：' +
          '需要主进程注册 demo:state / demo:seed / demo:script 三条 invoke 通道，再由 preload 暴露。'
      )
    }
    return api
  }

  /**
   * 问一次主进程「现在是不是沙箱态」；是的话再把三轮脚本取回来。
   *
   * ★ 启动时（`App.vue`）与进入驾驶舱时（`views/Demo.vue`）各问一次：预置开关住在
   *   主进程，渲染进程重载后什么都不记得 —— 不问的话按钮会显示成错的那个状态。
   * ★ 失败只写一句说明，**不算异常**（顶栏那颗按钮变成禁用即可）。
   */
  async function refresh(): Promise<void> {
    const bridge = resolveBridge()
    if (bridge === null) return
    const mine = ++epoch
    try {
      const result = await bridge.readDemoState()
      if (mine !== epoch) return
      if (!result.ok) {
        bridgeError.value = result.message
        return
      }
      const next = result.state === 'seeded'
      seeded.value = next
      bridgeError.value = null
      if (!next) {
        // 不是沙箱态：没有脚本可放；把可能残留的回放也停掉（正常情况下本来就没有）。
        script.value = null
        clearHistory()
        resetProgress()
        return
      }
      const scriptResult = await bridge.readDemoScript()
      if (mine !== epoch) return
      // ★ await 之后再看一眼：这中间学生可能已经退出了沙箱 —— 迟到的脚本不许把状态改回去。
      if (!seeded.value) return
      if (!scriptResult.ok) {
        bridgeError.value = scriptResult.message
        return
      }
      if (!isDemoScriptPayload(scriptResult.data)) {
        // 半截脚本不进入脚本态：宁可按钮点了没反应，也不要在学生面前放一段缺字的回答。
        bridgeError.value = DEMO_BLOCKED_MESSAGE
        return
      }
      script.value = scriptResult.data
      // ★ 预置历史的逐轮信封**当场**进时间轴：点开侧栏那三条会话就能在运行透视里
      //   看到那几轮，而不是要等到演示者把脚本放一遍之后才出现。
      seedHistory(scriptResult.data)
      bridgeError.value = null
    } catch (error) {
      warnWiring(
        'demoSeed.read',
        `readDemoState 调用失败：${error instanceof Error ? error.message : String(error)}`
      )
      bridgeError.value = '暂时读不到，需要时请老师帮忙看看。'
    }
  }

  /**
   * 切换沙箱档位（**唯一的人工写入口**）。
   *
   * ★ **幂等**：值没变不重复调 —— 主进程每次切换都会重载所有窗口，白调一次就是白闪一下。
   * ★ 成功即改本地 `seeded`：主进程随后重载窗口，这一改只是让按钮**当场**反映结果。
   * ★ 失败把回执里那句可读中文放进 `bridgeError`（不抛、不改档位）。
   */
  async function setSeeded(next: DemoSeedState): Promise<void> {
    if (next === (seeded.value ? 'seeded' : 'inactive')) return
    const bridge = resolveBridge()
    if (bridge === null) return
    const mine = ++epoch
    try {
      const result = await bridge.seedDemo(next)
      if (mine !== epoch) return
      if (!result.ok) {
        bridgeError.value = result.message
        return
      }
      seeded.value = result.state === 'seeded'
      bridgeError.value = null
      if (!seeded.value) {
        // 退出沙箱：脚本与进度一起清掉（主进程随后重载窗口，这只是让本机先对齐）。
        script.value = null
        clearHistory()
        resetProgress()
      }
    } catch (error) {
      warnWiring(
        'demoSeed.set',
        `seedDemo 调用失败：${error instanceof Error ? error.message : String(error)}`
      )
      bridgeError.value = '这次切换没有成功，可以再试一次。'
    }
  }

  /** 那颗按钮的唯一动作：开着就退出，关着就载入。 */
  function toggle(): Promise<void> {
    return setSeeded(seeded.value ? 'inactive' : 'seeded')
  }

  /** 投这一轮的卡片（每轮只投一次；正文流到 70% 处与收尾时都会问它一次）。 */
  function pushCards(current: ScriptedPlayback): void {
    if (current.cardsPushed) return
    current.cardsPushed = true
    for (const card of current.cards) {
      chatStore().pushScriptedEvent({
        name: 'payload',
        data: { requestId: current.requestId, kind: card.kind, payload: card.payload }
      })
    }
  }

  /**
   * 把这一轮**剩下的事件一次性投完**：剩余正文 → 卡片 → `done`。
   *
   * ★ 正常走完与 {@link cancel} 共用它：差别只是「还剩多少没投」——
   *   两条路各写一份收尾的话，迟早出现「取消后少一个 done（气泡永远在转）」。
   */
  function deliverRemainder(current: ScriptedPlayback): void {
    const rest = current.answer.slice(current.shown)
    if (rest.length > 0) {
      current.shown = current.answer.length
      chatStore().pushScriptedEvent({
        name: 'delta',
        data: { requestId: current.requestId, delta: rest }
      })
    }
    pushCards(current)
    // ★ `messageId` 恒为空串：脚本轮次没有写进任何会话文件，三种 id
    //   （`entryId` / `userEntryId` / `messageId`）一律为空 —— 它不能当分叉点，
    //   也不该被当成一条真实记录（与 `restored-` 前缀同一条纪律）。
    chatStore().pushScriptedEvent({
      name: 'done',
      data: { requestId: current.requestId, messageId: '' }
    })
    publishEnvelope(current.turn)
  }

  /**
   * 已经放过的脚本轮次（累加）。
   *
   * ★★ 为什么必须**累加**而不是把三轮一次性塞进去：驾驶舱的轮次时间轴要的是
   *   「放过哪几轮」，而在第一轮还没放完时就把第三轮的信封端出来，等于让演示者
   *   拿着还没发生的证据去讲 —— 那正是「信封每一格都是运行时真的产生过的」这条
   *   纪律要拦的东西。
   */
  const publishedTurns: TurnDiagnostics[] = []

  /**
   * **预置历史**三条会话的逐轮信封（`demo:script` 随脚本一起下发，展平后放在最前面）。
   *
   * ★★ 为什么历史轮次一拿到就进时间轴、而脚本轮次要等放过那一轮才进：
   *   那三条会话在侧栏上是**已经聊过的历史**（点开就有正文），它们的信封是「当时留下的
   *   记录」；而脚本那三轮是**还在发生**的（放到哪一轮才算哪一轮）。
   *   两者共用同一个快照入口，但来路不同 —— 混在一起会让演示者拿着还没发生的证据去讲。
   * ★ 轮次号由主进程保证唯一（历史 1..N，脚本从 N+1 起），这里只做展平，不改号。
   */
  const historyTurns: TurnDiagnostics[] = []

  /** 历史轮次 → 会话标题（时间轴上标「这一轮属于哪条会话」；脚本轮次没有条目）。 */
  const sessionTitles = ref<Record<number, string>>({})

  /**
   * 把「预置历史的轮次（在前）+ 已经放过的脚本轮次（在后）」交给驾驶舱。
   *
   * ★ 与**真实轮次共用同一个入口**（`diagnostics.applySnapshot`）：两套写入路径
   *   会让浮窗与驾驶舱看到的不是同一份数据（而它们本来共用同一套渲染件）。
   * ★ `persisted: false` 老实标出来：这份不是从落盘记录暖机来的。
   */
  function publishSnapshot(): void {
    useDiagnosticsStore().applySnapshot({
      turns: [...historyTurns, ...publishedTurns],
      limit: DIAGNOSTICS_TURN_LIMIT,
      persisted: false,
      updatedAt: Date.now()
    })
  }

  /**
   * 收下脚本里带的**预置历史**（拿到脚本时立即灌进时间轴）。
   *
   * ★ 三条会话的标题与逐轮信封一起收：时间轴上只写「第 N 轮」的话，
   *   十二个节点分不出哪几轮属于哪条会话 —— 而这一屏要讲的正是「每条会话里
   *   它都做了什么」。标题存成 `turn → title` 的只读映射供页面查询
   *   （**不动 `TurnDiagnostics` 的结构**：那是采集器与落盘剥离的公共契约）。
   */
  function seedHistory(payload: DemoScriptPayload): void {
    historyTurns.length = 0
    const titles: Record<number, string> = {}
    for (const session of payload.history ?? []) {
      for (const turn of session.turns) {
        // 演示数据自带子代理 span（见 withDemoSpans 的说明）
        historyTurns.push(withDemoSpans(turn))
        titles[turn.turn] = session.title
      }
    }
    sessionTitles.value = titles
    publishSnapshot()
  }

  /** 把一轮脚本信封交给驾驶舱（接在历史轮次后面）。 */
  function publishEnvelope(turn: DemoScriptTurn): void {
    publishedTurns.push(withDemoSpans(turn.diagnostics))
    publishSnapshot()
  }

  /** 这一轮属于哪条预置会话（不是历史轮次时回空串，页面就不渲染那一行）。 */
  function titleOf(turn: number): string {
    return sessionTitles.value[turn] ?? ''
  }

  /** 退出沙箱时把预置历史一并丢掉（那些轮次只属于沙箱态的这段时间轴）。 */
  function clearHistory(): void {
    historyTurns.length = 0
    sessionTitles.value = {}
  }

  /** 收尾：清掉计时器 + 把在飞的那一轮结掉（**绝不留 `streaming` 残留**）。 */
  function finishPlayback(): void {
    clearTimers()
    const current = playback
    playback = null
    playing.value = false
    if (current !== null) deliverRemainder(current)
  }

  /**
   * 取消这一轮回放（清掉所有计时器）。
   *
   * ★ 还开着的那一轮**立刻收尾**：剩余事件一次投完、`status` 落到 `done`。
   *   不收尾的话，气泡会永远停在「正在回答」上 —— 而真正的那一轮永远不会来。
   */
  function cancel(): void {
    finishPlayback()
  }

  /** 进度归零（驾驶舱「一键清空」与退出沙箱用）：收掉在飞的一轮 + 回到第 1 轮。 */
  function resetProgress(): void {
    cancel()
    cursor.value = 0
  }

  /** 逐字推一个字；推到 70% 处投卡片；推完收尾。 */
  function pushNextChunk(): void {
    const current = playback
    if (current === null) return
    if (current.shown >= current.answer.length) {
      finishPlayback()
      return
    }
    const delta = current.answer[current.shown] as string
    current.shown += 1
    chatStore().pushScriptedEvent({
      name: 'delta',
      data: { requestId: current.requestId, delta }
    })
    if (!current.cardsPushed && current.shown >= Math.floor(current.answer.length * DEMO_CARD_AT_RATIO)) {
      pushCards(current)
    }
    if (current.shown >= current.answer.length) {
      finishPlayback()
      return
    }
    later(DEMO_DELTA_INTERVAL_MS, pushNextChunk)
  }

  /**
   * ★★ 放下一轮（学生按了发送、而沙箱开着时由 `chat.send()` 调到这里）。
   *
   * 返回 `false` = **这次没放**（没开沙箱 / 正在放 / 脚本还没拿到）——
   * 调用方据此决定「这一句是不是要被本机脚本接手」（false 时走真实发送）。
   *
   * 时间线（与真实轮次的观感对齐）：
   *   t=0      引用 + 降级档位（右栏与来源标签立刻有东西）
   *   t≈120ms  开始逐字（每 18ms 一个字）
   *   ≈70%     投卡片（不是讲完才投）
   *   推完     `done` 收尾，`playing` 落回 false
   */
  function advance(typed?: string): boolean {
    if (!seeded.value || playing.value) return false
    const payload = script.value
    if (payload === null || payload.turns.length === 0) return false
    const turn = payload.turns[cursor.value % payload.turns.length]
    if (turn === undefined) return false
    cursor.value = (cursor.value + 1) % payload.turns.length

    const requestId =
      pass === 0
        ? `${DEMO_REQUEST_PREFIX}${turn.turn}`
        : `${DEMO_REQUEST_PREFIX}${turn.turn}.${pass}`
    // ★ 顺序要紧：**这一遍已经开演的这一轮**仍用旧的遍数，只有下一次（绕回第 1 段之后）
    //   才换新后缀 —— 反过来写会让每一遍的最后一轮提前带上新后缀（实测踩到过）。
    //   ⚠️ 绕回第 1 段 = 这一遍放完了：下一遍的 requestId 要避开上一遍留下的同名轮次，见 `pass`。
    if (cursor.value === 0) pass += 1
    const chat = chatStore()
    try {
      // ★ 学生打什么都会被「吃掉」，屏幕上出现的是脚本里那句（见 DemoScriptTurn.studentText）：
      //   现场演示不可能每次都把那几句话原样打对，而脚本必须稳定。
      // ★★ 唯一例外是**拦截轮**（`studentTextFromInput`）：那一轮要让学生气泡显示
      //   演示者真正打进去的敏感词（不让打码、不替换），所以取真输入；
      //   真输入为空时回落到脚本里那句 —— 气泡永远不会是空的。
      const studentText =
        turn.studentTextFromInput === true && typeof typed === 'string' && typed.trim() !== ''
          ? typed
          : turn.studentText
      chat.beginScriptedTurn(requestId, studentText)
    } catch (error) {
      warnWiring(
        'demoSeed.advance',
        `脚本轮次建轮失败：${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }

    playing.value = true
    playback = {
      requestId,
      answer: turn.answer,
      shown: 0,
      cards: turn.cards,
      cardsPushed: false,
      turn
    }
    // t=0：引用与档位先亮 —— 走的是与真实轮次**同一批**投影函数（右栏 / 来源标签照常）。
    chat.pushScriptedEvent({
      name: 'citation',
      data: {
        requestId,
        citations: turn.citations,
        details: turn.details ?? [],
        degraded: turn.degraded
      }
    })
    later(DEMO_DELTA_DELAY_MS, pushNextChunk)
    return true
  }

  return {
    /** 现在是不是沙箱态（真值在主进程，这里只反映最近一次回执）。 */
    seeded,
    /** 三轮脚本（拿到前为 `null`）。 */
    script,
    /** 桥缺失 / 取脚本失败时的学生话说明（一句话）。 */
    bridgeError,
    /** 下一轮要放第几个（0-based，循环）。 */
    cursor,
    /** 这一轮正在回放。 */
    playing,
    /** 问一次主进程的沙箱状态（是的话顺带取脚本）。 */
    refresh,
    /** 切换档位（幂等；失败只写一句说明）。 */
    setSeeded,
    /** 开着就退出、关着就载入（那颗按钮的唯一动作）。 */
    toggle,
    /**
     * 放下一轮；`false` = 这次没放（未开沙箱 / 正在放 / 没脚本）。
     *
     * `typed` = 演示者真正打进去的那句话：只有**拦截轮**用它当学生气泡的正文
     * （见 `DemoScriptTurn.studentTextFromInput`），其余轮一律显示脚本里那句。
     */
    advance,
    /** 取消回放（在飞的一轮立刻收尾，绝不留「正在回答」）。 */
    cancel,
    /** 收掉回放 + 进度归零。 */
    resetProgress,
    /**
     * 这一轮属于哪条预置会话（时间轴上的那行会话标题）。
     *
     * ★ 只读查询、拿不到就回空串（脚本轮次不属于任何历史会话）：
     *   页面据此决定渲不渲染那一行，不关心映射怎么来的。
     */
    titleOf
  }
})
