<script setup lang="ts">
/**
 * `payload` 事件的内联卡片**分派器**：按 `kind` 选卡片组件。
 *
 *   `quiz`      → `cards/QuizCard.vue`（票 14/15：做题、批改、闯关进度）
 *   `animation` → `cards/AnimationCard.vue`（票 16/17：沙箱 iframe + RPC + 容错降级）
 *   `coding`    → `cards/CodingCard.vue`（票 18/19：Monaco + Pyodide Worker）
 *
 * ★ 三个分支**已经穷尽**契约里的 `PayloadKind`（`api/events.ts` 的白名单只放行这三个），
 *   所以这里**没有也不需要**「未识别 kind」的兜底分支 —— 留一个永不渲染的 v-else
 *   只会让人误以为存在第四种 kind（还会自带一个永远禁用的按钮）。
 *   载荷内部认不出字段时，由各卡片自己的 `kind: 'unknown'` 分支退化成可读文案。
 *
 * 载荷是契约里的 `unknown`，所以每个卡片自己只读**明确认识的字段**。
 *
 * ── ★★ 动画卡片的**来源切换**（这一层持有状态，卡片只显示与上报）────────────
 *
 * 学生可以在「内置 / 我的」之间换着看，也可以点「在线生成」要一份新的。这三件事的状态
 * （当前看哪一份、库里那一份的载荷、正在做、提示语）都放在**这一层**，理由是一个机制性的：
 *
 *   `AnimationCard.vue` 在 `onMounted` 里**只读一次载荷**（
 *   `const view = readAnimationPayload(props.card.payload)` 是一个普通 const），
 *   把新载荷塞进同一个实例是**不会重渲染**的。所以「换一份来播」必须靠**重建组件**——
 *   这里给 `<AnimationCard>` 挂一个随来源变化的 `:key`，实例重建，载荷被重新读一遍。
 *
 * ★ 「在线生成」优先走**对话**（那才是模型的 Tool 做动画的地方，做完的卡片会进上下文），
 *   只有当这一轮**根本开不起来**（没有配置模型 / 发送失败）时才退到直连那条通道。
 *   排序与失败收敛在 `stores/animation.ts` 的 `requestNewAnimation()` 里（纯函数、可单测）。
 *
 * ★ 库里那份的**匹配键**：卡片的载荷里**没有知识点 id**（Tool 只下发概念名与学段），
 *   所以这里用「学段 + 概念名」对齐动画库里的一条。这是渲染侧能做到的最好对齐 ——
 *   代价说清楚：同一个学段下两个概念名一模一样的动画会被当成同一份（实际几乎不会发生，
 *   因为概念名是模型照学生的话写的）。真要做到知识点级精确，得让 Tool 的载荷带上 kpId。
 */
import { computed, onBeforeUnmount, reactive, watch } from 'vue'
import type { InlineCard } from '../api/events'
import { readAnimationPayload } from '../sandbox/iframe-host'
import {
  animationRedrawDisplayText,
  animationRequestDisplayText,
  animationRequestWireText,
  readPayloadGrade,
  requestNewAnimation,
  useAnimationStore
} from '../stores/animation'
import { useChatStore } from '../stores/chat'
import { useModelStore } from '../stores/model'
import { useReducedMotion } from '../composables/useReducedMotion'
import type { GradeLevel } from '@shared/ipc-events'
import AnimationCard from './AnimationCard.vue'
import CodingCard from './CodingCard.vue'
import QuizCard from './QuizCard.vue'

const props = defineProps<{ card: InlineCard }>()

const anim = useAnimationStore()
const chat = useChatStore()
const model = useModelStore()

/* ------------------------------------------------------------------ *
 * 动画卡片的来源状态（**按卡片 id 分**：一轮里可能有好几张动画卡片）
 * ------------------------------------------------------------------ */

/** 每张卡片当前看的是哪一份。 */
const sourceOf = reactive<Record<string, 'builtin' | 'mine'>>({})
/** 「我的」那一份的载荷（取回来才填；没填时切换不会发生）。 */
const altOf = reactive<Record<string, unknown>>({})
/** 每张卡片自己的提示语（没做成 / 已经去问了）。 */
const noticeOf = reactive<Record<string, string | null>>({})
/** 每张卡片是否正在做新动画。 */
const generatingOf = reactive<Record<string, boolean>>({})

/** 这张卡片自己那份载荷的投影（概念名与学段 —— 匹配库记录、拼消息都用它）。 */
const cardView = computed(() => readAnimationPayload(props.card.payload))
/** 卡片学段（主进程透传的那个；认不出是 `null`）。 */
const cardGrade = computed<GradeLevel | null>(() => readPayloadGrade(props.card.payload))
/** 学生**当前**学段（「按当前学段重画」的判据）。 */
const currentGrade = computed<GradeLevel | null>(() => chat.currentGrade)

/** 库里与这张卡片对齐的那一条（学段 + 概念名；没有就是 `null`）。 */
const savedMatch = computed(() => {
  if (props.card.kind !== 'animation') return null
  const grade = cardGrade.value
  if (grade === null) return null
  const concept = cardView.value.concept.trim().toLowerCase()
  if (concept === '') return null
  return (
    anim
      .savedFor({ gradeLevel: grade })
      .find((item) => item.concept.trim().toLowerCase() === concept) ?? null
  )
})

/** 当前来源（默认「内置」= 本张卡片带来的那一份）。 */
const source = computed<'builtin' | 'mine'>(() => sourceOf[props.card.id] ?? 'builtin')

/**
 * 真正交给卡片的载荷：看「我的」时用取回来的那一份，其余时候是本卡载荷。
 *
 * ★ 返回的是**新对象**（`{...card, payload}`）：卡片按 `props.card.payload` 读载荷，
 *   换了来源就得换它 —— 配合下面那个 `:key`（实例重建），读到的一定是新的那一份。
 */
const effectiveCard = computed<InlineCard>(() => {
  if (source.value !== 'mine') return props.card
  const payload = altOf[props.card.id]
  return payload === undefined ? props.card : { ...props.card, payload }
})

/** 「我的」那一份的学段是**库记录**说的那个（不是本卡载荷里那个）。 */
const gradeLevel = computed<string | null>(() => {
  if (source.value === 'mine') {
    const item = savedMatch.value
    if (item !== null) return item.gradeLevel
  }
  return cardGrade.value
})

/**
 * ★ 重建键：**来源一变就换实例** —— 这是「载荷只读一次」那个约束唯一的解法。
 *
 * 键里带上卡片 id（同一条消息里可能有好几张动画卡片，它们的实例不能互相串）。
 *
 * ★★ 2026-09-27（报告 §3.3）：键里再带上**减动效的有效值** —— 沙箱是独立文档
 *   （没有同源权限），宿主读得到 `prefers-reduced-motion`，但宿主的"设置页三档开关"
 *   是写在宿主 `<html>` 上的属性，沙箱看不见。所以设置一变就重建 iframe：
 *   新文档重新读一次偏好，动画立刻按新模式播（见 `_shared/runtime.js` 的减动效段）。
 */
const reducedMotion = useReducedMotion()
const animationKey = computed(
  () => `${props.card.id}#${source.value}#${reducedMotion.value ? 'reduced' : 'full'}`
)

/** 已经离开的卡片不再占状态（消息列表会整段重画）。 */
onBeforeUnmount(() => {
  delete sourceOf[props.card.id]
  delete altOf[props.card.id]
  delete noticeOf[props.card.id]
  delete generatingOf[props.card.id]
})

/**
 * 卡片一出现就把**这一档学段**的动画库清单取一次（同一档的并发只发一次请求）。
 *
 * 为什么要主动取：那颗「我的」按钮的可用性取决于「库里有没有这一份」——
 * 不取的话它永远是灰的，学生以为自己的动画丢了。
 * 失败不弹错（`loadSaved` 把原因留在 store 里）：这一层不打断对话。
 */
watch(
  () => [props.card.kind, cardGrade.value] as const,
  ([kind, grade]) => {
    if (kind !== 'animation' || grade === null) return
    void anim.loadSaved({ gradeLevel: grade })
  },
  { immediate: true }
)

/** 切到「我的」：把库里那一份取回来（**零生成**：库里存的就是成品）。 */
async function switchSource(next: 'builtin' | 'mine'): Promise<void> {
  const id = props.card.id
  if (next === 'builtin') {
    sourceOf[id] = 'builtin'
    return
  }
  if (altOf[id] !== undefined) {
    // 已经取过一份（这次会话里）：直接切过去，不再发请求
    sourceOf[id] = 'mine'
    return
  }
  const item = savedMatch.value
  if (item === null) {
    // 库里没有：**不可选**（按钮本来就灰着，这里再兜一道，绝不弹一个红字错误）
    noticeOf[id] = '这一份还没有保存过，先点「在线生成」做一份吧。'
    return
  }
  const playable = await anim.readSavedAnimation(item.id)
  if (playable === null) {
    noticeOf[id] = anim.savedError ?? '这条动画这次打不开，先看上面这一段。'
    return
  }
  altOf[id] = playable.payload
  noticeOf[id] = null
  sourceOf[id] = 'mine'
}

/**
 * 开一轮对话（返回 `false` = 这一轮没开起来 → 调用方走直连那条路）。
 *
 * `chat.send(显示文本, wire 文本)` 的两个文本分工见 `stores/animation.ts` 的说明：
 * 学生气泡里只出现那一句自然的话，写给模型的指令进 wire。
 *
 * ★ 判据是「**这一轮真的开起来了**」：`send()` 失败时会往 `localNotice` 里写一句话
 *   （桥缺失 / 被拒 / 抛异常），成功时它是 `null`；忙时排队也算开起来了（模型随后会收到）。
 */
async function startConversationTurn(redraw: boolean): Promise<boolean> {
  // 没配好模型：这句话发出去也答不出来，直接走直连那条路（省一次注定失败的等待）
  if (model.readyState === 'unconfigured') return false
  const concept = cardView.value.concept
  const target = redraw ? currentGrade.value : cardGrade.value
  const display = redraw ? animationRedrawDisplayText() : animationRequestDisplayText()
  const noticeBefore = chat.localNotice
  await chat.send(display, animationRequestWireText(concept, target, redraw))
  if (chat.streaming) return true
  return chat.localNotice === null || chat.localNotice === noticeBefore
}

/**
 * 点「在线生成」/「按当前学段重画」：**先走对话，不行再自己去做**。
 *
 * 三条结论各自的处置：
 *   · `conversation` → 卡片刻意**保持原样**（新动画会作为**新的一张卡片**出现在对话里，
 *     这是想要的：学生能接着就它提问），只留一句说明；
 *   · `composed` → 直连做出的那份就地换上（它已经存进库里了，所以标成「我的」）；
 *   · `failed` → **内置那份照旧在**（绝不白屏、绝不空框），只多一句可读提示。
 */
async function generate(redraw: boolean): Promise<void> {
  const id = props.card.id
  if (generatingOf[id] === true) return
  generatingOf[id] = true
  noticeOf[id] = null
  anim.clearComposeError()
  try {
    const outcome = await requestNewAnimation({
      startTurn: () => startConversationTurn(redraw),
      compose: () =>
        anim.composeNow({
          ...(redraw && currentGrade.value ? { gradeLevel: currentGrade.value } : {}),
          concept: cardView.value.concept || '这个概念',
          request: cardView.value.concept || '这个概念'
        })
    })
    if (outcome.kind === 'conversation') {
      noticeOf[id] = '已经请智团团重新做一份了，新的一张会出现在下面。'
      return
    }
    if (outcome.kind === 'composed') {
      altOf[id] = outcome.payload
      sourceOf[id] = 'mine'
      noticeOf[id] = '新的动画做好了，已经存进「我的动画」里。'
      return
    }
    noticeOf[id] = outcome.message
  } finally {
    generatingOf[id] = false
  }
}
</script>

<template>
  <!-- 练习卡片：题目 / 批改结果都由它自己按载荷结构判断 -->
  <QuizCard v-if="props.card.kind === 'quiz'" :card="card" />

  <!-- 动画卡片（票 16/17）：sandboxed iframe + postMessage RPC + 失败降级。
       ★★ `:key` 是**来源切换的唯一实现**：载荷在卡片里只读一次（`const view = …`），
         来源一变就换实例，新载荷才会被重新读一遍。 -->
  <AnimationCard
    v-else-if="props.card.kind === 'animation'"
    :key="animationKey"
    :card="effectiveCard"
    :source="source"
    :has-saved="savedMatch !== null"
    :grade-level="gradeLevel"
    :current-grade="currentGrade"
    :generating="generatingOf[props.card.id] === true"
    :notice="noticeOf[props.card.id] ?? null"
    @switch-source="switchSource"
    @generate="generate(false)"
    @redraw="generate(true)"
  />

  <!-- 编程卡片（票 18/19）：Monaco + Pyodide Worker（代码绝不在主进程跑） -->
  <CodingCard v-else :card="card" />
</template>
