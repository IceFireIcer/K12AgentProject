<script setup lang="ts">
/**
 * 动画卡片（票 16/17）：沙箱播放 + 播放/暂停/重播/进度 + **失败绝不白屏**。
 *
 * ★★ 三条红线（改这个文件前先读）：
 *
 * 1. **沙箱属性只有 `allow-scripts`**，永远不加「放开同源」那个属性
 *    （加了沙箱形同虚设：iframe 里能读宿主 DOM 与 localStorage）。
 *    属性值来自 `sandbox/iframe-host.ts` 的 `SANDBOX_ATTRIBUTE` 常量，本文件**不自己写** ——
 *    属性写两处，迟早有一处漏改。架构守卫会扫本文件。
 *
 * 2. **每条 postMessage 都带 `payload_id`，并校验来源**（多卡片同屏会串台）。
 *    校验逻辑全在 `AnimationSandboxHost.handleMessage()` 里（纯逻辑、可单测），
 *    本组件只负责把 window 事件转进去。
 *
 * 3. ★ **失败/超时一律降级成文字讲解，绝不白屏**。
 *    三条降级入口：载荷里 `html` 为空（编排层已降级）、iframe 5s 没 `ready`、
 *    沙箱自报 `error`。三条都走同一个 {@link goDegraded}。
 *
 *    ⚠️ 2026-09-23：本卡片**不再走托管地址**（原实现「托管优先、失败回退内联」已删），
 *      理由见 `mountIframe` 上那段 —— 一句话：一次性 nonce 落到持久载荷里就必然是死地址，
 *      再让 iframe 去取它，学生就会直面一个 `{"detail":"动画资源未通过 nonce 校验（used）"}`。
 *
 *    ⚠️ 2026-09-22（报告 1.8 / 4.3「动画内嵌白卡：删除」）：降级态原来还渲染一张
 *    `<img class="anim__fallback-img">` —— 它是主进程按**同一段降级文案**生成的 SVG
 *    （`src/main/agent/extensions/animation.ts` 的 `buildInlineFallbackImage`，
 *    正文截 34 字），摆在完整文案下面等于同一段话说了两遍，第二遍还带截断。
 *    现在删掉：降级态只剩「文字要点 + 一句提示」，学生读到的是一个说法而不是两个。
 *    ⚠️ 主进程那段 SVG 生成**照旧保留**（它随载荷发给渲染端，也进对话历史与降级产物，
 *    要删得先确认没有别的消费者 —— 那是载荷契约改动，不在本轮范围）；本卡片不再引用
 *    `view.fallbackImage`（页面 `views/Animation.vue` 同理）。
 *
 * 展开/全屏：内联卡片受对话框宽度限制，全屏用 fixed 覆盖层（同一个 iframe 元素**移动**过去，
 * 不重建 —— 重建会让动画从头开始播，学生看到的是「一按全屏就重播」这种莫名其妙的行为）。
 * ⚠️ 2026-09-27 补：**窄卡片**里本来就没有 iframe（见 `narrow`），全屏是它第一次挂上，
 *    动画从那一刻开始播 —— 那不是"重播"，是它之前根本没播过（学生点的是「全屏看动画」）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { InlineCard } from '../api/events'
import { GRADE_LABELS } from '../labels'
import { useDiagnosticsStore } from '../stores/diagnostics'
// ★ 玻璃边缘光效（2026-09-30 设计执行报告 §4.3 一期）：根元素挂 k12-shine，
//   变量由 composable 按指针位置写入 —— 本文件不碰沙箱与 iframe 那一套。
import { useCardShine } from '../composables/useCardShine'
import CardHeader from '../components/card/CardHeader.vue'
import CardBody from '../components/card/CardBody.vue'
import DiagPeekButton from '../components/diag/DiagPeekButton.vue'
import {
  AnimationSandboxHost,
  SANDBOX_ATTRIBUTE,
  buildIframeAttributes,
  readAnimationPayload,
  shouldMountIframe,
  type AnimationPayloadView
} from '../sandbox/iframe-host'

/**
 * 卡片上的**来源切换**与动作按钮（这一层的状态在父组件 `InlineCard.vue` 手里）。
 *
 * ★★ 为什么状态在父组件而不是这里：本卡片在 `onMounted` 里**只读一次**载荷
 *   （`const view = readAnimationPayload(props.card.payload)`），新载荷进同一个实例
 *   是不会重渲染的。所以「换一份来播」这件事必须靠**重建组件**完成 ——
 *   父组件按来源给它换 `:key`，实例重建，载荷被重新读一遍。
 *   本组件因此只做两件事：把当前来源显示出来、把学生的点击**报上去**。
 *
 * ★ 2026-09-27（窄容器改动）**没有**动这条约定：挂载/卸载只决定沙箱元素的去留
 *   （`mountStage` / `unmountStage`），`view` 仍旧只读一次、也**不允许**在这里改读成响应式 ——
 *   换一份来播还是靠父组件换 `:key` 重建。别把「按需挂载」理解成「按需重读载荷」。
 *
 * ★ 学生看到的三个动作：
 *   · 「内置 / 我的」两态切换：内置 = 这张卡片带来的那一份；我的 = 动画库里存过的。
 *   · 「在线生成」：让智团团现场再做一个新的（优先走对话那一条，见父组件的编排）。
 *   · 「按当前学段重画」：只在**卡片的学段与学生当前学段不一致**时出现。
 */
const props = withDefaults(
  defineProps<{
    card: InlineCard
    /** 当前播放的是哪一份（`builtin` = 本卡载荷，`mine` = 库里那一份）。 */
    source?: 'builtin' | 'mine'
    /** 库里有没有这个知识点在本学段的那一份（没有时「我的」不可选）。 */
    hasSaved?: boolean
    /** 实际生效的学段（内置那份来自载荷的 `gradeLevel`，我的那份来自库记录）。 */
    gradeLevel?: string | null
    /** 学生**当前**学段（与卡片学段不同才提供「按当前学段重画」）。 */
    currentGrade?: string | null
    /** 正在做新动画（按钮显示进行中并禁用）。 */
    generating?: boolean
    /** 父组件给的提示（没做成、已经去问了……），`null` = 不显示。 */
    notice?: string | null
  }>(),
  {
    source: 'builtin',
    hasSaved: false,
    gradeLevel: null,
    currentGrade: null,
    generating: false,
    notice: null
  }
)

const emit = defineEmits<{
  /** 学生在「内置 / 我的」之间切换。 */
  (event: 'switch-source', source: 'builtin' | 'mine'): void
  /** 点「在线生成」：要一份**新的**（不复用库里那份）。 */
  (event: 'generate'): void
  /** 点「按当前学段重画」：按学生现在的年级做一份。 */
  (event: 'redraw'): void
}>()

const view: AnimationPayloadView = readAnimationPayload(props.card.payload)

/**
 * 卡片学段的中文名（认不出时给空串 → 那颗 chip 不渲染）。
 *
 * ★ **只读不算**：学段真值来自服务端推断 → 主进程透传（`payload.gradeLevel`），
 *   前端自己推一个出来的后果是「卡片标着 A、回答按 B 讲」。
 */
const gradeChip = computed<string>(() => {
  const level = props.gradeLevel
  return level && level in GRADE_LABELS ? GRADE_LABELS[level as keyof typeof GRADE_LABELS] : ''
})

/**
 * 要不要提供「按当前学段重画」。
 *
 * 判据是**两个学段都在且不相等**：卡片那份是给别的年级做的，而学生现在这个年级
 * 自己看得懂的说法与它不一样（同一个知识点在不同学段本来就是两份产物）。
 * 任一为空都不提供（例如学段还没判出来时，我们说不出「哪个才对」）。
 */
const canRedraw = computed<boolean>(
  () =>
    props.currentGrade !== null &&
    props.gradeLevel !== null &&
    props.currentGrade !== props.gradeLevel
)

/** 载荷里带的 `payload_id`；缺省时自己造一个（旧载荷 / 手写测试数据）。 */
const payloadId = ref<string>(
  typeof (props.card.payload as { payloadId?: unknown })?.payloadId === 'string' &&
    ((props.card.payload as { payloadId: string }).payloadId ?? '').length > 0
    ? (props.card.payload as { payloadId: string }).payloadId
    : `card-${props.card.id.replace(/[^A-Za-z0-9_-]/g, '_')}`
)

/**
 * ★★ 这张卡片是不是**回看恢复**出来的（不是本轮实时生成的那一张）。
 *
 * ★★ 判据为什么**不是**「载荷里有没有那个托管地址 / 有没有过期时间」：
 *   实时与回看两条路上的载荷**是同一份**（回看读的就是当初落盘的那份），
 *   托管地址在两条路上都带着 —— 它是**持久化**的字段，而它对应凭据的有效期
 *   并不写在载荷里（载荷没有签发时间、也没有到期时间）。也就是说载荷自身分不开
 *   「刚生成」与「上个月生成」，任何基于载荷的猜测都是撞运气。
 *   唯一确知这件事的地方就是**恢复这条路本身**：`restoredCards` 会给卡片打
 *   `restored: true`（见 `api/events.ts` 的 `InlineCard.restored`）。
 * ★ 载荷上的 `restored` 标记同样认：主进程投影将来若把标记打在载荷上，两条路都通。
 * ★ 切到「我的」（`source === 'mine'`）**不算回看**：那是学生此刻主动取回 / 刚生成的一份，
 *   载荷是这一秒才从库里取回来的，属新的交互，照常播。
 * ★ 回看态不重播当时那一遍（**一次性凭据绝不复用**，见 `mountIframe` 那段纪律）：
 *   卡片只渲染标题与文字讲解；想要现在再看，就重新生成一段（按钮走既有的生成入口）。
 */
const restoredSnapshot = computed<boolean>(() => {
  if (props.source === 'mine') return false
  if (props.card.restored === true) return true
  const payload = props.card.payload
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { restored?: unknown }).restored === true
  )
})

/**
 * 挂 iframe 的条件：**载荷里有 HTML**（`shouldMountIframe`），否则直接进降级视图。
 *
 * ★★ 2026-09-27：判据补上了**容器侧**那一半（见下面 `roomForStage` / `narrow`）。
 *   缺陷现场：学生在对话页把左右两个侧栏都打开（窗口 1024）—— 固定列吃掉 800px，
 *   主列只剩 224px、卡片 136px、iframe 104px。那种宽度下舞台里一个字都读不出来
 *   （宽度轴上画布已经没地方了），所以**窄容器不挂 iframe**，改「文字要点 + 全屏入口」。
 *   ⚠️ 不是断点的锅：1024 档保留三栏是**刻意的设计决策**（报告 §2.2，
 *      `tests/breakpoints.test.ts` 钉着），该改的是「卡片在窄容器里挂什么」，不是布局档位。
 *
 * ⚠️ 这一行的**字面写法**被两处钉着：`tests/animation-extension.test.ts`（②「挂载条件
 *   仍然只认 html」）与 `scripts/verify-guard-mutations.mjs`（变异 60）—— 它是「一次性
 *   nonce 地址不许绑回 iframe」那条纪律的抓手。扩展判据时**这一行必须原样保留**：
 *   载荷里有 HTML 仍然是前提，容器宽度只是加在上面的第二半。
 *
 * ★★ 为什么本卡片**只用内联 `srcdoc`，绝不把托管地址放进 `<iframe src>`**（2026-09-23 修复）：
 *
 * 旧实现「托管优先、失败再回退内联」有两处硬伤，实测都被用户撞到：
 *
 *   ① **载荷是持久化的，nonce 不是**。托管地址带一次性 nonce、TTL 只有 120 秒
 *      （`server/app/routes/resources.py`：`单次消费` + `Cache-Control: no-store`）。
 *      而这条 `resourceUrl` 会跟着会话**落盘**：切页回来重建卡片、回看历史、
 *      隔了 2 分钟再看、甚至 Chromium 丢弃一个隐藏 iframe 文档后再加载 ——
 *      每一种都会把同一个地址再取一次 → 403 `used` / `expired`。
 *   ② **失败的表现是把后端错误原文摆给学生**：iframe 拿到 403 就把
 *      `{"detail":"动画资源未通过 nonce 校验（used）"}` 当作文档渲染出来，
 *      于是学生在对话里看到一串英文 JSON；然后还要干等 5 秒超时才回退。
 *
 * 而内联 HTML **永远都在**：本行的挂载条件就是 `view.html` 非空（空则根本不会建 iframe），
 * 且托管的文件就是同一份 HTML（`hostAnimation({kpId, html})` 原样落盘）——
 * 也就是说「内联」与「托管」内容逐字相同，走内联却没有任何网络往返、不消耗 nonce、
 * 也不依赖 sidecar 存活（sidecar 挂了卡片照样能播）。
 *
 * ⚠️ 规格 D10 的「资源服务（Python 托管，带 nonce）」**没有被架空**：服务照旧签发与校验
 *   （服务端用例照跑），但界面里**已经没有消费者** —— 动画讲解页的舞台也改成了内联
 *   （2026-09-26，D-084）：它当时被当作「正当消费者」，理由写着「每次现签新地址、
 *   切页回来不会二次请求」，而真机探针把这句话推翻了 —— 同一个地址被取 3 次、
 *   最后一次 403（切走 3 秒 / 8 秒再回来，各新增 2 次请求）。
 *   一句话纪律：**一次性凭据不许挂在长期存在的 DOM 上**；判据不能是「停多久才触发」
 *   （那是浏览器的实现细节），只能是「源码里还有没有把地址交给载体的地方」。
 */
const mountIframe = ref<boolean>(shouldMountIframe(view.html))

/* ------------------------------------------------------------------ *
 * 容器侧判据：卡片自己有多宽（**不是窗口有多宽**）
 * ------------------------------------------------------------------ */

/**
 * 舞台的**宽度**下限（px）：`.anim` 的内联宽度低于它就不挂 iframe，改「文字要点 + 全屏入口」。
 *
 * ★ 这个数怎么来的（不是拍的）：iframe 里是**外壳 + 画布**两段，宽度这条轴上：
 *   · **外壳**（标题 20px / 字幕 15px / 步骤条）自己要 ~340px 才放得下 —— 低于 340px
 *     外壳就被裁，画布拿到 0 高 → **白屏**（本仓明令禁止的那一种）；
 *   · **画布**（`flex: 1 1 auto`）宽度掉到 480px 以下时已经小到读不清
 *     （节点标签落到 10px 上下，与 P2-3 修掉的「肉眼 7–8px」是同一类毛病）。
 *   340 是「不许再窄」的硬底、480 是「还读得清」的下限 —— 取 480。
 * ⚠️ 量的是**卡片**（`.anim`）而不是 iframe：卡身还有内边距，iframe 实际比它再窄三十来像素，
 *   所以这条判据**偏保守**。保守是对的方向：宁可早一步换成文字要点，
 *   也不给学生一个字小到读不了的舞台。
 * ⚠️ 与 `--k12-anim-min: 480px` **同值但不是同一个数**：那是舞台的**高度**下限
 *   （缩放刚好触到宽度上限的那一档），这是**宽度**下限。改一条别顺手同步另一条。
 */
const STAGE_MIN_WIDTH_PX = 480

/**
 * `.anim` 当前的内联宽度（px；0 = 还没量到过）。
 *
 * 只用于 `data-*` 读数（排障时能一眼看出「当时卡片多宽」），判据本身在 {@link roomForStage}。
 */
const containerWidth = ref<number>(0)

/**
 * 容器放不放得下舞台。
 *
 * ★ **初始为 `true`**：还没量到时按「放得下」处理 —— 那正是本次改动之前的行为。
 *   量不到（卡片还没上屏 / 被 KeepAlive 摘走 / 祖先隐藏）不该把动画变成文字。
 *   量到了才按 {@link STAGE_MIN_WIDTH_PX} 判。
 */
const roomForStage = ref<boolean>(true)

/**
 * ★★ 窄容器态：载荷本来能播（`html` 非空），但卡片太窄 —— **不挂 iframe**，
 *    改「文字要点 + 全屏看动画」。全屏后容器变宽，会自动把 iframe 重新挂上
 *    （见 {@link mountStage}，**不能因为窄就不给出口**）。
 * ★ 回看态（{@link restoredSnapshot}）**不走这一支**：它不是「放不下」，而是「不重播」，
 *   两者给学生的话不一样（一句是「点全屏就能看」，一句是「想要新的就重做」）。
 */
const narrow = computed<boolean>(
  () => mountIframe.value && !roomForStage.value && !restoredSnapshot.value
)

/**
 * 真的挂 iframe：载荷有 HTML **且**容器放得下 **且**不是回看态。
 *
 * ★ 模板的 `v-if` 与挂载/卸载路径**共用这一个判据** —— 两处各判一次的话，
 *   「界面上显示的」与「宿主以为的」迟早会对不上（那正是白屏与空转的温床）。
 * ★★ 第三个判据（回看态）加在**这里**而不是 `mountIframe` 那一行：那一行是
 *   「一次性地址不许绑回 iframe」那条纪律的抓手（`tests/animation-extension.test.ts` ②
 *   与变异 60 钉着它的字面写法），**不能碰**。回看不挂沙箱是**展示策略**，不是「能不能播」——
 *   放在可见性判据里语义也更准，`mountIframe` 保留原义（载荷本身能不能播）。
 */
const stageVisible = computed<boolean>(
  () => mountIframe.value && roomForStage.value && !restoredSnapshot.value
)

/** 是否已进入降级视图（文字讲解）。 */
const degraded = ref<boolean>(false)
/** 演示模式的沙箱事件（渲染进程独有；主进程看不到 iframe 与 Worker）。 */
const diagnostics = useDiagnosticsStore()
/**
 * 降级的可读原因（**只进 `data-*` 属性**，不摆给学生看 —— 学生只该看到「能动/不能动」）。
 * 例：「沙箱在 5 秒内没有就绪（payloadId=xxxxx）」；这类内部细节（含 payloadId）留在这里，
 * 由 CDP 脚本（`scripts/verify-ui.mjs` 一类）读 `[data-degrade-reason]` 做断言。
 */
const degradeReason = ref<string>('')
/** 降级气泡上给学生看的**固定中文**（不随原因变化，也不含任何内部标识）。 */
// ★ 文案口径（评审）：旧句「动画没能加载，已用文字讲解」读起来像一句**故障通告**
//   （"没能加载"是系统的口径，不是学生关心的），而且听不出"我现在能做什么"。
//   新句先说清楚**现在有什么**（文字讲解已经把这件事讲清楚了），再说**可以怎么办**
//   （让智团团换个说法）—— 降级不是坏消息，只是换了种讲法。
// ⚠️ 页面（`views/Animation.vue`）的同一句按报告 C15 改短成「动画没播出来，先看文字要点。」，
//   这里**故意不改**：卡片上没有「再放一次」这类按钮，这句里的「想换个说法就问智团团」
//   是本卡片降级态**唯一**的下一步。两处**不是**同一个组件的两份实现，别顺手统一 ——
//   统一之后卡片会变成「只说坏消息、不给下一步」。
const DEGRADED_NOTICE_TEXT = '这段动画这次没能播出来，下面这段文字已经把要点讲清楚了；想换个说法就问智团团。'
/**
 * **窄容器态**给学生看的那句（与上面那句是两回事，别合并）。
 *
 * 判据不同：上面那句是「动画没播出来」（真的没播成），这句是「这里放不下」
 * （动画好好的，只是这块地方太窄）—— 说成"没播出来"会让学生以为动画坏了，
 * 而它点一下全屏就能看。
 * ★ 先给**出口**再给解释：这句的落点是下面那颗「全屏看动画」，
 *   两个词（窄 / 全屏）学生都读得懂，不带任何内部说法。
 * ⚠️ 不用破折号连接句子（`student-view-discipline.test.ts` 的「破折号专项」盯着）：
 *   两句短句，各自说完一件事。
 */
const NARROW_NOTICE_TEXT = '这里太窄了，动画放不下。点下面的按钮，全屏看动画。'

/**
 * **回看态**给学生的那句（与上面两句又是两回事，别合并）。
 *
 * 判据不同：这句是「动画是当时做的，现在不重播」—— 既不是坏了（不能照抄降级那句），
 * 也不是放不下（不能照抄窄容器那句）。它要说清两件事：当时那份还在，想要新的怎么要。
 * ★ 修复的是用户实测的观感：回看历史时旧动画被**当现场重演**一遍，学生会以为自己
 *   刚点过什么，其实那只是「当时那一遍」的记录。
 * ★ 不用破折号（`student-view-discipline.test.ts` 的破折号专项盯着）：两句短句各说一件事。
 */
const RESTORED_NOTICE_TEXT = '这段动画是当时生成的，回看不会重播。想现在再看，可以重新生成一段。'
/** 沙箱阶段（`loading` 时显示加载提示，而不是一块空白）。 */
const phase = ref<'loading' | 'ready' | 'degraded'>('loading')
const progress = ref<number>(0)
const expanded = ref<boolean>(false)

const iframeEl = ref<HTMLIFrameElement | null>(null)
const host = ref<AnimationSandboxHost | null>(null)

const iframeAttrs = buildIframeAttributes()

/**
 * 卡片上的状态文案（学生看到的）。
 *
 * ★ 窄容器态单列一句：那时**没有**沙箱在跑，说「动画加载中…」是在骗人
 *   （而且它会一直停在这句上 —— iframe 根本没挂）。它也不是「降级」：
 *   动画没坏，只是这块地方放不下。
 */
const statusText = computed(() => {
  // ★ 回看态排在最前：它既不是降级也不是窄，而 `phase` 会一直停在 loading（没有沙箱在跑）——
  //   不先判它，胶囊就会显示「动画加载中…」，那是在等一个永远不会来的东西。
  if (restoredSnapshot.value) return '回看当时那一份'
  if (degraded.value) return '已切换为文字讲解'
  if (narrow.value) return '这里放不下动画'
  if (phase.value === 'ready') return '动画已就绪'
  return '动画加载中…'
})

/**
 * 要点区那一句说明：三态各有各的说法（降级 / 回看 / 窄容器）。
 *
 * ★ 收成一个 computed 而不是在模板里写三元：那个三元的括号一旦写错，
 *   错的是**给学生看的话**，而不是会当场抛错的逻辑。
 */
const fallbackNoticeText = computed<string>(() =>
  degraded.value
    ? DEGRADED_NOTICE_TEXT
    : restoredSnapshot.value
      ? RESTORED_NOTICE_TEXT
      : NARROW_NOTICE_TEXT
)

/** 进度百分比（整数，避免尾数抖动）。 */
const progressPercent = computed(() => `${Math.round(progress.value * 100)}%`)

/**
 * 是否走**托管地址**（票 16 的一次性 nonce 路径）。
 *
 * ★★ 为什么需要这个开关（实测发现的真实缺陷）：
 *   托管地址带的是**一次性 nonce，TTL 只有 120 秒**（`app/routes/resources.py`）。
 *   一旦 iframe 重新加载它（应用重启后回看历史、组件被重建），后端会拒收
 *   （日志里 `动画资源被拒 … 原因=used / expired`），而**载荷里明明还躺着完整的内联 HTML**。
 *   旧实现把这种失败直接当终态 → 学生看到「动画没能加载，已用文字讲解」，
 *   动画白做了一次。现在改成：托管路径失败**先回退内联 HTML 再试一次**，
 *   只有连内联都没有时才是真降级。
 */
/** ★ 上面注释解释了为什么本卡片**没有** `useHosted` 这种开关：
 *    内联是唯一数据源，也就没有「两个数据源之间切换」可言。 */

function goDegraded(reason: string): void {
  if (degraded.value) return
  degraded.value = true
  degradeReason.value = reason
  phase.value = 'degraded'
  // ★ 演示模式的沙箱事件（渲染进程独有）：5 秒没就绪 / 沙箱自报错误 → 整段降级为文字。
  //   这一条正是「绝不白屏」那条纪律的可观测证据。
  diagnostics.noteSandbox({ animationReadyTimeout: /5 秒内没有就绪/.test(reason) })
  // 拆掉 iframe：它已经不可用了，留着只会占内存（也可能继续发消息）。
  // ★ `mountIframe = false` 之后 `stageVisible` 也是 false —— 卸载走**同一条**路径
  //   （`unmountStage` 会把 window 监听与宿主一起收走），这里不再自己写一遍。
  //   降级是**终态**：`mountIframe` 一旦置 false，后续容器变宽也不会把沙箱挂回来。
  mountIframe.value = false
  unmountStage()
}

/**
 * 挂载时的一次性通知（保持 `handleFailure` 这个名字：两个失败入口都走它）。
 *
 * ⚠️ **不再有「切换数据源」那条分支**（见 {@link mountIframe} 的说明）：
 *   内联是唯一数据源，所以失败 = 没救了 = 降级成文字讲解（绝不白屏）。
 *   原来的 `useHosted=false / fellBackToInline / buildHost()` 三步已删 ——
 *   它存在的前提是「托管地址可用」，而那个地址一旦落进会话就已经是死地址。
 */
function handleFailure(reason: string): void {
  goDegraded(reason)
}

function buildHost(): AnimationSandboxHost {
  const instance = new AnimationSandboxHost({
    payloadId: payloadId.value,
    srcdoc: view.html || undefined,
    onReady: () => {
      phase.value = 'ready'
    },
    onProgress: (value) => {
      progress.value = value
    },
    onTimeout: (id) => {
      // ★ 5s 没 ready：发过 timeout 之后走降级视图（**绝不白屏**）
      handleFailure(`沙箱在 5 秒内没有就绪（payloadId=${id}）`)
    },
    onError: (message) => {
      handleFailure(`沙箱自报错误：${message || '(无说明)'}`)
    }
  })
  return instance
}

/* ------------------------------------------------------------------ *
 * 挂载 / 卸载：**按需**，不是 `onMounted` 里的一次性动作
 * ------------------------------------------------------------------ */

/** `.anim` 的根元素（ResizeObserver 观测它 —— 宽度判据量的是**卡片自己**）。 */
const rootEl = ref<HTMLElement | null>(null)
// ★ 光效**复用这一个 ref**：一个元素只允许挂一个 ref 属性，而 rootEl 已被
//   ResizeObserver 占用 —— 再声明一个 rootRef 就得改写上面那条观测链，收益为零。
useCardShine(rootEl)
/** 容器宽度观测器（`onBeforeUnmount` 里 `disconnect`，不留下观测）。 */
let resizeObserver: ResizeObserver | null = null
/** 待办的那次「重新量一次」（同一轮里的多次触发合并成一次；卸载时清掉）。 */
let measureHandle: ReturnType<typeof setTimeout> | null = null

/**
 * 量一次 `.anim` 的宽度，更新容器侧判据。
 *
 * ★★ 为什么不看 `window.innerWidth`：这个缺陷的形态正是「窗口够宽、卡片被挤窄」——
 *   实测 1024 窗口 + 左右两个侧栏都开时，固定列吃掉 800px，主列只剩 224px、卡片 136px，
 *   而**窗口宽度一点问题都没有**。会不会被挤坏只取决于卡片自己的宽度，所以量它。
 *
 * ★ 宽度**只有这一个来源**：`onMounted` 先量一次，之后每次 ResizeObserver 回调都走这里
 *   （两处各量各的，迟早会分叉）。量的是边框盒，与 CSS 容器查询的 `100cqw` 差 1–2px
 *   边框，对阈值判据没有影响。
 */
function measureStageRoom(): void {
  const width = rootEl.value?.getBoundingClientRect().width ?? 0
  // ★ 量不到（还没上屏 / 被 KeepAlive 摘走 / 祖先 display:none）→ **保持上一次的判定**。
  //   把 0 当成「窄」的后果是：切到设置页再回来，动画被判成窄而不挂 ——
  //   而本卡片留在 KeepAlive 里的意义恰恰是「切走再回来，进度还在」。
  if (!(width > 0)) return
  containerWidth.value = Math.round(width)
  roomForStage.value = width >= STAGE_MIN_WIDTH_PX
}

/**
 * 把 {@link measureStageRoom} 排到**本轮渲染之后**再跑（同一轮的多次触发合并成一次）。
 *
 * ★ 为什么不在 ResizeObserver 的回调里直接量、直接改判据（真机探针实测）：
 *   改判据会让卡片在**同一个交付周期**里换高度（舞台 ≈658px ↔ 文字要点 ≈544px），
 *   而被观测的就是这个元素 —— Chromium 判定成「回调里又改了被观测元素的尺寸」，
 *   控制台记一条 `ResizeObserver loop completed with undelivered notifications`（实测 3 条）。
 *   挪到一个宏任务里，尺寸变化就落到下一次交付，通知按正常路径送达。
 * ⚠️ 这条计时器也要在卸载时清掉（与宿主的 ready 计时器同样对待）。
 */
function scheduleMeasureStageRoom(): void {
  if (measureHandle !== null) return
  measureHandle = setTimeout(() => {
    measureHandle = null
    measureStageRoom()
  }, 0)
}

/**
 * 挂上沙箱（**幂等**）：建宿主 + 收窗口消息 + `attach`（`attach` 才起 5 秒计时）。
 *
 * ★★ 为什么挂载要收敛成这一条路径，而不是 `onMounted` 里做完就算：
 *   卡片会在**两种容器宽度**之间来回 —— 侧栏开合、点「全屏看」、收起全屏。
 *   窄容器不挂 iframe，那么"后来变宽了"就必须**补挂**；而变宽这件事只发生在挂载之后
 *   （ResizeObserver 报出来的），`onMounted` 那个时机早过去了 —— 不改的话，
 *   全屏后容器明明够宽，学生看到的还是一片文字要点（本 bug 的关键就在这）。
 *   所以判据是 {@link stageVisible}，由下面的 `watch` 驱动；`onMounted` 只负责**首次**。
 */
function mountStage(): void {
  if (host.value || !stageVisible.value) return
  // 新建的沙箱要从「加载中」重新走一遍：进度归零、阶段归 loading
  //（窄 → 宽 时 iframe 元素已经不在 DOM 里，动画本来就得从头播）。
  progress.value = 0
  phase.value = 'loading'
  host.value = buildHost()
  window.addEventListener('message', onWindowMessage)
  if (iframeEl.value) host.value.attach(iframeEl.value)
}

/**
 * 拆掉沙箱（**幂等**）：移监听 + `dispose()`（清掉 ready 计时器）。
 *
 * ★★ 必须成对，否则会出一个很难查的假降级：iframe 从 DOM 里摘掉之后，宿主的 5 秒计时器
 *   还在跑 —— 时间一到它会走 `onTimeout` → `goDegraded`，于是卡片明明只是**变窄了**，
 *   学生却看到「已切换为文字讲解」，而且再也回不来（降级是终态）。
 *   `dispose()` 是沙箱宿主自带的清理口（`sandbox/iframe-host.ts`），本层只管调它。
 * ⚠️ 代价（明说）：窄回去再变宽，动画是**从头**播的 —— iframe 元素已经不在了，进度留不住。
 *   要"进度不丢"就只能留一个看不见的 iframe 在后台跑，那正是本改动要避免的。
 */
function unmountStage(): void {
  window.removeEventListener('message', onWindowMessage)
  host.value?.dispose()
  host.value = null
  // 没有沙箱在跑了：阶段退回「加载中」（下次挂上会重新走到 ready）。
  // ⚠️ 降级是终态：那时上面已经写着 'degraded'，不许被这里覆盖。
  if (!degraded.value) phase.value = 'loading'
}

/** iframe 的 `load`：交给宿主（载入 ≠ 就绪，就绪由 `ready` 消息定义）。 */
function onIframeLoad(): void {
  host.value?.handleLoad()
}

/** 窗口消息 → 宿主（来源与 payload_id 的校验都在宿主里）。 */
function onWindowMessage(event: MessageEvent): void {
  host.value?.handleMessage({ source: event.source, data: event.data })
}

function play(): void {
  if (!host.value?.post('play')) goDegraded('播放指令没有发出去（沙箱未就绪）')
}

function pause(): void {
  host.value?.post('pause')
}

function replay(): void {
  progress.value = 0
  if (!host.value?.post('replay')) goDegraded('重播指令没有发出去（沙箱未就绪）')
}

function toggleExpand(): void {
  expanded.value = !expanded.value
  // 全屏只是换容器：同一个 iframe 元素被 Vue 移动过去（`<Teleport>` 用了同一个 vnode，
  // 不会重建），所以动画不会从头开始。
  // ★ 容器侧的判据不用在这里手动改：全屏后 `.anim` 变成 `position: fixed; inset: 24px`
  //   （宽度 = 视口宽 - 48），ResizeObserver 下一帧就会报一次 → 判据跟着变。
}

onMounted(() => {
  // ★ 回看态：不量容器、不建宿主、不注册观测 —— 这一态根本不挂沙箱
  //   （`stageVisible` 恒为 false），走到底只会白留一个 ResizeObserver。
  if (restoredSnapshot.value) return
  // 载荷本身就是降级产物（编排层给的 `html` 为空）：直接进降级视图
  if (!mountIframe.value) {
    degraded.value = true
    phase.value = 'degraded'
    degradeReason.value = view.degradeReason ?? '这次没有可播放的动画（已用文字讲解顶上）'
    return
  }
  // ★ 先**量一次**再决定挂不挂：`onMounted` 跑在「打完补丁、还没上屏」那一刻，
  //   所以窄卡片第一次上屏就是文字要点，不会先闪一个被挤扁的 iframe。
  measureStageRoom()
  // 之后交给 ResizeObserver：侧栏开合 / 点全屏（`inset: 24px`）/ 窗口缩放都会报一次。
  resizeObserver = new ResizeObserver(() => scheduleMeasureStageRoom())
  if (rootEl.value) resizeObserver.observe(rootEl.value)
  // 首次挂载（容器够宽时）：与后面每次"变宽"走同一条路径（幂等）
  mountStage()
})

/**
 * 卸载：移除 window 监听、拆掉宿主、停止观测（**成对清理**，不留监听器与计时器）。
 *
 * ★ 本卡片处在 `App.vue` 的 `<KeepAlive>` 里（切到设置页再回来不该丢掉动画进度）：
 *   切走触发的是 `onDeactivated`，这里**不处理**它 —— 正因为监听器与宿主一直活着，
 *   切回来时进度与 ready 状态才还在；`onMounted` 也只跑一次，所以监听器不会重复注册。
 *   真正的卸载（卡片被移除 / 应用退出）仍会走到这里。
 *   ⚠️ KeepAlive 摘走时元素是 detach 的，ResizeObserver 可能报一个 0 宽 ——
 *      `measureStageRoom()` 会**忽略**它（保持原判据），所以切走再回来不会把动画拆掉。
 */
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (measureHandle !== null) clearTimeout(measureHandle)
  measureHandle = null
  unmountStage()
})

/**
 * ★★ 挂载/卸载的**唯一驱动**：`stageVisible`（载荷有 HTML 且容器放得下）。
 *
 *   变宽（侧栏收起 / 点全屏 / 窗口拉大）→ 补挂：iframe 重新挂上，动画可播；
 *   变窄（侧栏打开 / 收起全屏）→ 拆掉：`dispose()` 收走 5 秒计时器
 *   （不收的话它迟早在窄卡片上报一次超时，把卡片打成降级）。
 *
 *   `flush: 'post'`：等 DOM 补丁打完再动 —— 那时 `iframeEl` 已经指向真的 iframe 元素，
 *   `attach()` 当场起计时；拆的时候也保证元素已经摘掉。
 *   ⚠️ 降级态不会被它复活：`goDegraded` 把 `mountIframe` 置成 false，`stageVisible`
 *     就一直是 false（`mountStage` 里还有一道 `stageVisible` 守卫）。
 */
watch(
  stageVisible,
  (visible) => {
    if (visible) mountStage()
    else unmountStage()
  },
  { flush: 'post' }
)

// iframe 元素在「收起 → 全屏」时会被移动，但 `ref` 指向的还是同一个元素；
// 这里只在挂载时机变化时重新 attach（保证超时计时器一定被起上）。
watch(iframeEl, (element) => {
  if (element && host.value) host.value.attach(element)
})
</script>

<template>
  <!-- ★ 光效挂载点：静态 class 一个字都不能动（card-structure 守卫逐个钉着
       class="k12-card anim"），所以 k12-shine 走下面 :class 叠加。 -->
  <article
    ref="rootEl"
    class="k12-card anim"
    :class="{ 'anim--expanded': expanded, 'anim--degraded': degraded, 'k12-shine': true }"
    data-testid="animation-card"
    :data-degraded="String(degraded)"
    :data-phase="phase"
    :data-narrow="narrow ? '1' : null"
    :data-payload-id="payloadId"
    :data-restored="restoredSnapshot ? '1' : null"
  >
    <CardHeader>
      <template #title>
        <span class="title">动画讲解</span>
      </template>
      <template #meta>
        <span v-if="view.concept" class="chip" data-testid="animation-concept">{{ view.concept }}</span>
        <!-- ── 来源两态切换（内置 / 我的）──────────────────────────────────
             原来是**一颗只读的来源标签**（内置模板 / 即时生成）：学生看到它，却改不了它。
             现在它是两个可点的按钮 —— 「内置」是本张卡片带来的那一份，「我的」是动画库里
             存过的那一份（没有时按钮不可点，而不是点了报错）。
             ⚠️ 选中态的配方与 `views/Animation.vue` 的 `.tpl--on`、`views/Study.vue` 的
               `.tab--on` **一致**（accent-soft 底 + accent-border 描边 + accent-ink 文字）：
               同一个「我在看这一份」的意思，在三处必须是同一个长相。 -->
        <span class="src" role="group" aria-label="动画来源">
          <button
            type="button"
            class="src__btn"
            :class="{ 'src__btn--on': source === 'builtin' }"
            :aria-pressed="source === 'builtin'"
            data-testid="animation-source-builtin"
            @click="emit('switch-source', 'builtin')"
          >内置</button>
          <button
            type="button"
            class="src__btn"
            :class="{ 'src__btn--on': source === 'mine' }"
            :aria-pressed="source === 'mine'"
            :disabled="!hasSaved"
            :title="hasSaved ? '看我保存过的那一份' : '这一份还没有保存过'"
            data-testid="animation-source-mine"
            @click="emit('switch-source', 'mine')"
          >我的</button>
        </span>
        <span v-if="gradeChip" class="chip" data-testid="animation-grade">{{ gradeChip }}</span>
        <span
          class="chip"
          :class="degraded ? 'chip--warn' : phase === 'ready' ? 'chip--ok' : ''"
          data-testid="animation-status"
        >{{ statusText }}</span>
        <span v-if="view.source === 'template' && phase === 'ready'" class="chip tool" data-testid="animation-duration">
          {{ (view.durationMs / 1000).toFixed(1) }}s
        </span>
      </template>
      <template #actions>
        <!-- 演示档专用：就地看「沙箱有没有在 5 秒内就绪 / 有没有降级为文字」 -->
        <DiagPeekButton />
        <!-- 对象级动作（这张卡自己的）：按当前学段重画 / 在线生成 / 全屏看 -->
        <button
          type="button"
          class="btn"
          :disabled="generating"
          data-testid="animation-redraw"
          v-if="canRedraw"
          @click="emit('redraw')"
        >按当前学段重画</button>
        <button
          type="button"
          class="btn btn--primary"
          :disabled="generating"
          data-testid="animation-generate"
          @click="emit('generate')"
        >{{ generating ? '正在做…' : '在线生成' }}</button>
        <button
          v-if="!restoredSnapshot"
          type="button"
          class="btn btn--ghost"
          data-testid="animation-expand"
          :title="expanded ? '回到对话里' : '放大到全屏看（卡片里是缩略，字会小一些）'"
          @click="toggleExpand"
        >
          {{ expanded ? '收起' : '全屏看' }}
        </button>
      </template>
    </CardHeader>

    <CardBody>
      <!-- 父组件给的提示（没做成 / 已经去问了）：**只说学生能感知的事**，
           内部原因（哪个环节失败）留在控制台，不摆在这里。 -->
      <p v-if="notice" class="anim__notice" data-testid="animation-notice">{{ notice }}</p>

      <!-- ── 可播放的沙箱 ───────────────────────────────────────────
           `stageVisible` = 载荷有 HTML **且** 容器放得下（判据见 script 里同名 computed）。
           窄容器走下面的文字要点 —— 全屏后容器变宽，ResizeObserver 报一次就会挂回来。 -->
      <div v-if="stageVisible" class="anim__stage">
      <!-- ── 可播放的沙箱（**只用内联 `srcdoc`**，理由见 script 里 mountIframe 的注释）──
         ⚠️ 不要给 `:src` 或把一次性 nonce 地址绑上来：载荷里的地址是**持久化的**，
         而 nonce 单次消费 + TTL 120s，任何第二次加载都会拿到 403 JSON 被渲染给学生。
         `data-resource` 固定为 `inline`（CDP/探针据此确认走了哪条路）。 -->
      <iframe
        ref="iframeEl"
        class="anim__frame"
        :sandbox="iframeAttrs.sandbox"
        :referrerpolicy="iframeAttrs.referrerpolicy"
        :srcdoc="view.html"
        title="动画演示"
        data-testid="animation-frame"
        :data-sandbox="SANDBOX_ATTRIBUTE"
        data-resource="inline"
        @load="onIframeLoad"
      />

      <!-- 加载中：给一块有说明的占位，不要让学生盯着一片空白 -->
      <p v-if="phase === 'loading'" class="anim__loading" data-testid="animation-loading">
        动画加载中…（超过 5 秒会自动切换成文字讲解）
      </p>

      <div class="anim__controls" data-testid="animation-controls">
        <button class="btn btn--primary" type="button" data-testid="animation-play" @click="play">播放</button>
        <button class="btn" type="button" data-testid="animation-pause" @click="pause">暂停</button>
        <button class="btn" type="button" data-testid="animation-replay" @click="replay">重播</button>
        <span class="anim__progress" data-testid="animation-progress">
          进度 <span class="metric">{{ progressPercent }}</span>
        </span>
      </div>
    </div>

      <!-- ── 文字要点（**所有不挂 iframe 的情形共用这一块**）──────────────────
           · `degraded`：真的没能播（载荷本身没有 HTML / 沙箱 5 秒没就绪 / 沙箱自报错误）；
           · `narrow`：动画好好的，只是这块地方**放不下**（卡片被两个侧栏挤窄）；
           · `restoredSnapshot`：回看恢复的历史卡片，当时那一遍**不重播**（见 script 里的说明）。
           三者都**绝不白屏**，都在这里给出「要点 + 下一步」——
           区别只在下面那句说明、以及给的是「全屏看动画」还是「重新生成一段」。 -->
      <div v-else class="anim__fallback" data-testid="animation-fallback">
        <p class="anim__fallback-text" data-testid="animation-fallback-text">{{ view.fallbackText }}</p>
        <!-- ★ 这里原来还有一张 `<img class="anim__fallback-img">`：主进程按**同一段文案**
             生成的静态 SVG（正文截 34 字，见 `src/main/agent/extensions/animation.ts` 的
             `buildInlineFallbackImage`）。它与上面那段完整文案说的是同一件事，现在整段删掉 ——
             降级说明只留一处（报告 1.8 / 4.3）。主进程那段生成照旧保留：载荷契约那一侧
             还有别的消费者，要删得先确认；本卡片只是不再引用 `view.fallbackImage`。 -->
        <!-- 说明这一块为什么在放文字而不是动画：文案随状态变，节点只有一个
             （`data-degrade-reason` 老实留空，只有真降级才写内部原因；
              窄容器态把当时的宽度记在 `data-narrow-width` 上，排障时一眼能看出量到了多少）。 -->
        <p
          class="anim__reason"
          data-testid="animation-degrade-reason"
          :data-degrade-reason="degraded ? degradeReason || null : null"
          :data-narrow-width="narrow ? containerWidth : null"
        >
          {{ fallbackNoticeText }}
        </p>
        <!-- ★★ **窄容器态的出口**（本改动的关键，不能省）：全屏后 `.anim` 变成
             `position: fixed; inset: 24px`（宽度 = 视口宽 - 48），ResizeObserver 报一次
             → 判据翻过阈值 → iframe 自动挂上、动画当场可播。
             卡头那颗「全屏看」在窄卡片里可能已经被挤到第二行，学生不一定扫得到 ——
             所以要点下面再给一颗（同一件事两个入口）。
             `degraded` 时**不给**：那种卡片本来就没有能播的动画，摆一颗「全屏看动画」
             等于把学生支到空处（与上面 `DEGRADED_NOTICE_TEXT` 的口径一致）。 -->
        <button
          v-if="narrow"
          type="button"
          class="btn btn--primary anim__expand-cta"
          data-testid="animation-expand-inline"
          @click="toggleExpand"
        >
          {{ expanded ? '收起' : '全屏看动画' }}
        </button>

        <!-- ★★ **回看态的出口**：当时那份不重播，但学生想现在再看是正当需求 ——
             走既有的生成入口（`emit('generate')`）现场做一份新的。它消费的是**新签发**的
             凭据，与历史里那份无关：绝不复用旧凭据来「让历史能播」（那是红线，见 D-084）。
             与降级态的区别：降级是「这次没得看」，回看是「那一次已经看过了」，所以这里给按钮。 -->
        <button
          v-if="restoredSnapshot"
          type="button"
          class="btn btn--primary anim__restore-cta"
          :disabled="generating"
          data-testid="animation-restore-generate"
          @click="emit('generate')"
        >
          {{ generating ? '正在做…' : '重新生成这段动画' }}
        </button>
      </div>
    </CardBody>
  </article>
</template>

<style scoped>
.anim {
  /* 卡片皮肤（白面 / 边框 / 圆角 / 投影）唯一来源 = base.css 的 `.k12-card`；
   * 三段结构的内边距与底色 = `.k12-card-head/-body/-foot`。 */
  min-width: 0;
  /* ★ 本卡片自己当**容器查询的容器**（下面 `.anim__frame` 之后那段 `@container` 要用）：
   *   会不会被挤成"竖直细条"只取决于**卡片自己的宽度** —— 同一个 1024 窗口里，
   *   两个侧栏都开时卡片是 136px、都收起时是 612px，视口宽度分不开这两种情况。
   *   `inline-size` 只把行内轴从内容里摘出来，卡片高度照旧由内容决定。 */
  container-type: inline-size;
  /**
   * ★★ 舞台高度 = **按比例 + 下限 + 上限**，不是定值。
   *
   * 三个数为什么是这三个（**都有实测**，量法见下）：
   *
   *   - `--k12-anim-ratio: 720 / 420`：**舞台自己的坐标系比例**（`_shared/runtime.js`
   *     的 `STAGE_WIDTH × STAGE_HEIGHT`）。此前用的是 `16 / 9`（= 1.778），比舞台**更扁**
   *     —— 同样的宽度下它给的高度更少，等于替舞台又缩了一刀。
   *   - `--k12-anim-min: 480px`：卡片形态的**物理上限就在宽度上**。
   *     舞台是 `preserveAspectRatio: xMidYMid meet`，缩放 = `min(宽/720, 高/420)`；
   *     而对话栏里卡片内容宽约 600px ⇒ 宽度侧的上限是 `600/720 ≈ 0.83×`，
   *     高度给得再多也不会更清楚。
   *     ★ 实测（iframe 高 → 缩放 → **节点标签**在屏上的有效像素，标称 16px）：
   *     354px → 0.548× → **8.8px**（这就是真机报的「肉眼 7–8px」）；
   *     420px → 0.705× → 11.3px；**480px → 0.831× → 13.3px（触顶）**。
   *     所以 480 是「刚好把高度从瓶颈里拿掉」的值 —— 再往上只加留白、不加字号。
   *   - `--k12-anim-max: 560px`：更宽的窗口（最大化时对话栏可到 900px）宽度上限更高，
   *     允许它继续长到 560；那时缩放 1.039×、节点标签 16.6px（已到标称值）。
   *     再高就该点「全屏看」了。
   *
   * ★ 修的是什么（P2-3 实测）：旧值 `min-height: 300px` + `16 / 9` 让 630px 宽的卡片
   *   只拿到 354px 高 ⇒ 缩放 **0.548×** ⇒ 标称 16px 的**节点标签**在屏上只有 **8.8px**
   *   （小学生读不了，而同一模板在动画页是清楚的）。这不是「看着有点小」，
   *   是「卡片形态下盯住每一步」这个用法直接不成立。
   *   ⚠️ 别把 min 改回 300：那正是 8.8px 的成因（守卫 `animation-card-stage.test.ts` 盯着）。
   *
   * ★★ 为什么不能靠调舞台里的字号令牌（`--k12-fs-node`）解决：那是 720×420 坐标系里的
   *   布局预算，改它要连生成期几何校验与全库资产一起重跑；而且卡片与动画页共用同一份产物。
   *   「卡片里读到 18px」在数学上不可能（600px 宽的容器里缩放封顶 0.83×）——
   *   所以卡片定位是**缩略**，要逐帧看清请点卡头的「全屏看」（那才是给「盯住每一步」用的模式）。
   *
   * 代价（明说）：同屏多张动画卡片的高度随宽度一起缩放，不再每张都是同一个 300px ——
   * 这是想要的（内容放得下优先于绝对等高）。
   */
  --k12-anim-ratio: 720 / 420;
  --k12-anim-min: 480px;
  --k12-anim-max: 560px;
}

.anim--degraded {
  border-style: dashed;
  background: var(--k12-surface-2);
}

.anim--expanded {
  position: fixed;
  inset: 24px;
  z-index: 50;
  overflow: auto;
  /* 全屏是**浮层**（压在所有东西之上）→ float 档投影，而不是卡片那一档 */
  box-shadow: var(--k12-shadow-float);
}

/* ── 状态胶囊（角标语义）─────────────────────────────────────────────
 * ⚠️ 全局 `.chip` / `.chip--*` 已随新设计系统移除（`base.css` 只剩材质层与
 *   排版层）。模板里的类名照旧写着，于是这些胶囊一直无样式渲染 ——
 *   自带一份，配方与同目录的 `ProgressCard.vue` 一致（同一叠卡片必须同族）。
 * `.chip` 必须在 `.tool` **之前**：`.tool` 用同权重选择器覆盖字重与字号。 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-border);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  line-height: var(--k12-lh-ui);
}

/* 动画已就绪 */
.chip--ok {
  background: var(--k12-good-soft);
  border-color: var(--k12-good-border);
  color: var(--k12-good);
}

/* 已切换为文字讲解（沙箱超时 / 自报错误）：这是**降级** → warn 语义色
 * （「能用，但不理想」），而不是 bad —— 文字讲解仍然把知识讲到了，
 * 涂成红色会让学生以为「坏了、学不成了」。 */
.chip--warn {
  background: var(--k12-warn-soft);
  border-color: var(--k12-warn-border);
  color: var(--k12-warn);
}

/* ⚠️ `.chip--accent` 已删：那颗**只读的来源标签**被下面这个两态控件取代了
 * （学生现在能在这两份之间切换，而不是读一句别人定好的结论）。
 * 留一条没人用的规则，下一个读代码的人会以为某处还在用它。 */

/* ── 来源两态控件（内置 / 我的）────────────────────────────────────────
 * 与 `.chip` 同一档外形（同样的圆角与内边距），但它是**可点的**：
 * 两个按钮共用一层描边，中间不留缝 —— 一眼能看出「这两个里选一个」。
 * ⚠️ 不引 Element Plus（本卡片刻意只用自带的最小样式：卡片要被塞进 Markdown 消息流里，
 *    一个组件库的样式会跟着它的全局副作用一起进来）。 */
.src {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  overflow: hidden;
}

.src__btn {
  border: none;
  background: transparent;
  padding: 2px 11px;
  color: var(--k12-muted);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  line-height: var(--k12-lh-ui);
  cursor: pointer;
}

.src__btn + .src__btn {
  border-left: 1px solid var(--k12-border);
}

/* 选中态：accent-soft 底 + accent-border 描边 + accent-ink 文字。
 * 与 `views/Animation.vue` 的 `.tpl--on`、`views/Study.vue` 的 `.tab--on` 同一配方 ——
 * 「我在看这一份」这个意思在三处必须是同一个长相。 */
.src__btn--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
  color: var(--k12-accent-ink);
}

@media (hover: hover) and (pointer: fine) {
  .src__btn:hover:not(:disabled) {
    color: var(--k12-accent-ink);
  }
}

.src__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.anim__notice {
  margin-top: 10px;
  padding: 8px 11px;
  border-radius: var(--k12-r-inset);
  /* 「这次没做成 / 已经去问了」是**状态说明**而不是报错：用中性底，
   * 不涂成红色（红的留给「连文字都看不成」那种真正的失败）。 */
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
}

.title {
  /* 档位由 `.k12-card-head` 给（h3 20px）；这里只补字重 */
  font-weight: 650;
}

/* ── 卡头不许被挤爆（窄卡片里的第二处挤压）─────────────────────────────
 * `.k12-card-head`（base.css）是**不换行**的 flex 行：`[title] [meta…] [actions]`。
 * 本卡片的 meta 槽里有 5–6 段 chip（概念 / 内置·我的 / 学段 / 状态 / 时长），
 * 窄卡片下这一行放不下就整体向右溢出去 —— 被推出卡片的是**右端的对象级动作**，
 * 里面就有「全屏看」：卡片窄到看不清动画时，唯一的出路反而先被挤出可视区。
 * ★ 只覆盖**本卡片**（`.anim` 前缀 + `:deep`），不动全局 `.k12-card-head`：
 *   CardHeader 是四张卡片共用的三段结构（`tests/card-structure.test.ts` 钉着），
 *   在那里加换行等于替所有卡片改版式。宽卡片一行放得下时不产生第二行，观感不变。
 * ★ 只加**布局保护**（换行），不重写卡头的皮肤（底色 / 描边 / 内边距仍在 base.css）。 */
.anim :deep(.k12-card-head) {
  flex-wrap: wrap;
}
/* 动作组自己也要能换行：最窄档（实测 136px）连三个按钮一行都放不下，
 * 不换行就还是会横向溢出卡片（`margin-left: auto` 的右端对齐在换行后照旧生效）。 */
.anim :deep(.k12-card-head__actions) {
  flex-wrap: wrap;
}

.tool {
  font-family: var(--k12-font-mono);
  /* 时长读数这类等宽小字：meta 档（不是 ≤4 字角标，角标另走 .chip） */
  font-size: var(--k12-fs-caption);
  font-weight: 500;
}

/* ── 按钮 ────────────────────────────────────────────────────────────
 * ⚠️ 全局 `.btn` / `.btn--ghost` 已随旧样式表移除，模板里的类名一直无样式
 *   （「全屏」此前就是个没有形状的纯文字）。自带一份；全屏是描边式次要动作，
 *   配方取 `views/Animation.vue` 的 `.anim__ghost`（同族页面）。
 * 高度由 padding + line-height 决定，不钉像素。 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  cursor: pointer;
}

@media (hover: hover) and (pointer: fine) {
  .btn:hover:not(:disabled) {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
  }
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 播放是这一块的主要动作 → 填充用 accent-ink（文字色那一支），白字压上去才够对比度；
 * accent 是画得好看的浅色，配白字读不清。 */
.btn--primary {
  border-color: var(--k12-accent-ink);
  background: var(--k12-accent-ink);
  color: var(--k12-surface);
}

/* 「全屏」是卡片头右上角的**次要**动作：与 `.btn` 同一支描边样式（无色底填充）。
 * 单独立一条是因为模板里确实写着这个修饰类 —— 留一个没有对应规则的类名，
 * 下一个读代码的人会以为它被漏掉了（本文件已经因为这类「类名在、规则没了」
 * 的旧账白屏过一轮）。 */
.btn--ghost {
  background: var(--k12-surface);
  border-color: var(--k12-border);
  color: var(--k12-fg-2);
}

.anim__stage {
  position: relative;
}

.anim__frame {
  display: block;
  width: 100%;
  /* ★ 高度按比例生长（三个数与理由见 `.anim` 上的说明）——
   * 定值 300px 会把放不下的内容静默切掉（iframe 内部是 overflow:hidden）。 */
  aspect-ratio: var(--k12-anim-ratio);
  min-height: var(--k12-anim-min);
  max-height: var(--k12-anim-max);
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-inset);
  /* iframe 里的动画 HTML 按白底绘制 → 必须给**不透明**的 paper 白。
   * `--k12-surface` 在全部 18 组主题里都是 #FFFFFF，是白底的唯一来源。 */
  background: var(--k12-surface);
}

/* ── 窄容器兜底（容器查询）────────────────────────────────────────────
 * 缺陷现场（真机 + 逐宽度量测）：上面那条 `min-height: 480px` 只在**宽卡片**里成立。
 * 卡片一旦窄于约 823px（阅读栏封顶 880px，所以"卡片够宽"这件事从来不会自动成立），
 * 480 就赢过 `aspect-ratio`，盒子随宽度变小而越来越"高"——
 * 实测 136px 宽 → **136×480**（比例 0.28，学生看到的是一根竖直白条）；
 * 393px 宽（1280 窗口 + 两栏全开）→ 393×480（比例 0.82，同样是立着的）。
 *
 * ★★ 为什么不能直接写 `min-height: 0`（第一直觉，但实测是错的）：
 *   iframe 里不是"一整块画布"，而是**外壳 + 画布**：外壳（标题 20px / 字幕 15px /
 *   步骤条）是定高的 HTML，实测吃掉 129px（卡片 ≥300px 宽）、180px（224px 宽）、
 *   232px（136px 宽，标题字幕换行更多）；画布拿不到高度，`xMidYMid meet` 就改按
 *   高度侧缩放。实测（Electron 44 逐宽度量测，见提交说明）：
 *     宽 136 → 画布 103×0   ⇒ 缩放 0  → **动画整个消失**（外壳把高度吃光，还被 overflow 裁掉）
 *     宽 393 → 画布 359×100 ⇒ 缩放 0.24× → 节点字 3.8px
 *     宽 552 → 画布 519×193 ⇒ 缩放 0.46× → 节点字 7.3px
 *   而今天的 480 下限在同样宽度下是 0.143 / 0.498 / 0.72 ⇒ 节点字 2.3 / 8.0 / 11.5px。
 *   也就是说：把下限归零**不是免费的形状修复，它把字号一起换掉了** ——
 *   552px 那档正好落回 `animation-card-stage.test.ts` 说的"肉眼 7–8px"。
 *
 * ★ 所以窄档只把"固定下限"换成"按舞台比例 + 外壳开销"，并且**不超过原来的 480**：
 *     height = min(480px, 容器宽 × 420/720 + 340px)
 *   340px = 实测最坏的**外壳**开销（334px @136px 宽，用的是库里最长的标题 30 字 +
 *   最长字幕 23 字；短文案那一档只要 232px）+ 余量。逐宽度量测（短/长两版文案）的结果：
 *   · 盒子不再随变窄而越来越"高"：136px 下 480 → 419（比例 0.28 → 0.32）、224px 下 480 → 471；
 *     且**任何宽度都不会比今天的 480 更高**（算式 ≥480 时不生效：≥240px 宽完全等同今天）；
 *   · 字号一分不降：136px 及以上，画布高度都 ≥ 按比例所需（长短文案都验过），
 *     缩放与今天**逐点相等**（136 → 0.143、224 → 0.265、300 → 0.37、520 → 0.676）。
 *     `meet` 是等比缩放，画面在两种方案下**同一个尺寸**，差别只是白边变少。
 *   ⚠️ 已知代价（量过，不藏着）：容器窄到 ~104px 且碰到**最长**标题那一档时，
 *     外壳自己就要 480px —— 那时任何"把盒子变矮"的规则都会切到外壳文字（动画本来就已
 *     完全看不见，画布 0）。真正该修的是**卡片宽度**（1024 窗口 + 两个侧栏都开时，
 *     主列只剩 176px）；本卡片这一层只能做到"不把盒子拉长"。
 *
 * ⚠️ 为什么是容器查询而不是 `@media`：见 `.anim` 里 `container-type` 那段 ——
 *   同一个窗口宽度下卡片宽度可以差 4 倍多，媒体查询分不开。
 *   容器查询在 Chromium ≥105 支持（本应用 Electron 44）；万一不支持，
 *   整块规则被忽略 = 退回今天的 480 下限（不会更糟）。 */
@container (max-width: 560px) {
  .anim__frame {
    min-height: min(var(--k12-anim-min), calc(100cqw * 420 / 720 + 340px));
  }
}

/* 全屏：舞台要大（这个模式的目的就是看动画），所以这里**放开对话栏那个上限**；
 * 视口高的 70% 与原值一致，保留 640px 的兜底上限。 */
.anim--expanded .anim__frame {
  aspect-ratio: auto;
  min-height: 0;
  max-height: none;
  height: min(70vh, 640px);
}

.anim__loading {
  position: absolute;
  inset: 0 0 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  /* 加载说明是一整句给学生看的话 → 次级正文档（与 views/Animation.vue 的 `.anim__veil` 同一落点） */
  font-size: var(--k12-fs-body-sm);
  color: var(--k12-muted);
  /* 半透明遮罩：压在 iframe 之上（与 views/Animation.vue 的 `.anim__veil` 同一手法） */
  background: color-mix(in srgb, var(--k12-surface) 86%, transparent);
  border-radius: var(--k12-r-inset);
  pointer-events: none;
}

.anim__controls {
  margin-top: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.anim__progress {
  /* 旧值不在 8 档之内：进度读数是 meta → meta 档（与 views/Animation.vue 的 `.anim__time` 同一落点） */
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}

/* 进度里的百分比：同一句里「进度」是标签、数字才是值 —— 把值提出来，
 * 且数字定宽（否则 9%→10% 跳动时整行会左右抖）。 */
.metric {
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum' 1;
  font-weight: 650;
  color: var(--k12-fg-2);
}

.anim__fallback {
  margin-top: 12px;
  padding: 12px 14px;
  /* 文字讲解 = 沙箱位置的替代（卡内嵌入块）→ inset 圆角 + paper 底 */
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
}

.anim__fallback-text {
  /* 降级后的文字讲解 = 沙箱位置的替代正文 → 正文档 */
  font-size: var(--k12-fs-body);
  line-height: 1.85;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ⚠️ `.anim__fallback-img` 已删（报告 1.8 / 4.3）：那张白卡是主进程按**同一段降级文案**
 * 生成的 SVG（正文截 34 字），与上面那段完整文案重复。主进程仍在生成它（载荷契约的
 * 一部分），本卡片不再引用 —— 见 `<script>` 里的说明。这里不留空容器。 */
.anim__reason {
  margin-top: 10px;
  /* 降级气泡下的脚注 → meta 档（与 views/Animation.vue 的 `.anim__reason` 同一落点） */
  font-size: var(--k12-fs-caption);
  line-height: 1.6;
  color: var(--k12-muted-2);
}

/* ── 窄容器态里的出口按钮 ──────────────────────────────────────────────
 * 它是这一态**唯一的出路**（也是主要动作）→ 与「播放」同一支配方（accent-ink 填充），
 * 不跟卡头那颗次要动作的描边样式混。与上面那段说明留出间距（`.btn` 自己只有内边距）。 */
.anim__expand-cta {
  margin-top: 10px;
}

/* ── 回看态里的出口按钮 ────────────────────────────────────────────────
 * 与窄容器那颗同一落点与配方（这一态唯一的主要动作）：在这张卡片里再看一遍
 * 只能靠**重新生成一段**，那是新的交互 —— 不靠重播当时那一遍。 */
.anim__restore-cta {
  margin-top: 10px;
}
</style>
