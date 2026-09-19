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
 * ⚠️ 窄窗口（<1280px）这一列会**收成一条窄栏**（只留「新会话」按钮 + 条目首字），
 *   与左导航栏同一档断点 —— 1440×900 是设计基准，1120 是最小宽度。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { GitBranch, MessageSquarePlus, Plus } from 'lucide-vue-next'
import { useChatStore } from '../stores/chat'
import { useStudyStore, type SessionSummaryShape } from '../stores/study'

const chat = useChatStore()
const study = useStudyStore()

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
 * 列表：**最近修改的排最前**（服务端已排好，这里不再排一次 ——
 * `projectSessionList` 的排序是「最后修改时间倒序 + id 兜底」，
 * 渲染进程再排一遍只会让两处的平局规则不一致）。
 */
const items = computed<SessionSummaryShape[]>(() => study.sessions)

/** 这一条是不是当前会话（主进程说了算）。 */
function isCurrent(session: SessionSummaryShape): boolean {
  return chat.currentSessionId !== '' && session.id === chat.currentSessionId
}

/**
 * 点一条会话：**已经是当前这条就什么都不做**。
 *
 * ★ 重复切换同一会话会 dispose + 重装一次（几秒的装配），而学生的意图
 *   「我要看这一段」在它已经在屏幕上时就已经满足了 —— 白等几秒是纯粹的损失。
 */
async function open(session: SessionSummaryShape): Promise<void> {
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
      还没有历史对话 —— 问第一个问题就会出现在这里。
    </p>

    <ul v-else class="sl__list">
      <li v-for="item in items" :key="item.id">
        <button
          type="button"
          class="sl__item"
          :class="{ 'sl__item--active': isCurrent(item) }"
          :data-testid="`session-item-${item.id}`"
          :aria-current="isCurrent(item) ? 'true' : undefined"
          :disabled="switchingId !== ''"
          :title="item.title"
          @click="open(item)"
        >
          <MessageSquarePlus :size="14" class="sl__ico" />
          <span class="sl__item-text">
            <span class="sl__item-title">{{ item.title }}</span>
            <!-- ★★ 分支标记：这条是从哪条会话分出来的。
                 ★ 只在**父会话确实还在列表里**时显示（`parentId` 非空 ——
                   主进程那边已经核过）：父被删掉之后仍显示「来自…」等于给一个
                   点不开的入口，那是谎话。 -->
            <span
              v-if="item.parentId"
              class="sl__item-branch"
              data-testid="session-branch-mark"
              :title="`从「${item.parentTitle ?? '另一条对话'}」分出来的`"
            >
              <GitBranch :size="10" />
              <span>来自「{{ item.parentTitle ?? '另一条对话' }}」</span>
            </span>
            <span class="sl__item-meta">
              <template v-if="switchingId === item.id">正在打开…</template>
              <template v-else>
                {{ relativeTime(item.modifiedAt) }}
                <template v-if="item.messageCount > 0"> · {{ item.messageCount }} 条</template>
              </template>
            </span>
          </span>
        </button>
      </li>
    </ul>

    <p class="sl__hint">
      点一条就能接着聊。对话存在你自己的目录里，不跨学生共用。
    </p>
  </aside>
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
}

.sl__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 8px 9px;
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

.sl__item-meta {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted-2);
}

/* 分支标记：它是「这条从哪来」的一行注解，比时间更值得看，所以放在时间**之前**
 * 并给它一档更实的颜色（时间只是排序信息，来源是关系）。
 * ★ 单行省略：标题已经单行了，这一行若换行会把整个列表项的节奏撑乱。 */
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

.sl__hint {
  flex: none;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted-2);
}

/* 窄窗口：这一列收成图标条（与左导航同一档断点 1280） */
@media (max-width: 1279px) {
  .sl {
    width: 60px;
    padding: 14px 8px;
    align-items: center;
  }
  .sl__title,
  .sl__new-text,
  .sl__item-text,
  .sl__hint {
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
  .sl__ico {
    margin-top: 0;
  }
}
</style>
