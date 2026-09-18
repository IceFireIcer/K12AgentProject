/**
 * 对话状态（Pinia）：只负责「收事件 → 交给纯函数折叠 → 暴露给学生界面」。
 *
 * ★ 渲染进程不直连 sidecar 的 HTTP：这里是 `window.api`（preload 白名单）的唯一使用者之一。
 * ★ 事件分发的逻辑全在 `api/events.ts` 的纯函数里（可单测），本文件不做任何解析。
 *
 * ★★ 学段有**两条来源**，写入口**只有一条**：
 *   - 自动：系统从对话里判定（规则引擎 + 轻量 LLM，主进程侧），经 `grade:changed` 推来，
 *     本 store 只把它当**状态**收下（`currentGrade` + 一次性提示 `gradeNotice`）；
 *   - 手动：学生显式指定 → {@link setGrade} → `window.api.setGrade()`（走 `grade:set` 独立通道）
 *     → 服务端写库 → 主进程把结果推回来。
 *   ★ 手动**绝不混进对话请求**：`sendChat({ text })` 的字段集合被守卫 G6c 钉死为 `['text']`。
 *     混进去的话「发一条消息」会顺带写一次学段（重发同一句话、清空重打字都会再写一遍），
 *     而且拿不到回执 —— 学生无从知道冷却还剩几轮。
 *   ★ 前端自己算、自己改本地状态也不行：界面显示的学段会与库里的不一致，
 *     而下一轮对话用的是库里的值 —— 表现成「指示器写着初中，回答却按小学讲」。
 *
 *     不自己猜「大概是空的了」。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { GradeLevel } from '@shared/ipc-events'
import { normalizeGradeState, resolveGradeBridge, type GradeOrigin } from '../api/grade'
import {
  GRADE_SET_MISSING_HINT,
  normalizeGradeState,
  resolveGradeBridge,
  type GradeOrigin
} from '../api/grade'
import {
  CHAPTER_SET_MISSING_HINT,
import { buildQuizSubmissionMessage, collectQuizResults, type QuizResultView } from '../cards/quiz'
import {
  applyChatEvent,
  emptyConversation,
  startTurn,
  subscribeToChatEvents,
  type ConversationState,
} from '../api/events'

export const useChatStore = defineStore('chat', () => {
  const conversation = ref<ConversationState>(emptyConversation())
  const bridgeReady = ref(true)
  /** 本地提示（桥接缺失、发送被拒等），不是 6 事件里的 `error`。 */
  const localNotice = ref<string | null>(null)
  /**
   * 当前学段：`null` = 系统还没判出来、学生也还没选过。
   *
   * ★ 只认「有依据」的两态：`inferred`（系统判过）与 `explicit`（学生选的）。
   *   冷启动默认值（`default`）不是判定结果，也不是学生的选择 ——
   *   拿它上屏等于用默认值冒充一个结论（在演示里就是撒谎）。
   */
  const currentGrade = ref<GradeLevel | null>(null)
  /** 学段来源（三态；`null` = 还没收到任何推送）。 */
  const gradeOrigin = ref<GradeOrigin | null>(null)
  /** 学段**变化**时的一次性提示（下一个问题发出时清掉）。 */
  const gradeNotice = ref<string | null>(null)
  /** 学段推送通道缺失时的可读说明（缺通道不白屏，只说明原因）。 */
  const gradeBridgeError = ref<string | null>(null)
  /**
   *
   * ★ 它是一份**软偏好**：只进 System Prompt 的画像块（「回答与检索优先围绕本章」），
   */
  /**
   *
   * ★ 为什么必须有这句话：那一下**不是学生的动作**（是系统判定出的学段变了），
   *   学生会看到「正在学：第4章…」突然不见了 —— 不说一声就是「东西自己没了」。
   */
  /**
   *
   *   而「从错题本回对话页接着练」这个动作发生在**另一个视图的另一个组件**里，
   *   没有别的办法把一句话放进那个输入框（`provide/inject` 会绕更远）。
   * ★ 组件的本地草稿与此处**双向同步**（见 `MessageComposer.vue` 的注释）：
   *   以 store 为初值、每次输入写回 store，于是「预填 → 学生接着改 → 发送」这条链是通的。
   */
  let unsubscribe: (() => void) | null = null
  let unsubscribeGrade: (() => void) | null = null

  const turns = computed(() => conversation.value.turns)
  const streaming = computed(() => turns.value.some((turn) => turn.status === 'streaming'))

  /**
   * 整段对话里的卡片（**只在「卡片增删」时换引用**）。
   *
   *   每个 `delta` 都会替换 `turns` 数组（reducer 每个事件返回新状态），于是这条 computed
   *   逐字重算 —— 而它下游是**卡片载荷解析**（`collectQuizResults` / `collectHints` /
   *   `collectResult`，每张卡片都要跑一遍白名单投影）。长对话 + 多张卡片时，
   *   流式回答期间每秒上百次全量重解析 + 全量重渲染，低配机上表现为打字卡顿。
   *
   *   缓存命中时返回**同一个数组**，Vue 的 computed 在值未变时不会向下游传播
   *   （`refreshComputed` 里的 `hasChanged` 判定），解析与重渲染就此停在这一层。
   */
    if (
      cardCache !== null &&
      lists.length === cardCache.lists.length &&
      lists.every((list, index) => list === cardCache?.lists[index])
    ) {
      return cardCache.value
    }
    const flat = lists.flat()
    cardCache = { lists, value: flat }
    return flat
  })

  /** 指示器上的学段名（还没判出来时是「待判定」）。 */
  const currentGradeLabel = computed(() =>
    currentGrade.value === null ? null : GRADE_LABELS[currentGrade.value]
  )

  /**
   * 全对话的批改结果（按 `qid` 索引）。
   *
   * 为什么跨轮收集：题目卡片在某一轮，学生作答后**下一轮**才带回 `QuizResult`；
   * 只在本轮找的话，题干那张卡片永远等不到「答对了 / 掌握度 +0.15」。
   *
   *   这条全量解析**不会**重跑；新增卡片（`payload` 事件）时照旧重算，
   *   「批改结果一定能刷出来」的行为不变。
   */
  )

  /** 连上主进程事件流（幂等：重复调用不会重复订阅）。 */
  function connect(): void {
    connectGrade()
    if (unsubscribe !== null) return
    if (typeof window === 'undefined' || typeof window.api === 'undefined') {
      bridgeReady.value = false
      localNotice.value = '预加载脚本未生效（window.api 缺失），对话通道不可用。'
      return
    }
    bridgeReady.value = true
    unsubscribe = subscribeToChatEvents(window.api, (event) => {
      conversation.value = applyChatEvent(conversation.value, event)
    })
  }

  /** 断开事件流（组件卸载时必须调用，避免监听器堆积）。 */
  function disconnect(): void {
    unsubscribe?.()
    unsubscribe = null
    unsubscribeGrade?.()
    unsubscribeGrade = null
  }

  /**
   * 订上学段推送（幂等；缺通道时只记原因，不抛异常）。
   *
   * 主进程推什么就显示什么 —— 渲染进程**不做第二套判定**。
   */
  function connectGrade(): void {
    if (unsubscribeGrade !== null) return
    const lookup = resolveGradeBridge()
    if (!lookup.ready) {
      gradeBridgeError.value = lookup.message
      return
    }
    gradeBridgeError.value = null

    try {
      unsubscribeGrade = lookup.bridge.onGradeChanged((raw) => {
        applyGradeState(raw)
      })
    } catch (error) {
      gradeBridgeError.value = `学段推送订阅失败：${error instanceof Error ? error.message : String(error)}`
      return
    }

    // 初始值（可选能力）：拿不到就等推送，不报错
    void lookup.bridge.getGrade?.().then(
      (result) => {
        if (result.ok) applyGradeState(result.data)
      },
      () => {
        /* 拉取失败不影响推送路径 */
      }
    )
  }

  /**
   * 应用一条学段状态（纯折叠 + 一次性提示）。
   *
   * ★ **`inferred` 与 `explicit` 都上屏**，原因不同但都要显示：
   *   - `inferred` = 系统真的判出来了（学生该感知到「它在适配我」）；
   *   - `explicit` = 学生自己选的（他刚点完，界面必须**当场**反映出来，否则等于没生效）。
   *   只有 `default`（冷启动默认值）不上屏 —— 用默认值冒充判定结果是在骗演示。
   *
   * ★ **只有 `inferred` 给 `gradeAdaptNotice`**（「我按X的说法来讲」）：那句话的主语是系统。
   *   学生手动选完时若也推这句，等于告诉他「是系统替你改的」，来源就说反了；
   *   手动那条回执由 {@link setGrade} 给（「已按你选的…」）。这也意味着：
   *   手动选完紧接着收到主进程推来的 `explicit`，**不会**覆盖掉刚给的手动回执。
   *
   * ★ 提示只在「显示出来的学段真的变了」时给：初次收到 `default` 不算变化，
   *   第一次判定成功（`default` → `inferred`）与后续改判都算 —— 这正是学生该感知的时刻。
   */
  function applyGradeState(raw: unknown): void {
    const next = normalizeGradeState(raw)
    if (next === null) return

    // ★ 冷启动默认值**整条**丢掉（不只丢学段名，也不写 `gradeOrigin`）：
    //   `gradeOrigin` 的含义是「这个学段是怎么定下来的」。还没定下来的时候往里写
    //   `default`，会让来源标签悄悄变成「AI 引擎推算」—— 学生刚手动选完时，
    //   一条过期的冷启动推送就能把他那句「手动选中」顶掉（同一个谎，换了个字段）。
    if (next.origin !== 'inferred' && next.origin !== 'explicit') return

    const previous = currentGrade.value
    gradeOrigin.value = next.origin
    currentGrade.value = next.gradeLevel

    //   （清空是「学段变更」的副作用，而不是「学段变了」这条状态本身）。
    //   ⚠️ 重取**不做本地比较**：`applyGradeState` 有两条来路（推送 + 初始 `getGrade()`），
    if (previous !== next.gradeLevel) {
    }

    if (next.origin === 'inferred' && previous !== next.gradeLevel) {
      gradeNotice.value = gradeAdaptNotice(next.gradeLevel)
    }
  }

  /**
   * ★ 学生手动切换学段（唯一的人工写入口）。
   *
   * 为什么前端不算、不推断：前端只传「学生选了什么」，生效逻辑全在服务端
   * （`rules.override_level` 原子写 student.grade_level + grade_history(source="explicit")），
   * 再由主进程把结果推回来。前端自己改本地状态会让界面上显示的学段与库里不一致。
   *
   * ★ 走 `window.api.setGrade()`（preload 白名单），**绝不混进 `ChatSendRequest`**。
   * ★ 失败**不抛**、不写本地状态：返回一句可读中文，由调用方展示（与 settings store 同口径）。
   */
  async function setGrade(level: GradeLevel): Promise<{ ok: boolean; message?: string }> {
    const lookup = resolveGradeBridge()
    if (!lookup.ready) return { ok: false, message: lookup.message }
    // ★ 缺 `setGrade` 是「这条线还没接」，不是「学段整个不可用」：单独一句说明，
    //   否则学生会以为系统的自动判定也坏了（那只读那部分其实好着）。
    if (typeof lookup.bridge.setGrade !== 'function') {
      return { ok: false, message: GRADE_SET_MISSING_HINT }
    }

    try {
      const result = await lookup.bridge.setGrade(level)
      if (!result.ok) return { ok: false, message: result.message }

      // ★ 成功才动本地状态：服务端已经写了库，这里只是把它显示出来。
      //   `gradeNotice` 先赋新值 —— 它是一次性提示，天然覆盖掉旧的自动提示；
      //   手动切换必须让学生**当场看到生效**，否则他点完不知道有没有成功。
      currentGrade.value = level
      gradeOrigin.value = 'explicit'
      gradeNotice.value = gradeManualNotice(level)
      gradeBridgeError.value = null
      return { ok: true }
    } catch (error) {
      // ★ IPC 崩了也要出可读中文（绝不把异常抛给组件，那会渲染成一段堆栈文本）
      return {
        ok: false,
        message: `设定学段失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }


  /**
   *
   */
    if (!lookup.ready) {
      return
    }

    try {
      })
    } catch (error) {
      return
    }

    // 初始值（可选能力）：拿不到就等推送，不报错
        (result) => {
        },
        () => {
          /* 拉取失败不影响推送路径 */
        }
      )
    }
  }

  /**
   *
   *   学生看到「正在学：第4章…」突然不见了，不说一声就是「东西自己没了」。
   */
    if (next === null) return
    }
  }

  /**
   *
   *   对话照常（与「画像抓不到就用空块」同一条纪律）。
   */
    if (!lookup.ready) {
      return
    }
    try {
    } catch {
      /* 读不到就保持现状，不阻断对话 */
    }
  }

  /**
   *
   * 为什么前端不算、不推断：前端只传「学生选了什么」，生效逻辑全在服务端
   * ★ 失败**不抛**、不写本地状态：返回一句可读中文，由调用方展示（与 {@link setGrade} 同口径）。
   */
    if (!lookup.ready) return { ok: false, message: lookup.message }
    //   否则学生会以为指示器上那行「正在学：…」也坏了（那只读那部分其实好着）。
      return { ok: false, message: CHAPTER_SET_MISSING_HINT }
    }

    try {
      if (!result.ok) return { ok: false, message: result.message }

      // ★ 成功才动本地状态：服务端已经写了库，这里只是把它显示出来（与 setGrade 同一条纪律）。
      return { ok: true }
    } catch (error) {
      // ★ IPC 崩了也要出可读中文（绝不把异常抛给组件，那会渲染成一段堆栈文本）
      return {
        ok: false,
      }
    }
  }

  /** 发一轮对话：本地先落学生消息，拿到 `requestId` 后建立本轮（事件可能已在前头到达，会被回放）。 */
  async function send(rawText: string): Promise<void> {
    const text = rawText.trim()
    if (text.length === 0 || streaming.value) return

    localNotice.value = null
    gradeNotice.value = null
    if (typeof window === 'undefined' || typeof window.api === 'undefined') {
      bridgeReady.value = false
      localNotice.value = '预加载脚本未生效（window.api 缺失），无法发送。'
      return
    }

    // ★ 这一轮用的学段由**服务端**决定（自动判定 / 学生已手动选定的那把值）：
    //   这里只是把「当前生效的学段」记在轮次上，供界面标注；轮次标注**不是**学段的写入路径。
    const gradeAtSend = currentGrade.value

    try {
      // ★ 不传学段：`ChatSendRequest` 里没有 `gradeLevel`。为什么手动学段也不能从这里走 ——
      //   那样「发一条消息」会顺带写一次学段（重发同一句话、清空重打都会再写一遍），
      //   而且没有回执告诉学生冷却还剩几轮（`grade:set` 才有）。
      const result = await window.api.sendChat({ text })
      if (!result.ok) {
        localNotice.value = result.message
        return
      }
      conversation.value = startTurn(conversation.value, result.requestId, text, gradeAtSend)
    } catch (error) {
      localNotice.value = `发送失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * 练习卡片提交作答（票 14 的前端一半）。
   *
   * ★ **前端不判分**：这里只把「题目编号 + 学生的作答」说清楚，交给主 Agent 调 `submit_quiz`，
   *   判分与掌握度更新都在 Python 侧（§6.3 答案泄漏防护）。渲染进程拿不到答案，也不需要。
   */
  async function submitQuizAnswer(question: { qid: string; stem: string }, answer: string): Promise<void> {
    await send(buildQuizSubmissionMessage(question, answer))
  }

  /**
   *
   * 为什么是「预填 + 学生自己按发送」而不是直接 `send()`：
   *   - 主动替学生发消息会直接消耗一次云端调用，而学生可能只是想看看那句话对不对；
   *   - 学生看得见自己要问什么，才有机会补一句「我想练简单的」——
   *     这对一个教学助手比「一键自动开始」更贴合。
   *
   * ★ **绝不绕过 `send()` 的校验**：草稿只是填进输入框，走的还是那条通道
   *   （`ChatSendRequest` 只有 `text`，学段/身份都不从这里走）。
   *
   * ★ 这里**不改视图**：切视图是 `stores/ui.ts` 的事，调用方（错题本分页）
   *   两件事一起做。本函数只管草稿，这样它就不依赖 UI 状态（更好测、更少耦合）。
   */
  }

  return {
    conversation,
    turns,
    streaming,
    bridgeReady,
    localNotice,
    currentGrade,
    currentGradeLabel,
    gradeOrigin,
    gradeNotice,
    gradeBridgeError,
    quizResults,
    connect,
    connectGrade,
    disconnect,
    /** ★ 唯一的人工写入口：学生手动指定学段（走 `grade:set`，不碰对话请求）。 */
    setGrade,
    send,
    submitQuizAnswer
  }
})
