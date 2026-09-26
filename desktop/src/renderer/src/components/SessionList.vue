<script setup lang="ts">
/**
 * 对话页的**历史会话侧栏**（列表 + 切换续聊 + 新会话）。
 *
 * ---------------------------------------------------------------------------
 * 它补的是哪一个缺口
 * ---------------------------------------------------------------------------
 * 「关掉应用再打开，上一段对话还在」是 `AGENTS.md` §10 点名的必做演练 ——
 * 而在此之前，学生关掉应用再打开，之前的对话在界面上**消失**（数据一直在盘上）。
 * 现在：启动时续上最近的一条（主进程 `sessionSourceForBoot`），
 * 这里则让学生**主动挑**另一条继续聊。
 *
 * ★★ 三件事的分工（别把它们搅在一起）：
 *   - **列表**：`stores/study.ts` 的 `loadSessions()`（它已经有一套完整的
 *     取数/加载态/错误文案，与学习档案的「会话」分页**共用同一份数据**）。
 *     这里不另写一份取数 —— 那会让两处对「有多少条会话」给出不同的答案。
 *   - **切换**：`stores/chat.ts` 的 `openSession()` / `startNewSession()`（唯一写入口）。
 *   - **显示**：本组件只渲染。
 *
 * ★ 「当前是哪一条」**由主进程给**（`chat.currentSessionId`）：渲染进程自己记一个是
 *   第二处真相 —— 而会话文件名、标题、条数全在主进程那一侧。
 *
 * ★ 时间显示用相对说法（「昨天」「3 天前」）而不是 ISO 时间戳：
 *   学生看列表时想知道的是「这是不是上次那段」，不是精确到秒的时间。
 *
 * ★★ 视角分层（学生 / 教师，2026-09-20）：
 *   「来自『另一条对话』」与「N 条分支」这两行**文字**读起来像数据库外键
 *   （谁引用了谁、有几行子记录）。学生真正用来导航的是**缩进 + 连接线 + 折叠箭头**，
 *   所以：
 *     · 两个标记在**两种视角下都留在 DOM 里**（体检脚本 `ux-audit.mjs` 的 D10 拿
 *       `session-kids-mark` 量几何；`session-branch.test.ts` 断言 `session-branch-mark`
 *       里有 `parentTitle`）——**只改文字显不显示**；
 *     · 学生视角：只剩一个小图标，说明放进 `title` 悬停提示（鼠标停一下就有）；
 *     · 教师视角：文字照旧显示。
 *   ⚠️ 这里用 `viewMode.isTeacher` 而不是 `<TeacherGate>`：后者渲染一个 `<section>`，
 *      而这两个标记在 `<button>` 内部 —— 块级元素塞进按钮是非法嵌套。
 *      （TeacherGate 仍用于所有成块的技术分节。）
 *
 * ⚠️ 窄窗口（<1280px）这一列会**收成一条窄栏**（只留「新会话」按钮 + 条目首字），
 *   与左导航栏同一档断点 —— 1440×900 是设计基准，1120 是最小宽度。
 */
import { computed, onMounted, ref, watch } from 'vue'
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Ellipsis,
  GitBranch,
  MessageSquarePlus,
  Plus,
  Trash2
} from 'lucide-vue-next'
import { useChatStore } from '../stores/chat'
import { useConfirm } from '../stores/confirm'
import { useStudyStore, type SessionSummaryShape } from '../stores/study'
import { displaySessionTitle } from '../study/session-title'
import { useViewModeStore } from '../stores/viewMode'
import { useDismissable } from '../composables/useDismissable'

const chat = useChatStore()
const confirm = useConfirm()
const study = useStudyStore()
const viewMode = useViewModeStore()

/** 正在切换的那一条（点了之后要看到反馈；`''` = 没有在切换）。 */
const switchingId = ref('')
/** 切换失败的提示（一次性，与 `chat.localNotice` 分工：那条是对话通道的）。 */
const notice = ref<string | null>(null)

onMounted(() => {
  // 幂等：学习档案的「会话」分页也调它，重复调用只是再取一次。
  void study.loadSessions()
})

/**
 * ★★ **本会话长出新内容时重取列表**（这一条是实测补的）。
 *
 * 为什么必须有：新会话的第一轮跑完之前，它在磁盘上**还不存在** ——
 * Pi 的 `_persist` 要等第一条 assistant 消息到达才写文件。
 * 所以「新建 → 聊一句」之后不重取的话，左侧列表仍然是空的，
 * 学生刚聊完一段却发现历史里没有它（会以为没保存）。
 *
 * ★ 判据用 `messageCount` 这个**有语义的数**（不是「turns 长度」那种渲染层代理量）：
 *   它由主进程按会话文件算出并推送，与列表看到的是同一份事实。
 */
watch(
  () => chat.currentSessionMessageCount,
  (now, before) => {
    if (before !== undefined && now !== before) void study.loadSessions()
  }
)

/**
 * ★★ **当前会话变了就刷新列表**（分叉 / 切换 / 新建之后）。
 *
 * 为什么单靠 `messageCount` 不够：**分叉出来的新会话带着历史消息**，
 * 它的条数一开始就 > 0，于是「0 → N」那个边沿根本不发生 ——
 * 学生点了「从这里重新问」，切过去了，而左侧列表里**找不到刚分叉出来的那条**。
 * （实测：分叉成功后列表不刷新，要手动点「刷新」才出现。）
 *
 * ★ 同时**展开新会话的祖先**：分叉出来的会话一定挂在某个父下面，
 *   若那个父正好被收起过，新会话会被`collapsed` 挡住 ——
 *   表现与「没刷新」一模一样（都是「点了没出现」）。
 */
watch(
  () => chat.currentSessionId,
  (now, before) => {
    if (before === undefined || now === before || now === '') return
    // ★ 先把祖先展开再取列表：取回来时它才是可见的（否则白取一次）
    const byId = new Map(allItems.value.map((item) => [item.id, item]))
    const chain: string[] = []
    let cursor = byId.get(now)?.parentId ?? null
    for (let guard = 0; cursor !== null && guard < 64; guard += 1) {
      chain.push(cursor)
      cursor = byId.get(cursor)?.parentId ?? null
    }
    if (chain.some((id) => collapsed.value.has(id))) {
      const next = new Set(collapsed.value)
      for (const id of chain) next.delete(id)
      collapsed.value = next
    }
    void study.loadSessions()
  }
)

/**
 * 列表：**已经是树形展开后的顺序**（主进程排好），这里只做折叠过滤。
 *
 * ★ 不再在渲染进程排序：`projectSessionTree` 的排序规则是
 * 「**家族**最新活动倒序 + id 兜底」（见那个函数的说明 —— 从旧会话分叉出来的
 * 新会话不会因为父文件 mtime 不变而沉底）。**两处各排一遍必然不一致**，
 * 而那种不一致表现为「列表顺序偶尔跳一下」，最难查。
 */
const allItems = computed<SessionSummaryShape[]>(() => study.sessions)

/**
 * ★★ **被折叠起来的祖先**（`Set<sessionId>`）。
 *
 * 收起一个节点 = 把它**整棵子树**从列表里藏掉（不是只藏直接子级）——
 * 所以判据是「任一祖先在集合里」，而不是「父在集合里」。
 * 树形列表的通行做法，也让「收起一个根」的行为符合直觉（整枝消失）。
 */
const collapsed = ref<Set<string>>(new Set())

/** 某个 id 的祖先链（含它自己？不含 —— 只要祖先）。 */
function ancestorsOf(id: string): string[] {
  const byId = new Map(allItems.value.map((item) => [item.id, item]))
  const chain: string[] = []
  let cursor = byId.get(id)?.parentId ?? null
  // 上限防坏数据造成死循环（主进程那边已经断过环，这里是第二道）
  for (let guard = 0; cursor !== null && guard < 64; guard += 1) {
    chain.push(cursor)
    cursor = byId.get(cursor)?.parentId ?? null
  }
  return chain
}

/**
 * 可见项 = 祖先都没被收起；★ 并且**在这里就把可选字段归一化**。
 *
 * ★ 为什么归一化放在 computed 里而不是散在模板里：模板里每个 `item.depth`
 *   都要写成 `item.depth ?? 0`，漏一处就是渲染期的 `undefined`；
 *   而归一化只写一次，模板拿到的就是**确定的**形状。
 */
interface TreeRow {
  id: string
  title: string
  modifiedAt: number
  snippet: string
  messageCount: number | null
  parentId: string | null
  parentTitle: string | null
  depth: number
  childCount: number
  isLast: boolean
  guides: boolean[]
}

const items = computed<TreeRow[]>(() =>
  allItems.value
    .filter((item) => !ancestorsOf(item.id).some((id) => collapsed.value.has(id)))
    .map((item) => ({
      id: item.id,
      title: item.title,
      modifiedAt: item.modifiedAt,
      snippet: item.preview,
      messageCount: item.messageCount,
      parentId: item.parentId ?? null,
      parentTitle: item.parentTitle ?? null,
      depth: depthOf(item),
      childCount: childCountOf(item),
      isLast: item.isLast !== false,
      guides: guidesOf(item)
    }))
)

/**
 * 缩进层级。
 *
 * ★ 对**没有树信息**的响应降级成 0（平铺）而不是 `undefined` ——
 * 「拿不到树」应当表现为「就是一份普通列表」，不该渲染成一堆 `undefined`。
 */
function depthOf(item: SessionSummaryShape): number {
  const depth = item.depth
  return typeof depth === 'number' && Number.isFinite(depth) && depth > 0 ? depth : 0
}

/** 祖先竖线（长度应当 == depth；对不上时补 `false`，宁可少画线也不要错位）。 */
function guidesOf(item: SessionSummaryShape): boolean[] {
  const depth = depthOf(item)
  const guides = Array.isArray(item.guides) ? item.guides : []
  return Array.from({ length: depth }, (_unused, index) => guides[index] === true)
}

/** 有没有子分支（> 0 才给箭头）。 */
function childCountOf(item: SessionSummaryShape): number {
  const count = item.childCount
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0
}

function toggleCollapse(id: string): void {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}

/**
 * 行的 hover 提示（`title`）。
 *
 * ★ 把「关系 + 规模」都说全：树形缩进在窄栏里可能不明显，
 *   而 hover 是学生确认「这条到底挂在哪」的兜底。
 * ★ 没有分支时就是标题本身 —— 不要给一条平铺的行加一句「0 条分支」的噪音。
 */
function treeTitle(item: TreeRow): string {
  const parts = [item.title]
  if (item.parentId) parts.push(`从「${item.parentTitle ?? '另一条对话'}」分出来的`)
  if (item.childCount > 0) parts.push(`下面有 ${item.childCount} 条分支`)
  return parts.join(' · ')
}



/** 这一条是不是当前会话（主进程说了算）。 */
function isCurrent(session: { id: string }): boolean {
  return chat.currentSessionId !== '' && session.id === chat.currentSessionId
}

/**
 * ★ 标题的**防御性**兜底：界面不显示「看着像占位符」的裸字符串。
 *
 * ★ 实现已归口到 `study/session-title.ts`（唯一一份）—— 这里只 re-export 一个同名函数，
 *   好处是历史调用点（本文件多处 + 档案页）不必改，而判据不会再分叉。
 *   ⚠️ 曾经本文件自己持有一份 `PLACEHOLDER_TITLES` + `displayTitle`，而
 *   `study/SessionsTab.vue` 直接渲染 `item.title` —— 于是 `(no messages)` 在
 *   学习记录页的历史会话里露了出来（P1-3）。两处各写一份必然再次漂移。
 */
function displayTitle(title: string): string {
  return displaySessionTitle(title)
}

/**
 * 点一条会话：**已经是当前这条就什么都不做**。
 *
 * ★ 重复切换同一会话会 dispose + 重装一次（几秒的装配），而学生的意图
 *   「我要看这一段」在它已经在屏幕上时就已经满足了 —— 白等几秒是纯粹的损失。
 */
async function open(session: { id: string }): Promise<void> {
  if (isCurrent(session) || switchingId.value !== '') return
  notice.value = null
  switchingId.value = session.id
  try {
    const result = await chat.openSession(session.id)
    if (!result.ok) {
      notice.value = result.message ?? '切换会话失败。'
      return
    }
    // 切换成功后**刷新列表**：刚才那条的「最后修改时间」还没变，但
    // 恢复会话本身会让它变成「最近用过的」（下次启动续上的就是它）。
    await study.loadSessions()
  } finally {
    switchingId.value = ''
  }
}

async function createNew(): Promise<void> {
  if (switchingId.value !== '' || chat.sessionSwitching) return
  notice.value = null
  switchingId.value = '__new__'
  try {
    const result = await chat.startNewSession()
    if (!result.ok) {
      notice.value = result.message ?? '新建会话失败。'
      return
    }
    await study.loadSessions()
  } finally {
    switchingId.value = ''
  }
}

/* ── 行菜单（右键 / ⋯）：删除这条对话 ────────────────────────────────────── */

/**
 * ★★ **删除一条历史对话**（唯一入口；**不可撤销** —— 连磁盘上的会话文件一起删）。
 *
 * 为什么行菜单里只有这一项、而且要点两下（菜单 → 确认框）：
 *   它是本项目**唯一会真的丢东西**的操作（对话不在 SQLite 里，删了就是删了）。
 *   学生右键一条列表项时最常见的心思其实是「我想看看有什么能做的」——
 *   菜单一出现就删掉，是那种「手一抖什么都没了」的缺陷。
 * ★ 文案是**学生的话**：不说 JSONL、不说目录、不说「服务端」——
 *   只说「找不回来了」与「会从这台电脑上一起删掉」。
 * ★ 删的是**当前这条**时：主进程会先切到一条新的空白会话（顺序纪律在那边），
 *   界面这边由 `chat.deleteSession()` 负责把屏幕对齐（见它的注释）。
 */
const menuFor = ref<{ id: string; title: string; childCount: number } | null>(null)
/** 菜单落点（视口坐标；贴边回吸之后的值）。 */
const menuX = ref(0)
const menuY = ref(0)
const menuRef = ref<HTMLElement | null>(null)
const menuTriggerRef = ref<HTMLElement | null>(null)
/** 打开菜单前焦点在哪：关掉之后还回去（键盘用户不该因此丢失位置）。 */
let focusBeforeMenu: HTMLElement | null = null

/**
 * 菜单在**视口边缘回吸**。
 *
 * ★ 列表贴着窗口左边（侧栏位），一行也就 236px 宽 —— 从行中间右键弹出菜单时，
 *   右边的菜单很容易超出窗口，超出部分点不到（菜单是 fixed 定位，会被窗口裁掉）。
 * ★ 尺寸写死是有意的：菜单只有一项，宽高是常量；量 DOM 反而要等一帧（会闪一下）。
 */
const MENU_W = 176
const MENU_H = 44

function closeMenu(): void {
  if (menuFor.value === null) return
  menuFor.value = null
  const back = focusBeforeMenu
  focusBeforeMenu = null
  back?.focus?.()
}

// 与模型选择器、消息上的「⋯」同一套关闭手法（Esc + 点外部，见 useDismissable 的说明）
useDismissable({
  panel: menuRef,
  trigger: menuTriggerRef,
  open: () => menuFor.value !== null,
  close: closeMenu
})

/** 打开某一条的行菜单（右键 → 指针处；⋯ 按钮 → 按钮右下）。 */
function openMenu(item: TreeRow, event: MouseEvent, fromTrigger: boolean): void {
  focusBeforeMenu = (event.currentTarget as HTMLElement | null) ?? null
  menuTriggerRef.value = fromTrigger ? ((event.currentTarget as HTMLElement) ?? null) : null
  const anchor = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  const x = event.clientX > 0 ? event.clientX : (anchor?.left ?? 0)
  const y = event.clientY > 0 ? event.clientY : (anchor?.bottom ?? 0)
  menuX.value = Math.max(4, Math.min(x, window.innerWidth - MENU_W - 8))
  menuY.value = Math.max(4, Math.min(y, window.innerHeight - MENU_H - 8))
  menuFor.value = { id: item.id, title: displayTitle(item.title), childCount: item.childCount ?? 0 }
}

/** 确认框正文：只说学生需要知道的那两件事（会丢 / 分支会怎样）。 */
function deleteBody(target: { title: string; childCount: number }): string {
  const head = `「${target.title}」删掉后就找不回来了（这条对话会从这台电脑上一起删掉）。`
  if (target.childCount <= 0) return head
  return `${head}这条下面还有 ${target.childCount} 条从它分出来的对话，删掉它之后那些会变成独立的对话。`
}

async function removeSession(): Promise<void> {
  const target = menuFor.value
  if (!target) return
  closeMenu()
  const ok = await confirm.ask({
    title: '删除这条对话？',
    body: deleteBody(target),
    danger: true,
    confirmText: '删除'
  })
  if (!ok) return
  notice.value = null
  switchingId.value = target.id
  try {
    const result = await chat.deleteSession(target.id)
    if (!result.ok) {
      notice.value = result.message ?? '删除失败。'
      return
    }
    // ★ 删完必须重取列表：这一条已经不在盘上了。`currentSessionId` 的 watcher 只在
    //   「当前会话变了」时触发，删掉一条**不是当前**的会话时它根本不动。
    await study.loadSessions()
  } finally {
    switchingId.value = ''
  }
}

/** 相对时间（列表里最有用的是「多久以前」，不是精确时刻）。 */
function relativeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const days = Math.floor(diff / 86_400_000)
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  const date = new Date(ms)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}
</script>

<template>
  <aside class="sl" data-testid="session-list">
    <div class="sl__head">
      <span class="sl__title">历史对话</span>
      <button
        type="button"
        class="sl__new"
        data-testid="session-new"
        title="开始一段新的对话（旧对话仍然留在下面）"
        :disabled="switchingId !== ''"
        @click="createNew"
      >
        <Plus :size="14" />
        <span class="sl__new-text">新对话</span>
      </button>
    </div>

    <p v-if="notice" class="sl__notice" data-testid="session-notice">{{ notice }}</p>
    <p v-if="chat.sessionBridgeError" class="sl__notice" data-testid="session-bridge-error">
      {{ chat.sessionBridgeError }}
    </p>

    <p v-if="study.sessionsLoading && items.length === 0" class="sl__state" data-testid="session-loading">
      正在读取…
    </p>
    <p v-else-if="study.sessionsError" class="sl__state sl__state--error" data-testid="session-error">
      {{ study.sessionsError }}
    </p>
    <p v-else-if="items.length === 0" class="sl__state" data-testid="session-empty">
      还没有历史对话，问第一个问题就会出现在这里。
    </p>

    <ul v-else class="sl__list" data-testid="session-tree">
      <li
        v-for="item in items"
        :key="item.id"
        class="sl__row"
        :data-depth="item.depth"
        :data-testid="`session-row-${item.id}`"
        @contextmenu.prevent="openMenu(item, $event, false)"
      >
        <!-- ★★ 树形连接线：**深度优先列表 + 每条自己画自己的前导**
             ★ 为什么不用嵌套 `<ul>`：那要在 Vue 里写自引用组件，而列表本身
               是主进程**扁平展开**好的（见 `projectSessionTree`）——
               前导由 `depth` / `guides` / `isLast` 三个数算出来就够。
             ★ `aria-hidden`：这些线是**视觉**结构，屏幕阅读器读到的应该是
               「层级 2」这种语义（由下面的 aria-level 给），不是一堆方格字符。 -->
        <span
          v-if="item.depth > 0"
          class="sl__tree"
          aria-hidden="true"
          data-testid="session-tree-guide"
        >
          <span
            v-for="(hasMore, level) in item.guides"
            :key="level"
            class="sl__tree-seg"
            :class="{ 'sl__tree-seg--more': hasMore }"
          />
          <span class="sl__tree-elbow" :class="{ 'sl__tree-elbow--last': item.isLast }" />
        </span>

        <!-- ★ 折叠箭头：只给**有子分支**的节点（没有子分支还给箭头 = 点了没反应）。 -->
        <button
          v-if="item.childCount > 0"
          type="button"
          class="sl__fold"
          data-testid="session-fold"
          :aria-expanded="!collapsed.has(item.id)"
          :title="collapsed.has(item.id) ? '展开这条的分支' : '收起这条的分支'"
          @click.stop="toggleCollapse(item.id)"
        >
          <component :is="collapsed.has(item.id) ? ChevronRight : ChevronDown" :size="12" />
        </button>
        <!-- 占位：没有箭头的行也要与有箭头的行**左缘对齐**（否则整列文字参差） -->
        <span v-else class="sl__fold sl__fold--ghost" aria-hidden="true" />

        <button
          type="button"
          class="sl__item"
          :class="{ 'sl__item--active': isCurrent(item) }"
          :data-testid="`session-item-${item.id}`"
          :aria-current="isCurrent(item) ? 'true' : undefined"
          :aria-level="item.depth + 1"
          :disabled="switchingId !== ''"
          :title="treeTitle(item)"
          @click="open(item)"
        >
          <MessageSquarePlus :size="14" class="sl__ico" />
          <span class="sl__item-text">
            <span class="sl__item-title">{{ displayTitle(item.title) }}</span>
            <!-- ★★ 两个元信息各管一件事，**不要合并**：
                 - 「来自〈父〉」= **关系**（谁从谁分出来的）——学生靠它认人
                 - 「N 条分支」= **规模**（这条下面还有多少）——学生靠它决定收不收
                 ★ 两种视角下**都留在 DOM 里**（体检脚本按 testid 量几何、
                   `session-branch.test.ts` 断言 `parentTitle` 在里面），
                   学生视角下把文字换成一个**小图标 + `title` 提示** ——
                   真正用来导航的是缩进/连接线/折叠箭头，这两行文字不是。
                 ⚠️ 用 `viewMode.isTeacher` 而不是 `<TeacherGate>`：这里在 `<button>` 内部，
                   而 TeacherGate 渲染 `<section>`（块级元素塞进按钮是非法嵌套）。 -->
            <span
              v-if="item.parentId"
              class="sl__item-branch"
              :class="{ 'sl__item-branch--quiet': !viewMode.isTeacher }"
              data-testid="session-branch-mark"
              :title="`从「${item.parentTitle ?? '另一条对话'}」分出来的`"
            >
              <GitBranch :size="10" />
              <span v-if="viewMode.isTeacher">来自「{{ item.parentTitle ?? '另一条对话' }}」</span>
            </span>
            <span
              v-if="item.childCount > 0"
              class="sl__item-kids"
              :class="{ 'sl__item-kids--quiet': !viewMode.isTeacher }"
              data-testid="session-kids-mark"
              :title="`这条下面还有 ${item.childCount} 条对话，点左边的箭头展开`"
            >
              <CornerDownRight v-if="!viewMode.isTeacher" :size="11" />
              <template v-else>{{ item.childCount }} 条分支</template>
            </span>
            <span class="sl__item-meta">
              <template v-if="switchingId === item.id">正在打开…</template>
              <template v-else>
                {{ relativeTime(item.modifiedAt) }}
                <template v-if="(item.messageCount ?? 0) > 0"> · {{ item.messageCount }} 条</template>
              </template>
            </span>
          </span>
        </button>

        <!-- ★★ ⋯ 触发器：与右键弹**同一个**菜单。
             ★ 为什么还要它（需求只要求了右键）：右键是**约定**，不是可见线索 ——
               学生不会去猜「右键能删」。可发现性靠这个按钮兜住。
             ★★ 它必须是 `.sl__item`（本身是 `<button>`）的**兄弟节点**：
               按钮里套按钮是非法嵌套（浏览器会把它拆开，点击行为随实现而变）。
             ★ 默认不可见、悬停 / 键盘聚焦时显现（`opacity`，不是 `display`）：
               行宽只有 236px，常驻一个 28px 的按钮会挤掉标题。
               ⚠️ 但仍然要在 DOM 里、且尺寸 ≥28px：体检脚本按「渲染后的矩形」量
                 触控目标（`w > 0 && h > 0` 才算数），`display: none` 会让它量不到，
                  而 `opacity: 0` 保留矩形。 -->
        <button
          type="button"
          class="sl__more"
          :data-testid="`session-more-${item.id}`"
          title="更多操作（也可以直接在这条上点右键）"
          aria-haspopup="menu"
          :aria-expanded="menuFor?.id === item.id ? 'true' : 'false'"
          @click.stop="openMenu(item, $event, true)"
        >
          <Ellipsis :size="14" />
        </button>
      </li>
    </ul>
  </aside>

  <!-- 行菜单（Teleport 到 body：列表是 `overflow-y: auto` 的滚动容器，
       放在里面会被裁掉一半 —— 实测形态是「菜单只露出一行」）。
       ★ `role="menu"` + `role="menuitem"`：读屏会念成菜单，而不是一串按钮。 -->
  <Teleport to="body">
    <div
      v-if="menuFor"
      ref="menuRef"
      class="sl-menu"
      role="menu"
      data-testid="session-row-menu"
      :style="{ left: `${menuX}px`, top: `${menuY}px` }"
    >
      <button
        type="button"
        role="menuitem"
        class="sl-menu__item"
        data-testid="session-delete-action"
        @click="removeSession"
      >
        <Trash2 :size="14" />
        <span>删除这条对话</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.sl {
  width: 236px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 12px;
  border-right: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  overflow: hidden;
}

.sl__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.sl__title {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}

.sl__new {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
  flex: none;
}
@media (hover: hover) and (pointer: fine) {
  .sl__new:hover:not(:disabled) {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
.sl__new:disabled {
  opacity: 0.55;
  cursor: default;
}

.sl__notice {
  flex: none;
  padding: 7px 10px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
}

.sl__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* ★★ 必须显式重置 `<ul>` 的默认样式（本仓 base.css 只重置了标题与段落的 margin，
   *   没管列表）。浏览器给 `ul` 的默认 `padding-inline-start: 40px` 会让这个列表
   *   **比容器还宽**：窄窗口下 `.sl` 收成 60px 图标条，而列表仍是 65px，
   *   右侧那点内容被 `.sl` 的 `overflow: hidden` 吃掉 —— 实测 `ux:layout`
   *   在 1120px 的对话页报「内容够不着: sl(70>59)」，根因就是这 40px 幻影缩进。
   *   ⚠️ 这是**既有**缺陷，与本次改动无关（已用 HEAD 版本对照量过，数字完全一致）。 */
  margin: 0;
  padding: 0;
  list-style: none;
}

.sl__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  /* ★ 右侧 30px 是给绝对定位的 ⋯ 让位：不留的话那一行的时间戳会被按钮压住
   *   （按钮是 `opacity: 0` 时也占着那块位置，因为它在 DOM 里）。 */
  padding: 8px 30px 8px 9px;
  border: 1px solid transparent;
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-fg-2);
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .sl__item:hover:not(:disabled) {
    background: var(--k12-surface-2);
    color: var(--k12-fg);
  }
}
.sl__item:disabled {
  cursor: default;
}
/* 当前会话：浅底 + 左侧竖条（与左导航的选中态同一手法：
 * `inset` 竖条而不是 border-left —— 后者会把内容右推 1px，整列左缘跳动）。 */
.sl__item--active {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  box-shadow: inset 3px 0 0 var(--k12-accent-ink);
}

.sl__ico {
  flex: none;
  margin-top: 2px;
  color: var(--k12-muted);
}
.sl__item--active .sl__ico {
  color: var(--k12-accent-ink);
}

.sl__item-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

/* 标题单行省略：列表项高度必须齐平（两行的项会让整列看起来没对齐） */
.sl__item-title {
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  line-height: var(--k12-lh-ui);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 树形行 ─────────────────────────────────────────────────────────────
 * 一行 = [树形前导] [折叠箭头] [会话条目（可点）]。
 * ★ 前导与箭头都放在**按钮外面**：点箭头是「收起这一枝」，点条目才切会话 ——
 *   两者语义不同，混在一个按钮里会让「想展开却切了会话」变成常态（事故）。 */
.sl__row {
  display: flex;
  align-items: stretch;
  min-width: 0;
  /* ⋯ 触发器按绝对定位贴在行的右缘（见 `.sl__more`） */
  position: relative;
}

/* ⋯（更多操作）：默认透明，悬停 / 键盘聚焦 / 菜单打开时显现。
 * ★ 尺寸 28×28 是硬要求（UX 体检 C1：较小者 ≥20 且较大者 ≥28）；行高 44px，放得下。
 * ★ 用 `opacity` 而不是 `display: none`：矩形要一直在（体检脚本按渲染后的矩形量），
 *   而且 `opacity` 过渡不会在悬停时抖动。
 * ★ 行里那一条 `sl__item` 因此要留出右边距（见下面的 `padding-right`）。 */
.sl__more {
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.sl__row:hover .sl__more,
.sl__row:focus-within .sl__more,
.sl__more[aria-expanded='true'] {
  opacity: 1;
}
@media (hover: hover) and (pointer: fine) {
  .sl__more:hover {
    background: var(--k12-surface);
    border-color: var(--k12-border);
    color: var(--k12-fg-2);
  }
}
/* 键盘用户：看不见的按钮也能聚焦（`opacity: 0` 不阻止聚焦），所以要给焦点环 */
.sl__more:focus-visible {
  opacity: 1;
  outline: 2px solid var(--k12-accent-ink);
  outline-offset: 1px;
}

/* 行菜单（右键 / ⋯ 共用）。定位是 `fixed` + 视口坐标：它被 Teleport 到 body 上了，
 * 相对定位会落在「最后那个定位祖先」身上，而那个祖先随页面结构变。 */
.sl-menu {
  position: fixed;
  z-index: 80;
  min-width: 176px;
  padding: 5px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  box-shadow: var(--k12-shadow-card);
}
.sl-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  padding: 6px 10px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  /* ★ 删除用**警示色**而不是默认前景色：菜单里只有这一项，而它的后果不可撤销
   *   （与确认框的 `danger: true` 同一套语义，见 `stores/confirm.ts`）。 */
  color: var(--k12-warn);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .sl-menu__item:hover {
    background: var(--k12-warn-soft);
  }
}

/* 树形前导：宽度由 depth 决定（每层一段 12px）。
 * ★ 每段是**一个 span**（不是 CSS 背景图）：这样「哪一层还有兄弟」由
 *   `guides[i]` 逐个决定，画出来的线与真实结构一致 ——
 *   背景图做不到「按层判断」。 */
.sl__tree {
  display: flex;
  flex: none;
  align-items: stretch;
}
.sl__tree-seg {
  width: 12px;
  flex: none;
  position: relative;
}
/* 祖先竖线：只在「那条祖先后面还有兄弟」时画（否则线会连到空处） */
.sl__tree-seg--more::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  border-left: 1px solid color-mix(in srgb, var(--k12-border) 85%, transparent);
}
/* 本层的拐角：先竖到中间、再横到右边（`└` / `├` 两种） */
.sl__tree-elbow {
  width: 12px;
  flex: none;
  position: relative;
}
.sl__tree-elbow::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  /* 不是最后一个 → 竖线贯通（`├`）；是最后一个 → 只竖到中间（`└`） */
  bottom: 0;
  border-left: 1px solid color-mix(in srgb, var(--k12-border) 85%, transparent);
}
.sl__tree-elbow--last::before {
  bottom: 50%;
}
.sl__tree-elbow::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 50%;
  border-top: 1px solid color-mix(in srgb, var(--k12-border) 85%, transparent);
}

/* 折叠箭头：只给有子分支的行。
 * ★ 28px 见方：UX 体检 C1 的触控下限（它是**会常点**的控件）。 */
.sl__fold {
  flex: none;
  width: 28px;
  min-height: 28px;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
  padding: 0;
}
@media (hover: hover) and (pointer: fine) {
  .sl__fold:hover:not(.sl__fold--ghost) {
    background: var(--k12-surface-2);
    color: var(--k12-fg-2);
  }
}
/* 占位：没有箭头的行也占同样的宽度，保证整列文字左缘对齐
 * （不占位的话，有子分支的行会被箭头推右 28px，一列参差不齐） */
.sl__fold--ghost {
  cursor: default;
}

.sl__item {
  flex: 1;
  min-width: 0;
}

/* 「N 条分支」：**规模**信息（与「来自…」那个关系标记分工不同）。
 * 用 muted 色而不是 accent：它是计数，不是关系 —— 关系才值得强调。
 * ★ 学生视角下这一格只剩一个下折小图标（`--quiet`）：文字进 `title` 提示。
 *   图标仍占位（有宽高），所以体检脚本按 testid 数到的行数与几何不变。 */
.sl__item-kids {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.sl__item-kids--quiet {
  color: var(--k12-muted-2);
}

.sl__item-meta {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted-2);
}

/* 分支标记：它是「这条从哪来」的一行注解，比时间更值得看，所以放在时间**之前**
 * 并给它一档更实的颜色（时间只是排序信息，来源是关系）。
 * ★ 单行省略：标题已经单行了，这一行若换行会把整个列表项的节奏撑乱。
 * ★ 学生视角（`--quiet`）：文字换成一个小图标 + `title` 提示 —— 颜色收到最淡一档，
 *   因为「谁从谁分出来」学生靠**缩进与连接线**就看得出来，这行只是补充。 */
.sl__item-branch {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-accent-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl__item-branch--quiet {
  color: var(--k12-muted-2);
}

.sl__state {
  flex: none;
  padding: 6px 2px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted-2);
}
.sl__state--error {
  color: var(--k12-warn);
}

/* 窄窗口：这一列收成图标条（与左导航同一档断点 1280） */
@media (max-width: 1279px) {
  .sl {
    width: 60px;
    padding: 14px 8px;
    align-items: center;
  }
  /* ★★ `.sl` 有 `align-items: center`（图标条里每一项居中），但那条规则会**连带**
   *   把 `.sl__list` 也变成「按内容宽度收缩」—— 于是列表只剩 25px，
   *   里面的会话条目 15px 宽，低于 28px 触控下限（`ux:layout` 在 1120px 报
   *   「触控目标过小 ×6」）。这 6 个条目正是学生最常点的东西。
   *   所以这里把列表**显式拉满**：居中只该管那几行图标，不该管这个滚动容器。
   *   ⚠️ 同样是**既有**缺陷（HEAD 版本实测同一批 6 个条目过小）。 */
  .sl__list {
    align-self: stretch;
    width: 100%;
  }
  .sl__title,
  .sl__new-text,
  .sl__item-text {
    display: none;
  }
  .sl__head {
    justify-content: center;
  }
  .sl__new {
    /* ★ 窄栏里只剩图标：**必须显式给尺寸**，否则 `padding: 6px` + 14px 图标 = 26px 宽，
     *   低于 UX 体检 C1 的 28px 下限（那条规则量的是渲染后的矩形，源码里看不出来）。 */
    min-width: 28px;
    min-height: 28px;
    padding: 6px;
    justify-content: center;
  }
  .sl__item {
    justify-content: center;
    padding: 8px 0;
  }
  /* ⋯ 在窄栏（60px）里放不下第二个 28px 目标：整列只剩一个图标，
   * 两个圆点叠在一起反而更难点。窄栏里走**右键**（行菜单在哪里都能用）。 */
  .sl__more {
    display: none;
  }
  /* ★ 窄栏（60px）里缩进会吃掉本来就不够的文字空间 ——
   *   整列已经只剩一个图标，缩进看不出任何结构。
   *   ⚠️ 用 `display: none` 而不是 `width: 0`：后者会让连接线在半像素上残缺。 */
  .sl__tree,
  .sl__fold {
    display: none;
  }
  .sl__ico {
    margin-top: 0;
  }
}
</style>
