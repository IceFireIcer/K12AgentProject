<script setup lang="ts">
/**
 * 对话课堂 —— **默认主界面**（打开应用落到的第一页）。
 *
 * 三种辅助形态（动画 / 编程 / 闯关）以内联卡片出现在回答里，也可以通过卡片右上角
 * 的「展开」进入各自的独立页；侧栏的「能力」分组里也能直达。所以本页是全应用的骨架屏。
 *
 * ── 与 6 事件词表的对应（**全部真实接线**）────────────────────────────────
 *   delta     → 往这一轮的正文尾部追加文字（`turn.text`）
 *   citation  → 来源行（含「教材原文」抽屉，细节来自事件的可选 `details`）
 *   payload   → 内联卡片（kind 由 Tool 名映射，见 `ipc/tool-kinds.ts`）
 *   blocked   → 该轮正文替换为 `blocked.safeText` + 撤回说明
 *   done      → 收尾：解除 streaming，允许下一条
 *   error     → 降级提示（`degraded: true` 只提示**不终结**本轮，正文还会继续来）
 * 事件名来自冻结词表；本页不解释传输层（IPC 在 preload 白名单里）。
 *
 * ★ 本页**只把文字交给 store**（`chat.send`）：发送链路是
 *   `ChatView` → `stores/chat.ts` → `window.api.sendChat(`（守卫 G7 断言只有 store 调它）。
 *
 * ── 空态：能力入口 + 建议问题 ─────────────────────────────────────────────
 * 对话是主入口，所以「这页怎么用」由空态承担（而不是顶栏上一个常驻仪表盘）。
 * 四张能力入口卡对应本项目核心范围内的四种交互；建议问题**只预填不直接发**
 * （学生永远可以改完再发）。
 *
 * ── 学段与章节：各出现一次，各在自己的位置 ────────────────────────────────
 * 学段是**全局环境**（「按什么年级的口吻讲」）→ 顶栏那一枚紧凑指示器（含手动入口），
 * 本页**不再**渲染它（同一件事出现两次就是「界面错位」本身）。
 * 章节是**这段对话在学什么** → 消息区上方那条信息条（`.chat__bar`，与「本轮对话」同一行）。
 * 对话正文不再被横幅挤掉一屏；空态里只剩**一句事实**：「当前按〈哪个年级〉的讲法回答。」
 * （还没判出来时是「先随便问两句，我就能认出你的年级。」）—— 来源（手动选中 / AI 引擎推算）
 * 不在这里复读，只在侧栏身份卡一处（2026-09-22 报告 2.1；见模板里 `.chat__hello-grade` 的说明）。
 *
 * ── 右栏折叠 ──────────────────────────────────────────────────────────────
 * ≥1024 常驻（可收），窗口更窄时（媒体查询落在 1023px 及以下）变浮层、进入该区间自动收起。
 * ★ 1024–1279 是**「平板 / 小笔记本」档：保留完整布局**（优化报告 §2.2 的明确决定，
 *   原先是 <1280 就收成图标条）。别把这里改回 1280 —— 收拢档只到窗口下限 1024，
 *   `tests/breakpoints.test.ts` 与 `tests/session-tree.test.ts` 都钉着这一点。
 * 断点判断写在 CSS 里，只在这里维护**一套**媒体查询监听（进窄屏自动收起、离开窄屏还原，
 * 但不覆盖学生自己主动关掉的选择）。
 */
import { computed, nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Activity,
  ArrowDown,
  BookMarked,
  Clapperboard,
  Clock,
  Code,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Settings2,
  ShieldAlert,
  TriangleAlert,
  Trophy
} from 'lucide-vue-next'
import ContextRail from '../components/ContextRail.vue'
import TeacherGate from '../components/TeacherGate.vue'
import MessageComposer from '../components/MessageComposer.vue'
import ChatMessage from '../components/ChatMessage.vue'
import ChapterIndicator from '../components/ChapterIndicator.vue'
import SessionList from '../components/SessionList.vue'
import { useOnBackendReady } from '../composables/useOnBackendReady'
import { useChatStore } from '../stores/chat'
import { useConfirm } from '../stores/confirm'
import { useInsightStore } from '../stores/insight'
import { useModelStore } from '../stores/model'
// ★ 与闯关页共用同一个 Pinia 单例：对话页点「去闯关练一练」取的题，
//   就是闯关页进去看到的同一批（不会两处各拉一份）。
import { useQuizStore } from '../stores/quiz'
// ★ `questionById` 是五问脚本的**唯一读取口**（`@shared/profile-tags` 的同一份常量）：
//   引导区要把「已经答过的那几问」重新渲染出来（问原文 + 学生那句），问句不许在本页另抄一份。
import { questionById, useOnboardingStore } from '../stores/onboarding'
import type { OnboardingQuestionId } from '@shared/profile-tags'
import { useProfileCardStore } from '../stores/profileCard'
import { usePanelsStore } from '../stores/panels'
import { useDiagnosticsPanel } from '../stores/diagnosticsPanel'
import { useStudentStore } from '../stores/student'
import { useTraceStore } from '../stores/trace'
import { useUiStore, type PageName } from '../stores/ui'
import { useViewModeStore } from '../stores/viewMode'
// ★ 空态**不再有学段那一行**（2026-09-30 用户裁决：去掉「当前按 XX 的讲法回答。」）——
//   学段状态在顶栏指示器与侧栏身份卡各有一处，空态这一行只是第三次复读；
//   所以 `GRADE_UNKNOWN_LABEL` 与本页也不再需要（`gradeOriginLabel` 早就不引用）。
// ★ 品牌 logo 的 URL 只有 `brand-logo.ts` 一处实现（侧栏 / 空态 / 头像共用一张图）
import { DEFAULT_LOGO_URL } from '../brand-logo'
// ★ 巩固条的动作要把「学生气泡里的那句话」与「发给模型的报文」分开承载
//   （前者是学生话、后者带指令），翻译只发生在 study/plan-request.ts 一处；
//   「quizSourceLabel」是「刚出的题」那条来源标注（与卡片头 / 个性化学习页共用同一套文案）。
import { buildQuizAskMessage, quizAskDisplayText, quizSourceLabel } from '../study/plan-request'
// ★ 来源标注要读卡片载荷里的 source 与题数 —— 走 cards/quiz.ts 的白名单投影，
//   本页不自己翻 payload（那会把「只读认识的字」这条纪律复制出第二份）。
import { readQuizCard } from '../cards/quiz'

const chat = useChatStore()
const confirm = useConfirm()
const insight = useInsightStore()
const model = useModelStore()
const quiz = useQuizStore()
const student = useStudentStore()
// ★ 工具轨迹只在「新会话」时需要写（清空）；订阅与渲染都在 ContextRail 里，
//   这里取的仍是同一个 Pinia 单例，不会出现两份状态。
const trace = useTraceStore()
// ★★ 冷启动引导（五问）与画像标签卡：取数挂在 `useOnBackendReady` 上（见 `loadOnboardingData`）。
//   这里取的与右栏 / 档案页是同一个 Pinia 单例 —— 不会出现两份状态。
const onboarding = useOnboardingStore()
const profileCard = useProfileCardStore()
/**
 * 上屏时给正文做 `{{student_name}}` 替换用的称呼（唯一出口是 `student-name.ts`）。
 * ★ 只用后端给的**脱敏显示名**（`identity.displayName`）—— 真名 `realName` 一个字都不取，
 *   它连 prompt 都不进。取不到就是空串，由 `renderStudentName` 兜成中性的「同学」。
 */
const studentName = computed(() => profileCard.identity?.displayName ?? '')
const ui = useUiStore()
// ★ 只用来给「还没配置模型」那条提示挑措辞（老师看「填什么」、学生看「找谁」）——
//   双视角纪律的落点见那条提示的注释与 `stores/viewMode.ts`。
const viewMode = useViewModeStore()

/**
 * ★★ **还没配置模型**（没填 Key）→ 空态里给一条人话提示 + 一个去设置的入口。
 *
 * 实测缺陷（2026-09-22）：此前「没配 Key」这件事**只在学生真的发出去一条消息之后**
 * 才以一种技术口吻的降级提示出现（「本机还没有配置 API Key…」）—— 学生已经把问题
 * 打完了、按下发送、等了一会儿才被告知「答不了」。而顶栏与输入条那时还显示着一个
 * 模型名，看起来像「配好了」。
 * 现在：进门就在空态里说清「现在还答不了、为什么、找谁」。
 * ★★ 2026-09-22 设计评审（C3）：末句「（下面那三样本地功能现在就能用）」已删 ——
 *   紧挨着的**四张能力入口卡**本身就是「现在能干什么」的证明，在提示里复述一遍是重复
 *   （报告 3 章的删改规则：解释机制的、复读同一件事的一律降级或删）。
 *   ⚠️ `tests/llm-unconfigured.test.ts` 里还钉着那句被删的文案（本次**未改测试**）。
 */
const needsLlmSetup = computed(() => model.readyState === 'unconfigured')

/** 去设置页（未配置时的引导；学生视角下那句话指向「老师或家长」，见模板里的两半）。 */
function goSettings(): void {
  ui.go('settings')
}

/* ── 消息列表：直接读 store（6 事件折叠的结果）──────────────────────────── */
const turns = computed(() => chat.turns)

/**
 * 真正算「一轮」的轮次 —— **有学生提问的那些**。
 *
 * ★★ 判据是「这一轮有没有学生的话」，与主进程的 `ChatRuntime.hasUserTurn`
 *   是**同一条规则**（两处都判「学生开口了没有」，不是「列表里有几条」）：
 *   · 恢复出来的「开场白」是助手先说的那条，它自己占一轮但 `userText` 为空 ——
 *     直接数 `turns.length` 会让同一段对话在切回来后从「1 轮」变成「2 轮」
 *     （实测截图里就是「1 轮」配着一个空气泡）；
 *   · 实时那一轮永远有 `userText`（它是学生刚发出去的那句话）。
 */
const turnCount = computed(() => turns.value.filter((turn) => turn.userText !== '').length)

/**
 * 空态（开场卡 + 四张能力入口 + 建议问题）的开关。
 *
 * ★ 用 `turnCount` 而不是 `turns.length`：两者只在「只有开场白、学生还没开口」时不同，
 *   而那正是本次修的缺陷 —— 主进程对未开始的会话**回空消息数组**（开场白走 `opening`），
 *   所以这里判「有没有学生提问」与主进程判的是同一件事，界面不会再出现第三种样子。
 */
const isEmpty = computed(() => turnCount.value === 0)

/**
 * 自动滚到底。
 *
 * ★★ 这里有过一个**实测出来的缺陷**（`scripts/ux-audit.mjs` 的 B1 抓到的）：
 *   旧实现靠 `watch` 依赖 `${轮数}:${正文长度}:${卡片数}` 来触发滚动 —— 那是一份
 *   **手写的依赖清单**，而「会长高的东西」远不止这三样：
 *   引用块（实测一次插入 376–663px）、安全提示、降级提示、卡片内部资源加载……
 *   凡是没列进去的，长高了都不会滚，学生看到的就是「新内容在下面出来了，
 *   视图却停在原来的消息上」。实测：引用块出现时视图**掉队 759px**。
 *
 *   现在改成 **ResizeObserver 观察内容容器本身** —— 不管是谁把高度撑大的
 *   （正文、引用、卡片、iframe、图片……），只要内容区变了就触发。
 *   这比维护一份清单可靠：新增一种内容块**不需要**记得来这里登记。
 *
 * ★★ 但「无脑跟随」同样是缺陷 —— 学生往上翻着想重读时，每一段新文字都把他拽回底部，
 *   等于**回答生成期间无法阅读**。所以跟不跟随由 {@link stick} 决定：
 *     - 学生**本来就在底部**（容差 {@link STICK_TOLERANCE_PX}）→ 跟随新内容；
 *     - 学生**主动往上翻过** → 停住不动，并露出「回到最新」按钮（{@link showJump}）。
 *   这不是「少做一点」，而是把人当人：**跟随是为了让他看到新内容，
 *   停住是为了让他能读完旧内容**，两者都要有。
 */
const colRef = ref<HTMLElement | null>(null)
const innerRef = ref<HTMLElement | null>(null)
/** 观察内容容器的高度变化（在 `onMounted` 里建、`onBeforeUnmount` 里断）。 */
let resizeObserver: ResizeObserver | null = null

/**
 * 容差（px）：判定「学生是不是还贴着底」。
 * 给 48px 而不是 0 —— 触控板滚动、字体渲染取整、卡片阴影都会造成几个像素的差，
 * 用 0 判定会让「明明在底部」被误判成「翻上去了」，于是新内容不再跟随。
 */
const STICK_TOLERANCE_PX = 48
/** 是否跟随新内容（学生滚上去就停下来等他）。 */
const stick = ref(true)
/** 停止跟随后是否露出「回到最新」按钮（内容确实还在长 / 已经长出来时才有意义）。 */
const showJump = ref(false)

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

/**
 * 「这次滚动是我们自己发起的」——记的是**我们设到的位置**，不是一个布尔标记。
 *
 * ★ 为什么必须有这个机制（消除一类**竞态**）：程序性赋值 `scrollTop` 也会派发 `scroll` 事件，
 *   而它派发时机在**布局之后** —— 如果内容恰好在这中间又长高了（正在流式输出，
 *   这是常态），`onColScroll` 量到的 `distanceFromBottom` 就是「新长出来的那段高度」，
 *   可能超过容差 → 把 `stick` 误判成 false → **从此停止跟随**，
 *   表现就是「视图停在旧消息上不动了」。
 *
 * ★★ 为什么从布尔标记改成**位置比对**（2026-09-21 实测改，别改回去）：
 *   原来是一个 `selfScrolled: boolean` —— `scrollToBottom()` 置真、`onColScroll()` 消费一次。
 *   但流式输出时 `scrollToBottom()` 会被 ResizeObserver **连续调用多次**，而浏览器会
 *   **合并** scroll 事件：置真三次、事件只来一次（或来得比下一次赋值晚）→
 *   多出来的事件看到的是 `false` → 按「学生滚的」重算 → `stick=false` → 掉队且**不会恢复**。
 *   实测证据：`npm run ux:attribute` 报「正文增长 16 次没跟上」，离底部距离**单调递增**
 *   （37→143→239→…→759px）—— 「单调递增且不回落」正是「跟随被永久关掉」的指纹
 *   （若只是慢，距离会上下浮动）。
 *   ⚠️ 触发条件与**回答长度/速度**有关：回答越长、文本块来得越密，越容易撞上
 *   （D-064 之后回答变长，这条就浮出来了）。
 * ★ 新判据是**位置**：我们设完之后把实际值读回来（会被夹到 maxScroll），
 *   之后凡是 `scrollTop` 仍等于它的 scroll 事件都算「我们自己滚的」——
 *   合并多少次事件都成立，而且学生真滚走之后位置必然不同，不会误吞。
 */
const selfScrollTop = ref(-1)

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const el = colRef.value
  if (!el) return
  el.scrollTop = el.scrollHeight
  // ★ 读回**实际**位置（赋值会被夹到 `scrollHeight - clientHeight`）——
  //   记 `scrollHeight` 本身的话，比对永远差一个视口高度，等于没防。
  selfScrollTop.value = el.scrollTop
  // 到底了就等于「学生又回到最新」，恢复跟随
  stick.value = true
  showJump.value = false
}

/**
 * 滚动容器的 scroll 事件：**学生自己的滚动**是唯一能关掉跟随的东西。
 *
 * ★ 这里同时负责「露出回到最新」—— 一开始把它只写在 ResizeObserver 里，
 *   结果**学生往上翻时按钮根本不出现**（没有内容增长，观察器不触发）：
 *   于是「停住不打扰」变成了「停住且没有任何回去的路」。实测抓到（探针 ②b）。
 */
function onColScroll(): void {
  const el = colRef.value
  if (!el) return
  // 我们自己滚的那次（见 selfScrollTop 的说明：位置比对，能扛住事件合并）
  if (selfScrollTop.value >= 0 && Math.abs(el.scrollTop - selfScrollTop.value) <= 1) {
    return
  }
  // 学生真的滚动了 → 清掉标记，之后再长内容也不该按「我们滚的」对待
  selfScrollTop.value = -1
  stick.value = distanceFromBottom(el) <= STICK_TOLERANCE_PX
  // 翻上去了才给「回到最新」；贴着底时它没有意义（那里就是最新）
  showJump.value = !stick.value
}


// ★★ 「有新的一轮开始了」= 学生正在等这条回答 → 无条件恢复跟随。
//
//   为什么不能只靠 `onSend`：排队的那条是**回答结束后由 store 自动发出**的
//   （`stores/chat.ts` 里 `void send(pending)`），那条路**不经过本组件的 `onSend`**。
//   实测后果：学生滚上去看了旧内容 → 排队 → 自动发出新问题 → 视图纹丝不动，
//   回答在他看不见的地方生成完（B1 场景实测掉队 1527px）。
//
//   ⚠️ 这条 watch 依赖的是 `turns.length` —— **「新轮次」这个事件本身**，
//      不是「内容变大」的代理量。两者性质不同：前者是离散的、有语义的
//      （一轮 = 一次提问），后者永远追不全（引用块/提示/卡片都会撑高容器）。
//      守卫（`tests/ux-queue-and-scroll.test.ts`）正是因为这条区别才放行它。
watch(
  () => turns.value.length,
  (now, before) => {
    if (before !== undefined && now > before) {
      stick.value = true
      showJump.value = false
      void scrollToBottom()
    }
  }
)

/* ── 发送：只把文字交给 store ───────────────────────────────────────────── */
const composerRef = ref<{ fill?: (value: string) => void; focus?: () => void } | null>(null)

function onSend(text: string): void {
  // 立刻滚到底回应「我发了消息」这个动作（上面那条 watch 会在新轮次落库时再兜一次）
  stick.value = true
  showJump.value = false
  void scrollToBottom()
  // ★★ 引导期（五问还没答完）：这句话是**对当前那一问的回答**，不进对话、不调模型。
  //   问次由 store 按**位置**记（`submitAnswer` 的同步段里就取走并清掉待答问次），
  //   所以这里只递一句话，别的什么都不用管；答完第 5 问后 `active` 自动变假，
  //   下一条消息才走正常对话（`chat.send`）。
  //   ⚠️ 顺序不能反：`submitAnswer` 先跑，问次才拿得到（见 stores/onboarding.ts）。
  if (onboarding.active) {
    void onboarding.submitAnswer(text)
    return
  }
  void chat.send(text)
}

/* ── 两栏：默认都收起（见 stores/panels.ts 的说明），各有一个开关 ────────────
 * 左栏（历史对话）开关在会话工具条的**左端**、右栏在**右端** —— 两个开关对称落在
 * 同一行两端，各自挨着自己控制的那一栏。
 * ★ 状态在 `stores/panels.ts`（localStorage 持久化）：组件里再存一份 ref 就会出现
 *   「一处改了另一处没同步」，而这类不同步在界面上表现成「点了没反应」。 */
const panels = usePanelsStore()
/** 只读机制浮窗（演示档用的那只；与「追问窗」是两只独立实例）。 */
const diagnosticsPanel = useDiagnosticsPanel()
const historyOpen = computed(() => panels.historyOpen)
const railOpen = computed(() => panels.railOpen)
/** ★ 必须与 `ContextRail.vue` / `SessionList.vue` / `AppSidebar.vue` 的媒体查询同档：
 *  **1023px 及以下 = 收拢档**（窗口下限是 1024，所以这一档只在极端情况下命中）。
 *  1024–1279 不在此列 —— 那一档保留完整布局，见文件头「右栏折叠」。 */
const NARROW = '(max-width: 1023px)'
let mql: MediaQueryList | null = null
/** 记录「这次收起是断点自动做的」—— 离开窄屏时才还原，不覆盖学生主动关掉的选择。 */
let autoClosed = false

function onBreakpoint(): void {
  if (!mql) return
  if (mql.matches) {
    if (panels.railOpen) {
      // ★ `persist: false`：窄屏自动收起是**视口**决定的临时状态，不许覆盖学生的选择 ——
      //   否则「在窄窗口里用过一次」就等于把偏好改成了收起，宽屏上再也回不来。
      panels.setRail(false, { persist: false })
      autoClosed = true
    }
  } else if (autoClosed) {
    panels.setRail(true, { persist: false })
    autoClosed = false
  }
}

onMounted(() => {
  mql = window.matchMedia(NARROW)
  onBreakpoint()
  mql.addEventListener('change', onBreakpoint)
  // 画像/推荐：空态与右栏都要用（store 会判「已有数据就不重复请求」）
  void insight.loadAll().catch(() => {})
  void scrollToBottom()

  // ★ 进对话页**直接把光标放进输入框**（UX 体检 A1 抓到的缺失）：
  //   对话是本应用的主界面，学生的第一个动作几乎一定是打字。
  //   不自动聚焦的话，他得先找到输入框点一下 —— 每次进应用都多一步，
  //   而且第一次用的人会盯着界面想「从哪儿开始」。
  //   ⚠️ 只在**空对话**时做：带着历史回来时自动聚焦会抢走焦点，
  //     让正在用键盘浏览/回看的学生莫名跳到输入框。
  if (turns.value.length === 0) void nextTick(() => composerRef.value?.focus?.())

  // ★ 内容区高度变化 → 跟随（见 scrollToBottom 上方那段说明：不再手写依赖清单）
  if (innerRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (!stick.value) {
        // 学生正在往回读：**不打扰**，只把「回到最新」露出来
        showJump.value = true
        return
      }
      void scrollToBottom()
    })
    resizeObserver.observe(innerRef.value)
  }
  colRef.value?.addEventListener('scroll', onColScroll, { passive: true })
})
// ★ 切回对话页（KeepAlive 的 onActivated）也补一次聚焦：学生去设置页改完东西回来，
//   下一个动作还是打字。这里同样只在没有历史消息时做，理由同上。
onActivated(() => {
  if (turns.value.length === 0) void nextTick(() => composerRef.value?.focus?.())
})
/**
 * 首屏的**引导与画像**取数。
 *
 * ★★ 为什么必须挂在 `useOnBackendReady` 上（而不是裸 `onMounted`）：
 *   引导状态来自本机数据服务，而那是**另一个进程** —— 挂载时它多半还没就绪。
 *   只发一次的话，那一次失败会让「该弹的五问」永远不弹（新用户从此再没有被引导过），
 *   而库里那条状态仍然是 `not_started`。
 * ★ 两条各自独立失败：引导读不到不影响标签卡，反之亦然（两个 store 内部都吞了异常）。
 * ★ `catch` 只是兜住「连 catch 都写漏了」的那种意外：这一步**绝不允许**拖住对话页。
 */
function loadOnboardingData(): void {
  void onboarding.load().catch(() => {})
  void profileCard.load().catch(() => {})
}

// 首屏取数：立刻跑一次 + sidecar 就绪后补跑一次
useOnBackendReady(loadOnboardingData)

onBeforeUnmount(() => {
  // 引导那条推送也要退订（与其它几条推送同一处置，避免监听器堆积）
  onboarding.dispose()
  mql?.removeEventListener('change', onBreakpoint)
  resizeObserver?.disconnect()
  resizeObserver = null
  colRef.value?.removeEventListener('scroll', onColScroll)
})

function setRailOpen(open: boolean): void {
  panels.setRail(open)
  // 学生自己动手了：之后跨断点不再自动改他的选择
  autoClosed = false
}

function toggleRail(): void {
  setRailOpen(!panels.railOpen)
}

/**
 * 打开只读机制浮窗（演示浮窗）。
 *
 * ★ 锚点取自触发按钮（`openFrom` 内部读 `getBoundingClientRect`）——
 *   出场动画从按钮长出来、退场沿同路径收回，与追问窗同一条手感。
 * ★ 这里**不打开右栏**：两者是并列的两块证据面（右栏是常驻的检索/轨迹/学段证据，
 *   浮窗是「就地看一眼这一轮」，讲演示时经常需要其中一个不动、另一个飘过去）。
 */
function openDiagnostics(event: MouseEvent): void {
  diagnosticsPanel.openFrom(event.currentTarget as Element | null)
}

/** 左栏（历史对话）开关：没有断点逻辑 —— 窄窗口下这一列本来就收成图标条（见 SessionList 的 CSS）。 */
function toggleHistory(): void {
  panels.toggleHistory()
}

/* ── 新会话：**开一个新的会话文件**（不是删旧的）───────────────────────── */
/**
 * ★★ 与改造前的区别（这一条决定了这个按钮到底在做什么）：
 *   旧实现只调 `chat.resetConversation()` —— **纯本地清屏**，Pi 那一侧的会话
 *   一动不动。于是学生「新会话」之后继续说的每一句话，都写进**同一个** JSONL 文件，
 *   历史列表里也只有那一条越来越长（「新会话」实际上只是个清屏按钮）。
 *   现在它走 `chat.startNewSession()`：dispose 旧会话 → 开一个新文件 → 回传状态。
 *
 * ★ 旧会话**不删除**（它仍在左侧列表里，随时能切回去）。
 * ★ 确认弹窗保留：它的意义从「清空不可撤销」变成了「你要离开当前这段了」——
 *   但**仍然需要**：学生会以为点错就丢了，说清楚「旧的还在」比不说好。
 *
 * ★★ 确认文案按**学生的话**写（2026-09-20 走查）：此前那句是以开发者口吻解释缓存
 *   （「当前这段对话有 N 轮。开始新对话后界面会空出来，但这一段不会丢 ——
 *   它仍在左边的历史列表里……」）。学生要的只有一件事：**原来那段还在不在**。
 *   所以：不报轮数、不解释机制，只把「还能点回去」说清楚 ——
 *   `不会丢` 这三个字是守卫（`ux-pages-regression` / `session-branch`）钉住的，
 *   换说法时必须留着。
 */
async function newSession(): Promise<void> {
  if (turns.value.length > 0) {
    const ok = await confirm.ask({
      title: '开始新对话？',
      body:
        '开启新对话后界面会空出来，这段记录不会丢，' +
        // ★ 确认框是纯文本，不解析 Markdown（写 `**` 会原样显示成星号）
        '随时可以点回左边的历史列表继续聊。',
      confirmText: '开始新对话'
    })
    if (!ok) return
  }
  // ★ 先让主进程真的换一条会话（失败就**什么都不动** —— 界面清空了却没换会话
  //   是最坏的失败形态：学生以为在说新话题，其实接着写进上一条会话）。
  const result = await chat.startNewSession()
  if (!result.ok) {
    // ★ 走 store 的写入口（不是直接改 ref）：提示的写入只有一处，界面不持有状态
    chat.setSessionNotice(result.message ?? '新建会话失败。')
    return
  }
  chat.setSessionNotice(null)
  // ★ 工具调用轨迹也要跟着清：右栏那一页写的是「本轮工具调用」，它由主进程推的**快照**填充。
  //   只清对话的话，新会话里右栏仍列着上一段对话的「第 N 轮」分组 —— 学生刚点了「新会话」，
  //   界面上却还摆着旧记录，而那一页的标题正是在说「本轮」。
  //   ⚠️ 这里复用 `ContextRail` 已建立的同一个 store 实例（Pinia 单例），
  //      不是新引一个 —— 新引一个只会是同一个对象，写两份才危险。
  trace.reset()
  await nextTick()
  // 清空后回到「跟随 + 贴底」的初始状态：上一段对话留下的 stick=false 不该影响新会话
  stick.value = true
  showJump.value = false
  await scrollToBottom()
}

/* ── 会话分叉：从这里重新问 ─────────────────────────────────────────────── */
/**
 * 正在分叉的那条消息（`null` = 没有在分叉）。
 *
 * ★ 用它做两件事：禁用全部分叉按钮（第二次点击没有意义，而且会造出两条多余的
 *   分支）、以及让学生看到「正在准备」的反馈（分叉要写文件 + 装配，秒级）。
 */
const branchingEntryId = ref<string | null>(null)

/**
 * ★★ 从某条消息处重新问（分叉）。
 *
 * 为什么**先确认**：它会让界面切到另一条会话线（当前这段不再显示在屏幕上）。
 * 学生可能只是想看看那条回答、手滑点到 —— 而分支是真实写盘的动作
 * （虽然原会话不动，但「屏幕上的对话忽然换了一段」本身足够让人困惑）。
 * 确认文案里**明说原对话不会丢**，因为那正是学生最担心的事。
 *
 * ★★ 文案（2026-09-20 走查）：原句「会把你和智团团聊到这里的这段内容复制成
 *   一条新的对话线」是在讲**实现**（「复制」）。学生只关心两件事：
 *   从这里往下接着问、刚才那段还在。所以改成这两句 ——
 *   `不会丢` 与 `confirmText: '另开一条'` 都是守卫钉住的，换说法时不许动。
 */
async function onBranch(entryId: string): Promise<void> {
  if (branchingEntryId.value !== null) return
  const ok = await confirm.ask({
    title: '从这里重新问？',
    // ★ 确认框的正文是**纯文本**（`ConfirmDialog` 不解析 Markdown）——
    //   这里写 `**加粗**` 会原样显示成星号（实测截图里就是「复制成**一条新的对话线**」）。
    //   加重语气靠**措辞**而不是标记：与 P-076（模型输出里的 `**` 直接露给学生）同一条纪律。
    body: '智团团会从这句话开始，陪你换一种问法接着往下聊。现在这段对话不会丢，随时能回到左边的历史列表里。',
    confirmText: '另开一条'
  })
  if (!ok) return

  branchingEntryId.value = entryId
  try {
    const result = await chat.branchSession(entryId)
    if (!result.ok) {
      chat.setSessionNotice(result.message ?? '从这里重新问失败。')
      return
    }
    chat.setSessionNotice(null)
    // 与「新对话 / 切会话」同一套收尾：轨迹面板也要清（换了会话线，右栏不该留着上一条的）
    trace.reset()
    await nextTick()
    stick.value = true
    showJump.value = false
    await scrollToBottom()
  } finally {
    branchingEntryId.value = null
  }
}

/* ── 主动发起对话：AI 的第一句 ───────────────────────────────────────────── */
/**
 * 学生点「好啊，就从这里开始」：**预填**一句围绕该知识点的提问（不直接发）。
 *
 * ★ 预填而不是直接发（与 `chat.prepareQuestion` 同一条纪律）：
 *   直接发会替学生消耗一次云端调用，而他可能只是想看看这句话对不对 ——
 *   对一个教学助手来说，「学生看得见自己要问什么」比「一键自动开始」更贴合。
 * ★ 知识点名从 `insight`（推荐接口的 `name`，服务端已解析好）取，**不自己反查**：
 *   两处各解析一次就会出现「引导说 X、提问里写 Y」这种不一致。
 */
function acceptOpening(): void {
  // ★★ 名字直接用**开场白载荷里带的那个**（D-074）。
  //   此前是「拿 kpId 去 /recommendation 里反查」—— 推荐改成随机之后两者不再同源，
  //   反查必然落空，于是按钮点下去只会把光标放进输入框（看起来像没反应）。
  //   现在名字与 kpId 来自同一份载荷，卡片上写的那句与按钮指向的必然是同一个知识点。
  const name = chat.openingKpName
  chat.acceptOpening()
  if (name) fillComposer(`我想学「${name}」，请先讲一下它是什么。`)
  else composerRef.value?.focus?.()
}

/* ── 空态：四张能力入口 + 建议问题 ─────────────────────────────────────── */
interface EntryItem {
  key: string
  label: string
  desc: string
  icon: unknown
  to: PageName | null
}

const entries: EntryItem[] = [
  { key: 'chat', label: '直接提问', desc: '随时问，按你的学段讲', icon: MessageCircle, to: null },
  { key: 'animation', label: '动画讲解', desc: '把过程画出来看', icon: Clapperboard, to: 'animation' },
  { key: 'coding', label: '智码工坊', desc: '在本地跑一段 Python', icon: Code, to: 'coding' },
  // ★ 名字必须与 `PAGES.quiz.title` 一致（2026-09-21「闯关练习」→「闯关挑战」，
  //   2026-09-30 再改成「个性化学习」）。这四张卡是同一批入口的另一种呈现，
  //   名字与侧栏不一致学生会以为是两个功能。
  { key: 'quiz', label: '个性化学习', desc: '几道题检验一下', icon: Trophy, to: 'quiz' }
]

function onEntry(to: PageName | null): void {
  if (to === null) composerRef.value?.focus?.()
  else ui.go(to)
}

/** 建议问题：点一下填进输入条，**不直接发**（学生可以改）。 */
const suggestions = [
  '用动画讲讲特征是怎么提取的',
  '给我出 3 道数据与特征的题',
  '我还是不太明白，换个说法再讲一遍'
]

function fillComposer(text: string): void {
  composerRef.value?.fill?.(text)
}

/* ── 冷启动引导（五问）：选项动作 ──────────────────────────────────────── */
/**
 * 问句里的可点选项（chip）：**点一下直接提交，立刻进入第 2 问**。
 *
 * ★★ 2026-09-30 用户裁决（推翻了 2026-09-29 的「只填进输入框」）：
 *   只有第 1 问带选项（年级是闭集），点选**就是**他的回答，不必再让他按一次发送。
 * ★ 它仍与打字**共用同一个出口** `onboarding.submitAnswer` —— 问次记录、防连点、
 *   降级推进全都在那一处。这里**不许**自己记问次、也不许自己调桥（那才是第二条路径，
 *   守卫在 `tests/renderer-onboarding.test.ts`）。
 * ★ 第 2–5 问没有 chip（脚本里 `chips: []`），所以自由输入是那几问的唯一入口。
 */
function pickOnboardingOption(option: string): void {
  if (onboarding.submitting) return
  void onboarding.submitAnswer(option)
}

/** 问原文（引导区渲染「已经答过的那几问」用）；查不到给空串，不编问句。 */
function questionTextOf(id: OnboardingQuestionId): string {
  return questionById(id)?.text ?? ''
}

/* ── 空态之后的专题行：真实数据，没有就整段不出现 ───────────────────────── */

/*
 * ⚠️ 2026-10-01（D-131）：这里**删掉了** `recommendedName` / `hasRecommended` 两个计算属性。
 *   它们是「建议接着练：<知识点>」那半句的展示口径，而用户点名把那半句去掉了 ——
 *   留着就是两个没人读的死计算（`vue-tsc` 会直接报 TS6133）。
 *   推荐数据本身没动：`insight.recommended` 仍是服务端解析好的那一份，
 *   档案页与侧栏照旧按它展示；要恢复这半句，把两个计算属性与那段模板一起加回来即可。
 */


/*
 * ★ 2026-10-01 用户裁决（D-131）：**「建议接着练：<知识点>」这半句不再渲染**
 *   ——「把我箭头指着的那行字也去掉」。它原先与章节拼在同一行（本轮专题）。
 *
 * ⚠️ 条件必须跟着改：原来整段的显示条件是 `章节 or 有推荐`；推荐不显示了还留着这个 `or`，
 *   就会在「没选章节但有推荐」时渲染一个**空段落**（占高度、还带个图标）。
 *   现在整段只认章节。`hasRecommended` / `recommendedName` 仍保留 —— 它们是
 *   `insight.recommended` 的展示口径，档案页与侧栏还在用同一份判断。
 */

/* ── 巩固条：计划那一轮答完后的两路检验 ────────────────────────────────────
 * ★ 为什么是**两路**：学生说「检验一下」时意图有两种落点 ——
 *   想被系统按掌握度出题、并留下掌握记录（去闯关页），或不想离开这段对话、
 *   马上来三道（就地再考我）。只给一条路，另一种意图的人只能自己去侧栏找入口。
 * ★ 两路都指向**同一个知识点**（`chat.planKpId`，由计划那一轮认领）——
 *   上一轮的正文刚讲完它，按钮上不必再复述名字。
 * ⚠️ 这两个动作**不许**做成 `.k12-cta`：这一屏的主色填充只有一个（输入区的发送键），
 *   同一屏两个主色按钮等于没有主色按钮（判据见 base.css 里 `.k12-cta` 的注释）。
 */
function goPlanQuizPage(): void {
  // ★ `selectLevel` **只取题、不跳页**：跳页是这一屏的责任（见 stores/quiz.ts 的说明）——
  //   两件事分给两层各做一件，闯关页自身仍能从关卡列表进入。
  void quiz.selectLevel(chat.planKpId)
  ui.go('quiz')
}

function askPlanQuizInChat(): void {
  // ★ 与「我想学这个」走**同一条成对文本**：气泡里是学生口吻的那句，
  //   送进模型的是带指令的报文（翻译只在 studentFacingUserText 一处发生，本页不另抄）。
  void chat.send(quizAskDisplayText(chat.planKpName), buildQuizAskMessage(chat.planKpId, chat.planKpName))
}

/**
 * 「换一批」与「现在考考我」**共用同一条 send**。
 *
 * ★ 为什么不再写一条消息对：wire 里已经写明「现场出 3 道新题」，所以再走一次就是
 *   同知识点另出一批（生成的题会登记到本地，个性化学习里能看到、能再做）。
 *   两句话的含义完全相同，多一份报文就多一处会漂的文案。
 */
function askPlanQuizMore(): void {
  askPlanQuizInChat()
}

/* ── 刚出的题：来源标注 / 跳到个性化学习 / 卡片自己走到眼前 ─────────────────
 * 报告「期二」的原话：点完按钮**不用手动滚**就能看到卡片并直接作答；
 * 「期四」：这几道题也会出现在个性化学习里 + 一键跳转。 */

/**
 * 最新一张**练习题卡**（chat.cards 按时间升序，所以从后往前找第一张 kind === 'quiz'）。
 *
 * ★ 只认题卡不认批改结果卡：来源与题数只有出题载荷才有。
 * ★ 不缓存、不做 computed：它只在两个地方各读一次（来源标注与滚动锚点），
 *   而 chat.cards 自己已经是「卡片没变就不换引用」的缓存（见 store 的说明）。
 */
function latestQuizCard(): { id: string; payload: unknown } | null {
  const cards = chat.cards
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const card = cards[index]
    if (card !== undefined && card.kind === 'quiz') return card
  }
  return null
}

/**
 * 刚出的那一批题（**只有它属于当前计划的知识点时才认**）。
 *
 * ★ 为什么要比 kpId：学生可能在这段对话里又问过别的知识点、出过别的题 ——
 *   把别处的旧题标成「刚出的」，比不标更糟（学生会照着错的来源理解）。
 */
const latestPlanQuiz = computed(() => {
  const card = latestQuizCard()
  if (card === null) return null
  const view = readQuizCard(card.payload)
  if (view.kind !== 'questions' || view.kpId !== chat.planKpId) return null
  return { source: view.source, count: view.questions.length }
})

/** 来源标注那一行（认不出给空串，模板据此整行不渲染）。 */
const latestPlanQuizSource = computed(() =>
  latestPlanQuiz.value === null
    ? ''
    : quizSourceLabel(latestPlanQuiz.value.source, latestPlanQuiz.value.count)
)

/**
 * 「新题落地时，把它推到学生眼前」。
 *
 * ★★ 为什么需要它（真机实测）：卡片长在消息列表**末尾**，列表已经很长时它落在视口外
 *   —— 学生点完「现在考考我」，屏幕上什么都没出现，读起来就是「按钮没反应」。
 *
 * ★★ 为什么不是给既有的滚动机制再加一个消费方：守卫 ux-queue-and-scroll 钉着一条
 *   被实测证伪过的纪律 —— 负责滚动的响应式监听只允许依赖「新的一轮」这个**离散事件**，
 *   不许依赖「内容变长了」这类尺寸代理量（引用块曾因此掉队 759px）。
 *   所以这里依赖的是**卡片身份**（新的 id 出现了）而不是数组长度：id 变了 = 真的落了
 *   一张新卡，与「变长了」是两回事；滚的也是卡片自己的 DOM 锚点，不是无脑到底。
 * ★ 程序性滚动仍走同一套记账（selfScrollTop），所以不会被 onColScroll 误判成
 *   「学生自己翻上去了」（见 scrollToBottom 上方那段竞态说明）。
 * ★ 学生已经翻上去读旧内容时**不打扰**：只更新锚点，不拉视图（露出「回到最新」
 *   由 onColScroll 负责）—— 与「跟随 / 停住」同一条哲学。
 */
let lastQuizCardId = ''

async function revealQuizCard(): Promise<void> {
  await nextTick()
  const col = colRef.value
  if (col === null) return
  // 锚点用卡片根元素自己的 data-testid="quiz-card"：只挂在真正出题的卡片上
  // （批改结果卡是另一个 testid），取最后一张就是刚落下的那一批。
  const anchors = col.querySelectorAll<HTMLElement>('[data-testid="quiz-card"]')
  const anchor = anchors[anchors.length - 1]
  if (anchor === undefined) return
  // 让卡片顶边落进视口（留 12px 呼吸）：无脑到底会把卡片顶出去（它下面还有巩固条）。
  const delta = anchor.getBoundingClientRect().top - col.getBoundingClientRect().top
  col.scrollTop = Math.max(0, col.scrollTop + delta - 12)
  selfScrollTop.value = col.scrollTop
}

watch(
  () => chat.cards,
  (cards) => {
    let newestId = ''
    for (const card of cards) {
      if (card.kind === 'quiz') newestId = card.id
    }
    if (newestId === '' || newestId === lastQuizCardId) return
    lastQuizCardId = newestId
    if (!stick.value) return
    void revealQuizCard()
  }
)
</script>

<template>
  <div class="chat" data-testid="chat-area">
    <!-- ── 历史对话列（切换续聊的入口）─────────────────────────────── -->
    <!-- ★★ 包一层可折叠容器，而不是给它 `v-if`：`SessionList` **必须保持挂载** ——
         它的两个 watcher（`currentSessionMessageCount` 变化 → 重取列表；
         `currentSessionId` 变化 → 重取列表 + 解除祖先折叠）与 `onMounted` 里的首次取数
         都靠挂载活着。用 `v-if` 收起的话，学生在折叠状态下新建/切换会话，
         再展开时列表是**旧快照**（而「展开后列表是旧的」在界面上看起来就是「没保存」）。
         ★ 收起时内层整体 `display: none`（与右栏 `.rail--closed .rail__panel` 同一手法）：
           `overflow: hidden` 只是裁剪，子元素仍有 236px 的矩形 —— 而体检脚本按
           「渲染后的矩形」判可见性（`w > 0 && h > 0`），裁剪出来的东西会被量进
           「学生能点的元素」（假红假绿都发生过）。 -->
    <div class="chat__side" :class="{ 'chat__side--closed': !historyOpen }">
      <SessionList />
    </div>

    <!-- ── 主列 ─────────────────────────────────────────────────────── -->
    <div class="chat__main">
      <!-- ★★ 信息条：**一条**（教材章节 + 本轮对话 + 两个栏开关同处一行）。
           ⚠️ 2026-09-22 设计评审（4.1 / 4.4）前这里是**两条并排、各画一条下划线**
             （`.chat__indicators` + `.chat__bar`）：加上侧栏竖线与顶栏下线，
             到内容之前先有 3 条线，而这两条说的本是同一件事（这段对话在什么状态）。
           现在合成一行、只留**一条**线；顺序读起来就是一句话：
           「正在学第 4 章 · 本轮对话 3 轮」。
           ★ 不变量（守卫钉住）：章节指示器 `data-testid="chapter-indicator"`、
             左栏开关 `history-toggle`、右栏开关 `rail-toggle`（含 `aria-pressed`）、
             以及「尚未开始 / N 轮」那两段文字，全都还在这一行里。 -->
      <div class="chat__bar">
        <div class="chat__bar-left">
          <!-- ★ 左栏开关在**最左端**（挨着它控制的那一列），右栏开关在最右端 ——
               两个开关对称落在同一行两端。图标与右栏那枚同一套语义
               （PanelLeft/Right + Open/Close），`aria-pressed` 给屏幕阅读器同样的信息。 -->
          <button
            type="button"
            class="chat__bar-icon"
            data-testid="history-toggle"
            :title="historyOpen ? '收起历史对话' : '展开历史对话'"
            :aria-pressed="historyOpen"
            @click="toggleHistory"
          >
            <component :is="historyOpen ? PanelLeftClose : PanelLeftOpen" :size="16" />
          </button>
          <!-- ★★ 两段文字**自己包一层**：这样外层能按中心线对齐（32px 的开关与文字块同一条线），
               而文字内部仍按**基线**对齐（13px 的标题与 12px 的元信息 —— 基线对齐才不显歪）。
               ⚠️ 走查实测的缺陷：原来这一行是 `align-items: baseline` 且没有这层包裹，
                  开关是唯一的非文字子项 —— 它的「基线」是按钮盒子的底边，于是
                  **整枚开关比文字高出 4px**（量到中心线 145 vs 149），
                  与右端那枚按中心线对齐的 `rail-toggle` 也不在同一条线上。 -->
          <span class="chat__bar-titles">
            <span class="chat__bar-title">本轮对话</span>
            <span class="chat__bar-meta">{{ isEmpty ? '尚未开始' : `${turnCount} 轮` }}</span>
          </span>
        </div>

        <!-- 教材章节指示器：**与上面的信息并排**（它原来是独立的一行，见本容器开头的说明）。
             ★ 它自己刻意不画下划线（见 `ChapterIndicator.vue` 的注释）—— 线由这一行画。 -->
        <ChapterIndicator class="chat__bar-chapter" />

        <div class="chat__bar-right">
          <!-- ★★ 演示浮窗入口（只在教师 / 演示档存在）：在**真实页面里**就地解释这一轮
               背后的机制。它是只读浮窗 —— 打开后没有一处能改运行时状态。
               ⚠️ 包在 `<TeacherGate>` 里：学生视角下这个按钮**不在 DOM 里**
               （不是 CSS 藏起来），与右栏那批证据同一处置。 -->
          <TeacherGate>
            <button
              type="button"
              class="chat__bar-btn"
              data-testid="diag-panel-toggle"
              title="看看这一轮背后发生了什么"
              @click="openDiagnostics($event)"
            >
              <Activity :size="14" />
              <span>本轮机制</span>
            </button>
          </TeacherGate>
          <button
            type="button"
            class="chat__bar-btn"
            data-testid="new-session"
            title="开始一段新对话（清空当前消息）"
            @click="newSession"
          >
            <Plus :size="14" />
            <span>新会话</span>
          </button>
          <button
            type="button"
            class="chat__bar-icon"
            data-testid="rail-toggle"
            :title="railOpen ? '收起学习上下文' : '展开学习上下文'"
            :aria-pressed="railOpen"
            @click="toggleRail"
          >
            <component :is="railOpen ? PanelRightClose : PanelRightOpen" :size="16" />
          </button>
        </div>
      </div>

      <!-- 对话区 -->
      <div ref="colRef" class="chat__col" data-testid="chat-log">
        <div ref="innerRef" class="chat__inner">
          <!-- ── 空态 ─────────────────────────────────────────────────── -->
          <!-- ★★ 开场引导就住在这里（**空态**），不是消息列表里 —— 实测踩到过：
               一开始把它放在「有消息」那个分支里（排在 `<ChatMessage>` 前面），
               而它**只在会话为空时才有值** ⇒ 那个分支永远进不去 ⇒ 开场语发了、
               写进会话了、界面上却一个字都看不到（P-101）。
               位置就是它的语义：这是**还没有任何一轮对话时**助手先开的口。
           ★★ 2026-09-30 用户裁决：**五问期间不显示这一屏**。冷启动的第一屏就是团团
              的问题（见下面引导区），而不是「新对话页 + 四张能力入口 + 建议问题」——
              一进应用先看到一屏落地页、问题挤在下面，读起来像问卷而不是聊天。
              五问答完（`onboarding.active` 变假）后这一屏照常回来。 -->
          <div v-if="isEmpty && !onboarding.active" class="chat__empty" data-testid="chat-empty">
            <!-- 品牌问候：**有开场语时也在**（2026-09-30 用户裁决）。
                 此前它被开场卡整个顶替掉，而开场卡自带一个 30px 的小 logo ——
                 表现就是「随机抽题开场时，吉祥物和招呼一起缩水」，与没开场时的空态判若两页。
                 现在问候恒定在场，主动引导接在它后面（见下）。 -->
            <div class="chat__hello">
              <!-- 空态问候的标记：用品牌 logo（吉祥物智团团）。
                   ★ 这里**不跟学段换图** —— 它是「这个应用是谁」的品牌位，
                     与「这一轮按哪个年级讲」无关（那是顶栏学段指示器的事）。
                     学段换图只在侧栏品牌标那一处（见 `brand-logo.ts` 的说明）。 -->
              <img class="chat__hello-mark" :src="DEFAULT_LOGO_URL" :alt="''" aria-hidden="true" draggable="false" />
              <h2 class="chat__hello-title">你好，{{ student.nickname }}</h2>
              <p class="chat__hello-sub">
                我是智团团。你可以直接提问，也可以让我换个方式讲。我会按你的学段来回答。
              </p>
            </div>

            <!-- ── 主动引导（随机抽一个知识点开场）：排在问候**之后**、能力卡之前。
                 ★★ 2026-09-30 用户裁决：「抽选提问的时候应该是把那个加在后面一点，
                    而不是把图标什么的也缩小掉」—— 所以它不再顶替问候、也不再自带小 logo，
                    而是像一条消息那样接在问候下面（那个位置原来放的是学段说明行，已删）。
                 ★ 显示与否仍只由 `chat.showOpening` 决定（见 tests/opening-guidance.test.ts）。 -->
            <div v-if="chat.showOpening" class="chat__opening" data-testid="chat-opening">
              <div class="chat__opening-body">
                <p class="chat__opening-text">{{ chat.opening }}</p>
                <div class="chat__opening-actions">
                  <!-- ★ 动作按钮只在**有知识点可去**时渲染：没有目标却给一个「去吧」，
                       学生点下去会什么都不发生。 -->
                  <!-- ★★ P2-4：按钮上**写明它要去哪个知识点**。
                       走查时开场白是「先从语音助手开始怎么样？」，而按钮只写「就从这里开始」——
                       学生把它读成「有个语音助手功能」的邀请，点麦克风却被告知「语音输入未接入」，
                       于是看起来像「说好的功能没了」。
                       而那个「语音助手」其实是**教材里的知识点**（第五章 5.2.2，语音识别 + 语音合成的
                       组合应用）—— 把它从推荐池里剔掉会削掉正经的教材覆盖面，**歧义的解法是把去哪写出来**：
                       按钮变成「就从「语音助手」开始」，「语音助手」在这里就只可能是一个要学的内容。
                       ⚠️ 名字取不到（`openingKpName` 为空）时保留原来的含糊说法 —— 好过一个空格。 -->
                  <button
                    v-if="chat.openingKpId"
                    type="button"
                    class="chat__opening-cta"
                    data-testid="chat-opening-accept"
                    @click="acceptOpening"
                  >
                    <template v-if="chat.openingKpName">就从「{{ chat.openingKpName }}」开始</template>
                    <template v-else>好啊，就从这里开始</template>
                  </button>
                  <!-- 出口：学生有权跳过引导（不是「拒绝」，只是换话题 —— 所以不做成否定按钮） -->
                  <button
                    type="button"
                    class="chat__opening-skip"
                    data-testid="chat-opening-skip"
                    @click="chat.acceptOpening()"
                  >
                    我想问别的
                  </button>
                </div>
              </div>
            </div>


            <!-- ★★ 还没配置模型（没填 Key）：**进门就说清**，而不是等学生打完整句话、
                 按下发送、等一会儿才收到一句技术口吻的失败提示（实测缺陷，见
                 `needsLlmSetup` 的注释）。
                 ★ 两半各说各的话（双视角纪律）：老师看到「去填什么」，
                   学生看到「找谁」。
                 ★★ 2026-09-22 设计评审（C3）：末句「下面那三样本地功能现在就能用」
                   **已删** —— 正下方就是四张能力入口卡，它们本身就是那个证明；
                   提示里再复述一遍只是把同一件事说两遍。破折号长句也改成两句短句（C16）。 -->
            <div v-if="needsLlmSetup" class="chat__llm-note" data-testid="chat-llm-unconfigured">
              <TriangleAlert :size="14" class="chat__llm-ico" />
              <p class="chat__llm-text">
                <template v-if="viewMode.isTeacher">
                  还没配置模型：在设置页填上供应商与 API Key 并保存，就能正常对话。
                </template>
                <template v-else>
                  智团团还没接上云端大脑，现在问问题还答不了。请老师或家长在「设置 → 高级设置」里配置一下。
                </template>
              </p>
              <button
                type="button"
                class="chat__llm-cta"
                data-testid="chat-llm-setup"
                @click="goSettings"
              >
                <Settings2 :size="14" />
                <span>打开设置</span>
              </button>
            </div>

            <div class="chat__entries">
              <button
                v-for="e in entries"
                :key="e.key"
                type="button"
                class="k12-card chat__entry"
                @click="onEntry(e.to)"
              >
                <span class="chat__entry-ico"><component :is="e.icon" :size="16" /></span>
                <span class="chat__entry-text">
                  <span class="chat__entry-label">{{ e.label }}</span>
                  <span class="chat__entry-desc">{{ e.desc }}</span>
                </span>
              </button>
            </div>

            <div class="chat__suggests">
              <button
                v-for="s in suggestions"
                :key="s"
                type="button"
                class="chat__suggest"
                data-testid="starter-question"
                @click="fillComposer(s)"
              >
                {{ s }}
              </button>
            </div>
          </div>

          <!-- ── 消息列表 ─────────────────────────────────────────────── -->
          <!-- ★ 开场引导**不在这里**（见上面空态那段注释：它只在会话为空时有值）。 -->
          <template v-else>
            <ChatMessage
              v-for="turn in turns"
              :key="turn.requestId"
              :turn="turn"
              :detail-of="chat.citationDetailOf"
              :branching="branchingEntryId !== null"
              :name-of="studentName"
              @branch="onBranch"
            />

            <!-- 本轮专题：**只报「这一轮在教材的哪一章」**（真实数据）。
                 ★ 2026-10-01（D-131）：原先后面还跟着「建议接着练：<知识点>」，用户点名删掉；
                   它删掉之后这一段的显示条件只认章节 —— 否则没选章节时会留下一个空段落。 -->
            <p v-if="chat.currentChapter" class="chat__topic" data-testid="chat-topic">
              <BookMarked :size="13" />
              <span>{{ chat.currentChapter }}</span>
            </p>

            <!-- ── 常驻巩固条：计划那一轮答完后的两路检验 ──────────────────
                 ★ 显示与否**只认 store 的 `planReady` + `planKpId`**：
                   换会话 / 新会话时 store 清空它们，所以「消失」是数据驱动的，
                   本页不存第二份标记位（多一处就多一处忘了清）。
                 ★ 它排在消息列表**末尾**而不进底部固定区：它是对话的一部分
                   （团团刚讲完计划，接着问一句「检验一下？」），
                   进底部区会和输入条抢同一块定位上下文（见 `.chat__foot` 的注释）。 -->
            <div
              v-if="chat.planReady && chat.planKpId !== ''"
              class="chat__consolidate"
              data-testid="plan-consolidate"
            >
              <p class="chat__consolidate-text">这一步学完了？检验一下：</p>
              <div class="chat__consolidate-actions">
                <el-button data-testid="plan-quiz-page" @click="goPlanQuizPage()">去闯关练一练</el-button>
                <el-button data-testid="plan-quiz-chat" @click="askPlanQuizInChat()">现在考考我</el-button>
                <!-- ★ 换一批与「现在考考我」**共用同一条 send**（见 askPlanQuizMore 的说明）：
                     同一个动作的两种说法，学生按哪个都一样。 -->
                <el-button data-testid="plan-quiz-more" @click="askPlanQuizMore()">换一批</el-button>
              </div>
              <!-- ── 刚出的那几道题：来源标注 + 去个性化学习 ──────────────────
                   ★ 卡片本身由 ChatMessage.vue 渲染（那是最密的守卫组件之一），
                     本页插不进它与正文之间，所以这两行落在**紧接卡片的巩固条**里
                     （卡片正下方的第一条）—— 2026-09-30 用户裁决：为一行标注给
                     ChatMessage 加插槽不划算，卡片头上本来就有来源胶囊。
                   ★ 来源文案与卡片头 / 个性化学习页**共用同一条**（quizSourceLabel），
                     本页不另写一份。 -->
              <template v-if="latestPlanQuiz !== null">
                <p class="chat__consolidate-source" data-testid="plan-quiz-source">
                  {{ latestPlanQuizSource }}
                </p>
                <p class="chat__consolidate-note">
                  这几道题也会出现在「个性化学习」里，随时能再做一遍。
                </p>
                <div class="chat__consolidate-actions">
                  <el-button data-testid="plan-open-quiz-page" @click="goPlanQuizPage()">
                    去个性化学习里做这几道题
                  </el-button>
                </div>
              </template>
            </div>
          </template>

          <!-- ── 冷启动引导（五问）：**对话流里的一条普通助手消息** ─────────
               ★★ 位置就是它的语义（决策① / 票 31）：它排在消息列表**同一列**的末尾。
               ★★ 2026-09-29 用户裁决：**去掉卡片壳**。
                  此前它是一个套了边框 + 圆角 + 底色的独立卡片、还带一条
                  「第 N 个问题，共 5 个」的流程进度 —— 读起来是「界面弹了个问卷」，
                  而不是「团团在跟我说话」。现在它长得**和上面每一条助手消息一样**：
                  头像 + 「智团团」+ 一张纸面，学生看到的是人在问。
               ★ 进度条已删（用户：像普通聊天就不该有流程提示）。学生仍能从上文看出
                 问到哪了；真要数，五问本身很短。
               ★ 学生面**只有问句 + 他的回答**：不写「第几步流程」「引导」「onboarding」这类系统词。
               ★ 没有跳过入口（票 31 用户裁决）：五问未答完就一直问，直到 done。
               ★★ 2026-09-30 用户裁决（推翻了 2026-09-29 的形态与提交方式）：
                  ① 引导期**不进对话、不调模型** —— 回答只交回 `onboarding.submitAnswer`，
                     所以不会每题换来一条模型回复、也不会把问答堆进一条会话里；
                  ② 已经答过的问答由本页从 `onboarding.transcript` 渲染成「团团问 / 我答」；
                  ③ 第 1 问带选项，点一下**直接提交**并进入第 2 问；第 2–5 问学生自己写；
                  ④ 第 5 问答完引导区整块消失，页面回到**正常的新对话页**（引导不留会话历史）。
               守卫：`renderer-onboarding.test.ts` 的「引导期不进对话」「同一个出口」。 -->
          <div v-if="onboarding.active" class="chat__onboarding" data-testid="onboarding-flow">
            <template v-for="entry in onboarding.transcript" :key="entry.questionId">
              <article class="chat__ask">
                <img class="chat__ask-avatar" :src="DEFAULT_LOGO_URL" :alt="''" aria-hidden="true" draggable="false" />
                <div class="chat__ask-col">
                  <div class="chat__ask-meta">
                    <span class="chat__ask-who">智团团</span>
                  </div>
                  <div class="chat__ask-paper">
                    <p class="chat__ask-text">{{ questionTextOf(entry.questionId) }}</p>
                  </div>
                </div>
              </article>
              <div class="chat__answer" data-testid="onboarding-answer">
                <p class="chat__answer-bubble">{{ entry.answerText }}</p>
              </div>
            </template>

            <article class="chat__ask" data-testid="onboarding-question">
              <img class="chat__ask-avatar" :src="DEFAULT_LOGO_URL" :alt="''" aria-hidden="true" draggable="false" />
              <div class="chat__ask-col">
                <div class="chat__ask-meta">
                  <span class="chat__ask-who">智团团</span>
                </div>
                <div class="chat__ask-paper">
                  <p class="chat__ask-text" data-testid="onboarding-question-text">
                    {{ onboarding.currentQuestion?.text }}
                  </p>
                  <!-- 只有第 1 问带选项（`chips: []` 的那四问没有这一块） -->
                  <div
                    v-if="(onboarding.currentQuestion?.chips.length ?? 0) > 0"
                    class="chat__ask-chips"
                    data-testid="onboarding-chips"
                  >
                    <button
                      v-for="option in onboarding.currentQuestion?.chips ?? []"
                      :key="option"
                      type="button"
                      class="chat__ask-chip"
                      data-testid="onboarding-chip"
                      @click="pickOnboardingOption(option)"
                    >
                      {{ option }}
                    </button>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </div>
      </div>

      <!-- ── 底部区（输入条 + 待发送 + 回到最新）─────────────────────────
           ★★ 这三样必须**放在同一个定位上下文**里，否则会互相压住。
           实测踩到过：`回到最新` 用 `bottom: 92px`（相对整个 .chat 定位）时，
           它的下边缘落在 810px、而输入条的上边缘在 793px —— **重叠 17px**，
           等于按钮压在输入框的边框上：学生想点输入框却点到按钮（然后被滚到底部，
           一脸茫然），而输入条一变成多行、高度一变，这个魔数就彻底失效。
           现在改成：按钮 `bottom: calc(100% + 8px)` 相对**这个 foot 容器**定位 ——
           永远浮在整个底部区（含待发送条与多行输入条）**之上**，且不依赖任何高度常量。 -->
      <div class="chat__foot">
        <!-- 「回到最新」：只有学生**自己翻上去**时才会出现。
             ★ 它出现的意义正是「不打扰」的配套：停住是为了让他读完旧内容，
               那么这个按钮就是告诉他「下面还有新的，读完再点」。 -->
        <Transition name="jump">
          <button
            v-if="showJump"
            class="chat__jump"
            type="button"
            data-testid="chat-jump-latest"
            @click="scrollToBottom"
          >
            <ArrowDown :size="15" />
            回到最新
          </button>
        </Transition>

        <!-- 待发送：回答还在生成时学生又发了一条 → 排队，并**看得见**。
             ★ 这一条的存在就是「不再静默丢弃」的可见证据（见 stores/chat.ts 的 queuedText）：
               输入框已清空，字在这里；学生知道系统收下了，回答讲完就轮到他。 -->
        <Transition name="jump">
          <div v-if="chat.queuedText" class="chat__queued" data-testid="chat-queued">
            <Clock :size="14" />
            <span class="chat__queued-text">
              待发送：<b>{{ chat.queuedText }}</b>
            </span>
            <span class="chat__queued-note">回答讲完就发出去</span>
            <button
              type="button"
              class="chat__queued-cancel"
              data-testid="chat-queued-cancel"
              @click="chat.cancelQueued()"
            >
              取消
            </button>
          </div>
        </Transition>
        <p v-if="chat.queueNotice" class="chat__queued-warn" data-testid="chat-queued-notice">
          {{ chat.queueNotice }}
        </p>

        <!-- 输入条。
             ★ 票 31：五问问句已**移入对话流**（见上面消息列末尾那一块），
               所以底部区只剩输入条 / 待发送 / 回到最新三样 —— 它们仍在同一个定位上下文里。 -->
        <div class="chat__composer">
          <MessageComposer ref="composerRef" @send="onSend" />
        </div>

      </div>
      <!-- /chat__foot -->

      <!-- 本地提示（桥缺失、发送被拒等；这些不是 6 事件里的 error） -->
      <p v-if="chat.localNotice" class="chat__notice" data-testid="local-notice">
        <ShieldAlert :size="13" />
        <span>{{ chat.localNotice }}</span>
      </p>
      <!-- ★★ 这一句是**学生面**：原来写「对话通道未接通（preload 没有加载）。」——
           `preload` 这个词学生读不懂。接线细节（preload 没加载 / 检查 contextIsolation）
           由 `stores/chat.ts` 的 `connect()` 经 `warnWiring('chat.connect', …)` 打进控制台，
           这里只说学生能感知的事（2026-09-22 报告 0.2 + 双视角 D-063）。 -->
      <p v-else-if="!chat.bridgeReady" class="chat__notice" data-testid="local-notice">
        <TriangleAlert :size="13" />
        <span>对话暂时用不了，需要时请老师帮忙看看。</span>
      </p>
    </div>

    <!-- ── 右栏 ─────────────────────────────────────────────────────── -->
    <!-- ★ 不能用 `v-model:open`：两栏的状态是 store 里的（`stores/panels.ts`），
         `v-model` 会对一个只读 computed 写值。显式绑 `:open` + `@update:open`，
         走的是与工具条那个开关**同一个** store action。 -->
    <ContextRail :open="railOpen" @update:open="setRailOpen" />
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  height: 100%;
  min-height: 0;
  position: relative;
}

/* 历史对话列的可折叠外壳（宽度随内层那一列走）。
 * ★ 宽度的唯一来源仍是 `SessionList.vue` 的 `.sl`（236 / 窄屏 60）——
 *   这里只负责「收起时整列不参与布局、也不参与体检量测」。 */
.chat__side {
  flex: none;
  display: flex;
  min-height: 0;
}
.chat__side--closed :deep(.sl) {
  display: none;
}
/* 主列 = 一整张纸。对话区是**方格纸工作面本身**（透出外壳的页面底色），
 * 回答与卡片是**压在方格纸上的白纸**：有厚度、有边界，与桌面区分开。
 * 这个层次关系是整个视觉的地基 —— 桌面是「能画能算的地方」，纸是「内容」。 */
.chat__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* ── 信息条：章节 + 本轮对话 + 两个栏开关，**同一行** ────────────────────
 * ★★ 这一条取代了原来的**两条**（`.chat__indicators` + `.chat__bar`）：报告 4.1 的原话是
 *   「侧栏竖线 + 顶栏下线 + 章节条下线 + 本轮对话条下线，才到内容」—— 4 条线里
 *   有两条说的是同一件事（这段对话在什么状态），合成一条即可（4.4 的示意同此）。
 * ★ 底色**不铺白**：这一行属于「桌面层」（透出页面底色），白色只留给纸张（消息与卡片）。
 * ★ 分隔线由这一行画、不由指示器自己画 —— 各画一条就会叠成双线（「错位」观感的一半，
 *   见 `ChapterIndicator.vue` 的同名说明）。 */
.chat__bar {
  flex: none;
  display: flex;
  /* ★★ 首行对齐用 `flex-start`（不是 `center`）：章节目录展开时这一条会长高，
   *   `center` 会把 32px 的开关与「本轮对话」一起拽到那一大块中间。
   *   各组的首行自然落在同一条线上（左 / 右组的内容本来就 32px 高，
   *   章节那一项的首行在 `ChapterIndicator.vue` 里钉成 32px）。 */
  align-items: flex-start;
  gap: 12px;
  padding: 8px 24px 9px;
  /* 工具条属于桌面层，不铺纸 —— 它是「桌上的工具」，不是内容 */
  /* ★ 2026-09-27：这条线下线（分隔「工具栏 / 内容」的窗口级横线）统一到
   *   `--k12-border-strong` 档。站点里有四条**窗口级**的分面线（侧栏竖线、
   *   顶栏下线、本条、右栏竖线），此前深浅不一（有的 70% 淡线、有的实线）——
   *   读起来像四张不同图纸拼的。本轮四条统一：结构分面走 strong（2.35:1），
   *   卡片发丝线才走 `--k12-border`（1.50:1）。 */
  border-bottom: 1px solid var(--k12-border-strong);
}
.chat__bar-left {
  /* `none` 而不是 `flex: 1`：让出中段给章节指示器 —— 章节名可以截断，
   * 而「本轮对话 / N 轮」这几个字不该被压（它们是这一条的读法起点）。 */
  flex: none;
  min-width: 0;
  display: flex;
  /* ★ 这一行里既有 32px 的图标开关、也有两段文字 —— **按中心线对齐**，
   *   这样它与右端的 `rail-toggle`（那一组本来就是 `center`）落在同一条线上。
   *   ⚠️ 别改回 `baseline`：图标按钮的「基线」是盒子底边，会高出文字 4px（实测）。 */
  align-items: center;
  gap: 10px;
}
/* 章节指示器占中段（`ChapterIndicator` 的根元素）：宽度富余时它左对齐，
 * 不够时**它可以被压**（`min-width: 0`）—— 章节名截断比把开关挤出去好。 */
.chat__bar-chapter {
  flex: 1 1 auto;
  min-width: 0;
}
/* 两段文字的小容器：内部仍按**基线**对齐（13px 标题 + 12px 元信息） */
.chat__bar-titles {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.chat__bar-title {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.chat__bar-meta {
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat__bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.chat__bar-btn {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .chat__bar-btn:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
.chat__bar-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  /* ★★ 2026-10-01 用户裁决（D-137）：「按钮因为背景颜色导致不清楚、没有边界」。
   *   此前这里是 `background: transparent` + 1px `--k12-border`（1.47:1）——
   *   淡到在带色调的信息条上读不出边界，看着像一段装饰而不是按钮。
   *   现在与同一行的 `.chat__bar-btn`（白底 + 描边 + 投影）**同一套配方**：
   *   一屏之内的同类控件必须长得一样，否则学生得逐个试才知道哪个能点。 */
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
  color: var(--k12-fg-2);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .chat__bar-icon:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
/* 按下（= 该栏已展开）：浅色填充 + **实色强调边框** ——
 * 原来用的是 `--k12-accent-border`（更淡的一档），在浅底上仍然读不出「开着」。 */
.chat__bar-icon[aria-pressed='true'] {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent);
  color: var(--k12-accent-ink);
}

/* ── 对话滚动区 ───────────────────────────────────────────────────────── */
.chat__col {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--k12-sp-5) var(--k12-sp-5) var(--k12-sp-2);
  display: flex;
  flex-direction: column;
}
/* 阅读栏：14px 中文约 55 字/行；窄窗口下自动收窄而不是被裁掉 */
.chat__inner {
  width: 100%;
  max-width: var(--k12-w-reading);
  margin: 0 auto;
  flex: 1 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap-msg);
}
/* ── 冷启动引导（五问）：**对话流里的一条普通助手消息** ────────────────────
 * ★ 票 31：它住在消息列（`.chat__inner`）里，排在消息末尾 —— 读作「团团接着问了一句」。
 *   所以这里不需要 `order`（那是为了把它从底部区提上来才有的），也不需要浮卡式定位；
 *   布局由父容器的 flex 列 + `gap: var(--k12-gap-msg)` 管。
 *
 * ★★ 2026-09-29 用户裁决：**去掉卡片壳**。此前它带 `border` + `border-radius` +
 *   `box-shadow`，是一个**套了壳的独立卡片** —— 与上面每一条助手消息并排时，
 *   学生会读成「界面弹了个问卷」。现在这几条壳体属性一个不留，形态与
 *   `ChatMessage.vue` 的 `.turn__ai` 完全对齐（头像 28px + 名字 + 纸面），
 *   两张纸面之间靠 `.chat__inner` 的 `gap` 分开 ——「一排消息」的读法就立住了。
 * ★ 复用 `.turn__ai` / `.avatar` / `.answer` 的同一条口径但**不共用类名**：
 *   那两个组件是父子关系之外的兄弟（ChatMessage 是子组件、本块在 Chat.vue 里），
 *   scoped 样式跨不过去。若要共享类名就只能把样式提到全局，那会把「对话气泡」
 *   这个只在消息流里成立的东西泄漏到别处。所以这里按同一把尺子重写一遍。
 * ⚠️ 纸面底色用 surface（不是 surface-2）：它是**助手在说话**，与右侧的学生气泡
 *    （surface-2）必须一眼分得开。 */
.chat__ask {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.chat__ask-avatar {
  width: 28px;
  height: 28px;
  object-fit: contain;
  flex: none;
  user-select: none;
}
.chat__ask-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap-block);
}
.chat__ask-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.chat__ask-who {
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  color: var(--k12-muted);
}
/* 纸面：与 `ChatMessage.vue` 的 `.answer` 逐条同款（radius-card + surface + 1px 线 +
 * shadow-card）—— 这是「一条助手消息」的全部视觉构成。 */
.chat__ask-paper {
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap-block);
  padding: 16px 18px;
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
}
.chat__ask-text {
  font-size: var(--k12-fs-body);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  word-break: break-word;
}
/* 选项 chip：可点、点一下**填进输入框**（不直接发）。28px 触控下限与别处一致。 */
.chat__ask-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chat__ask-chip {
  min-height: 28px;
  padding: 4px 12px;
  border: 1px solid var(--k12-border-strong);
  /* ★ 走 token 而不是写死 999px：本仓库的圆角守卫（tests/radius-tokens.test.ts）
     只允许 token 或 50%/0 —— 写死具体像素就等于把圆角梯度绕过去了。 */
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .chat__ask-chip:hover {
    border-color: var(--k12-accent-border);
    color: var(--k12-accent-ink);
    background: var(--k12-accent-soft);
  }
}
/* 引导的问答列：一问一答按同一个消息间距挨着排；答完第 5 问整块消失（回到新对话页）。 */
.chat__onboarding {
  display: flex;
  flex-direction: column;
  gap: var(--k12-gap-msg);
}
/* ── 学生答的那一句（引导期由本页渲染，**不是**会话消息）────────────────────
 * 与 `ChatMessage.vue` 的 `.turn__user` / `.bubble` 逐条同款（右对齐 + surface-2 +
 * 右侧一道墨线）—— 读起来必须是「我答的那句」。scoped 样式跨不过子组件，
 * 所以按同一把尺子重写一遍（与上面 `.chat__ask` 对 `.turn__ai` 同一条理由）。 */
.chat__answer {
  display: flex;
  justify-content: flex-end;
}
.chat__answer-bubble {
  max-width: min(560px, 78%);
  padding: 10px 14px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-right: 3px solid var(--k12-accent);
  color: var(--k12-fg);
  font-size: var(--k12-fs-body);
  line-height: var(--k12-lh-ui);
  white-space: pre-wrap;
  word-break: break-word;
}
.chat__composer {
  width: 100%;
  max-width: calc(var(--k12-w-reading) + 40px);
  margin: 0 auto;
  flex: none;
  padding: 0 var(--k12-sp-5) var(--k12-sp-4);
}

/* ── 底部区（回到最新 + 待发送 + 输入条）─────────────────────────────────
 * ★★ 这个容器存在的唯一理由是**给「回到最新」一个正确的定位上下文**。
 *   旧写法把按钮直接挂在 `.chat` 上用 `bottom: 92px` —— 那是按「输入条大约 92px 高」
 *   试出来的魔数，实测它的下边缘落在 810px、而输入条上边缘在 793px，**重叠 17px**：
 *   按钮压在输入框边框上，学生想点输入框却点到按钮（然后被滚到底，一脸茫然）。
 *   而且输入条一变成多行、高度一变，魔数就彻底失效。
 *   现在按钮用 `bottom: calc(100% + 8px)` 相对本容器定位 —— 永远浮在整个底部区之上，
 *   与输入条实际多高无关。 */
.chat__foot {
  position: relative;
  flex: none;
  display: flex;
  flex-direction: column;
}

/* ── 「回到最新」浮标 ─────────────────────────────────────────────────────
 * 位置：底部区**正上方居中**（离输入框近 = 离学生的下一个动作近），
 * 而不是右下角那种社交软件的固定悬浮球 —— 后者会盖住正文末段的字。
 * 尺寸走 34px 高（≥28px 的触控下限，见 ux-audit 的 C1）。 */
.chat__jump {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--k12-r-pill);
  border: 1px solid var(--k12-accent-border);
  background: var(--k12-surface);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-body-sm);
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--k12-shadow-raise);
}
@media (hover: hover) and (pointer: fine) {
  .chat__jump:hover {
    background: var(--k12-accent-soft);
  }
}
.jump-enter-active,
.jump-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.jump-enter-from,
.jump-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}

/* ── 待发送条 ─────────────────────────────────────────────────────────────
 * 位置在输入条正上方（与「回到最新」同一带），是**状态**不是弹窗：
 * 不遮挡正文、不抢焦点、也不需要学生关掉 —— 回答讲完它自己就变成一轮对话。 */
.chat__queued {
  width: 100%;
  max-width: calc(var(--k12-w-reading) + 40px);
  margin: 0 auto;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-top: 1px solid var(--k12-accent-border);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-body-sm);
}
.chat__queued-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat__queued-text b {
  font-weight: 650;
}
.chat__queued-note {
  margin-left: auto;
  flex: none;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}
.chat__queued-cancel {
  flex: none;
  min-height: 28px;
  padding: 4px 12px;
  border: 1px solid var(--k12-accent-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  cursor: pointer;
}
/* 「上一条被替换」提示：比待发条低一档（它是一次性说明，不是持续状态） */
.chat__queued-warn {
  width: 100%;
  max-width: calc(var(--k12-w-reading) + 40px);
  margin: 0 auto;
  flex: none;
  padding: 6px 14px 8px;
  font-size: var(--k12-fs-caption);
  color: var(--k12-warn);
  background: var(--k12-warn-soft);
}

/* ── 空态 ─────────────────────────────────────────────────────────────── */
.chat__empty {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 24px;
  min-height: 100%;
  padding-bottom: 24px;
}
@media (max-height: 640px) {
  .chat__empty {
    justify-content: flex-start;
    gap: 18px;
  }
}
.chat__hello {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 空态的品牌标记：吉祥物原图。
 * ★ 原实现是一个 44px 的 accent 实心方块 + 一个图标 —— 那是「占位标记」的画法。
 *   换成真图之后**不能保留那个色块底**：logo 本身带透明通道与完整配色，
 *   再垫一层 accent 底会在边缘露出一圈不属于它的颜色（且四个学段的 accent 各不相同，
 *   等于同一个 logo 在每个学段边缘都不一样）。
 * ★ `object-fit: contain` + 稍大的尺寸：素材是 256×256 的正方形插画，
 *   直接用 `cover` 会把耳朵切掉。 */
.chat__hello-mark {
  width: 52px;
  height: 52px;
  object-fit: contain;
  margin-bottom: 2px;
  /* 图片不可拖拽（`draggable="false"` 在模板上）：否则按住它会把图拖出去，
   * 在 Electron 里表现为「窗口突然开始拖拽」或是拖出一个幽灵图。 */
  user-select: none;
}
.chat__hello-title {
  /* ★ 首屏问候是 40px 大字 → 用 display 那一套（圆润的阅读体）；
   *   副标题与其余小字继续用 `--k12-font-ui`（黑体，小字号才立得住）。 */
  font-family: var(--k12-font-display);
  font-size: var(--k12-fs-hero);
  font-weight: 650;
  line-height: var(--k12-lh-tight);
  letter-spacing: -0.01em;
  color: var(--k12-fg);
}
.chat__hello-sub {
  font-size: var(--k12-fs-body);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  max-width: 58ch;
}
/* ⚠️ `.chat__hello-grade`（「当前按 XX 的讲法回答。」那一行）**已删** ——
 *   2026-09-30 用户裁决。它原本是报告 2.1/4.2 收出来的「一行灰字」，
 *   但同一个状态在顶栏学段指示器、侧栏身份卡已经各说了一次，这一行只是第三次复读；
 *   而主动引导现在要占用这个位置（见下）。 */

/* 「还没配置模型」那条提示：**这一屏里唯一的黄**（报告 2.4 的收敛口径：
 * 「黄条仅保留『模型未就绪且阻断对话』一种」）—— 上面的学段行已改成灰字，
 * 所以它不再需要跟一块同版式的灰盒并排。
 * ★ 不用红色：这不是故障，是「还差一步配置」（红会让老师以为软件坏了）。 */
.chat__llm-note {
  background: var(--k12-warn-soft);
  border: 1px solid color-mix(in srgb, var(--k12-warn) 30%, transparent);
  /* 左侧强调条：这是**要动手的一条提示**（去配模型），不是一屏普通文字。
   * 3px 的实色只加在左边一条上 —— 底色仍是 warn-soft，四边线仍然很淡，
   * 所以它读起来是「强调」而不是「报错」（红与满框实线都会读成故障）。 */
  border-left: 3px solid var(--k12-warn);
  border-radius: var(--k12-r-inset);

  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 13px;
  max-width: 72ch;
}
.chat__llm-ico {
  flex: none;
  color: var(--k12-warn);
}
.chat__llm-text {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.chat__llm-cta {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 11px;
  min-height: 28px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
  cursor: pointer;
}

.chat__entries {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
/* 能力卡 = **纸面**：皮肤（白底 + 1px 线 + 圆角 + shadow-card）唯一来源是
 * base.css 的 `.k12-card`（根元素已挂该类），这里不再自写第二份。
 * ★ 本组件只覆盖**线的颜色**：纸与桌面之间那条边界走「学段色淡边框」——
 *   四张卡并排时属于同一组入口，一条比 `--k12-border` 暖一点点的线就够把它们
 *   与普通内容块分开，不需要更重的底色或投影。 */
.chat__entry {
  /* hover 微光（::before）的定位容器 */
  position: relative;
  border-color: color-mix(in srgb, var(--k12-accent) 14%, var(--k12-border));

  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 9px;
  padding: 13px 13px 14px;
  cursor: pointer;
  text-align: left;
}
/* hover 微光：从左上角落下的一抹极淡学段色（5%）。
 * ★ 为什么改掉「整块换浅紫」：一屏四张卡，指针扫过时四块纸轮流变色太吵；
 *   微光把「指针在这张纸上」说清楚，颜色仍然归纸自己所有。
 * ★ 只动 opacity（不引入 transform）—— 所以不需要另写一份减动效替代表达：
 *   系统偏好 reduce / 用户选「开启」时，全局那条把时长压到 0.01ms，
 *   终态（opacity 0/1）与常态一字不差。 */
.chat__entry::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(135deg, color-mix(in srgb, var(--k12-accent) 5%, transparent), transparent 70%);
  opacity: 0;
  transition: opacity var(--k12-dur-state) var(--k12-ease-state);
  /* 微光只是皮肤：它盖在纸与字**之间**，不参与命中（点它等于点这张卡） */
  pointer-events: none;
}
@media (hover: hover) and (pointer: fine) {
  .chat__entry:hover {
    border-color: var(--k12-accent-border);
    /* 4% 的学段色打在白纸上：hover 仍有底色反馈，但不再把整块纸染成浅紫 */
    background: color-mix(in srgb, var(--k12-accent) 4%, var(--k12-surface));
  }
  .chat__entry:hover::before {
    opacity: 1;
  }
}
.chat__entry-ico {
  /* ⚠️ 必须给内部内容一条定位：定位伪元素（z-index: auto）在层叠里**画在
   *   普通流内容之上**，不加这行微光会罩住图标与文字（实测：伪元素先于
   *   定位后的内容绘制，同层按树序 → 内容在上）。 */
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--k12-r-control);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
.chat__entry-text {
  /* 理由同上：文字要在微光之上 */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.chat__entry-label {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.chat__entry-desc {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

.chat__suggests {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* ★★ 2026-09-30 用户裁决：原来 `background: transparent` 太不起眼，
 *   学生看不出这是**三个可点的按钮**（读成三句灰字）—— 改成白底 + 60% 毛玻璃。
 *   ★ 60% 是分档表里最透的一档：它背后是本页的平板底色（没有内容经过），
 *     所以透明度只影响观感、不影响可读性（分档表见 base.css 的 `.k12-glass`）。
 *   ★ 边框同时升到强线：底色变白之后，发丝线在浅底上读不出"这是个按钮"。 */
.chat__suggest {
  padding: 8px 13px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-pill);
  /* 不支持 backdrop-filter 的环境退回实色白（半透明底会把下面的内容透上来）。 */
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-caption);
  cursor: pointer;
}
@supports (backdrop-filter: blur(1px)) {
  .chat__suggest {
    background: color-mix(in srgb, var(--k12-surface) 60%, transparent);
    backdrop-filter: blur(12px) saturate(1.4);
  }
}
@media (hover: hover) and (pointer: fine) {
  .chat__suggest:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}

/* ── 主动发起的开场引导 ───────────────────────────────────────────────────
 * 它是**助手说的第一句话**，所以视觉上要与回答气泡同族（白纸 + 圆角），
 * 但左侧那条强调竖条把它与「模型的回答」区分开：
 * 这一条不是对学生提问的回应，是系统主动开口。
 * ★ 与空态的大小不同：空态是「还没开始」的一屏，这条是**已经开始的对话的第一句**，
 *   所以它按正文的密度排版（不是按落地页）。 */
.chat__opening {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  /* 它排在问候**之后**（2026-09-30）：不再是"顶替问候的第一块"，
   * 所以左右不再需要额外对齐品牌位 —— 保留纸张形态与那条强调竖条即可。 */
  padding: 13px 15px;
  border: 1px solid var(--k12-border);
  border-left: 3px solid var(--k12-accent-ink);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}
/* ⚠️ `.chat__opening-mark`（开场卡自带的 30px 小 logo）**已删**：
 *   2026-09-30 用户裁决「不要把图标缩小」—— 空态的品牌标记恒用上面那个 52px 的大吉祥物，
 *   开场卡不再自带第二个小图标（同一屏两个智团团，一大一小）。 */
.chat__opening-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.chat__opening-text {
  font-size: var(--k12-fs-body);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg);
}
.chat__opening-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* 主动作：实心 accent（这是「接受引导」—— 一次明确的承诺）
 * ★ min-height 28px：UX 体检 C1 的触控下限（可点元素不得低于 28px）。 */
.chat__opening-cta {
  min-height: 30px;
  padding: 6px 14px;
  border: 1px solid var(--k12-accent-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .chat__opening-cta:hover {
    background: var(--k12-accent);
    color: var(--k12-surface);
  }
}
/* 次动作：描边（「我想问别的」不是拒绝，只是换话题 —— 不做成红色的否定按钮） */
.chat__opening-skip {
  min-height: 30px;
  padding: 6px 14px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: transparent;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-caption);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .chat__opening-skip:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}

/* 本轮专题：正文下方一行「在学什么」 */
.chat__topic {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 6px;
  font-size: var(--k12-fs-caption);
  color: var(--k12-muted);
}

/* ── 常驻巩固条：与开场引导**同一族**（白纸 + 圆角 + 左侧强调竖条）──────────
 * ★ 复用既有配方而不是新写一套皮肤：它也是「系统主动接的一句」（与开场引导同类），
 *   所以那个既有形态就是它的正确外观；新写一份就是又一次漂移
 *   （见 base.css 里 `.k12-cta` 那段「不要抄第六份」的说明）。
 * ⚠️ 两个按钮走 `el-button`（次级样式），这里**不**给它们上主色：
 *   这一屏的主色填充归输入区的发送键。 */
.chat__consolidate {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 13px 15px;
  border: 1px solid var(--k12-border);
  border-left: 3px solid var(--k12-accent-ink);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}
.chat__consolidate-text {
  font-size: var(--k12-fs-body);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg);
}
.chat__consolidate-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* 刚出的那一批题的来源：它是这一块的**小标题**（比正文多半档字重、不抢主色）→ meta 档。 */
.chat__consolidate-source {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg-2);
}
/* 「也会出现在个性化学习里」是补充说明（不是新承诺，见 D-088）→ 说明档灰字。 */
.chat__consolidate-note {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}

.chat__notice {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 0 24px 12px;
  padding: 9px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-body);
}

/* ── 空态能力入口的列数：1440 基准 4 列 → 1024 档 3 列 → 更窄 2 列 ────────
 * 优化报告 §2.2：1024–1279 区间新增 3 列（原来直接从 4 列掉到 2 列，
 * 中间那一档的空白被白白浪费）。 */
@media (max-width: 1439px) {
  .chat__entries {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 1023px) {
  .chat__entries {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
