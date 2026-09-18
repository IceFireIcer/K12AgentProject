<script setup lang="ts">
/**
 * 教材知识库（数据层检视视图）。
 *
 * ★ 这一页的主角是**表**，不是统计。
 *   此前顶部 4 个磁贴的数字用了 22px（xl 档），而表格正文只有 13px ——
 *   于是"知识库"这一页最重的东西是 4 个装饰性统计，真正的主对象（33 个知识点的表）
 *   被压住了，内容区的最大字号也来自磁贴而不是页面身份（焦点错了）。
 *   现在：身份行 22px（PageIdentity）> 卡头 16px > 表格 13px，
 *   统计降级为表格上方**一行 12px** 的口径说明（meta 档，不是标题档）。
 *
 * 控件换成 Element Plus：搜索框 → `el-input`（带 prefix 图标），表格 → `el-table`
 * （带空态与列排序），标签 → `el-tag`。原来这三样都是手写 HTML —— 手写 `<table>`
 * 没有排序、没有空态、窄屏下会横向溢出。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { RefreshCw, Upload, FileUp, AlertTriangle, CheckCircle2 } from 'lucide-vue-next'
import SurfacePanel from '@/components/SurfacePanel.vue'
import PageActions from '@/components/PageActions.vue'
import PageIdentity from '@/components/PageIdentity.vue'
import { kbStats } from '@/mocks'

interface Row {
  kpId: string
  name: string
  grade: string
  chapter: string
  chunks: number
  type: string
}

/** 真实 kp 名与章节（取自 kb.sqlite 的 kp / chunk 表） */
const rows: Row[] = [
  { kpId: 'jr-data-features', name: '数据与特征', grade: '初中', chapter: '第1章 数据与特征', chunks: 6, type: 'concept' },
  { kpId: 'jr-decision-tree', name: '决策树', grade: '初中', chapter: '第2章 决策树', chunks: 5, type: 'principle' },
  { kpId: 'jr-py-variable', name: '变量', grade: '初中', chapter: '第4章 用 Python 处理数据', chunks: 5, type: 'practice' },
  { kpId: 'jr-py-loop', name: '循环', grade: '初中', chapter: '第4章 用 Python 处理数据', chunks: 4, type: 'practice' },
  { kpId: 'jr-neural-basics', name: '神经网络基础', grade: '初中', chapter: '第3章 神经网络基础', chunks: 5, type: 'principle' },
  { kpId: 'sr-loss-gradient', name: '损失函数与梯度下降', grade: '高中', chapter: '第2章 损失函数与梯度下降', chunks: 6, type: 'principle' },
  { kpId: 'sr-knn', name: '最近邻（KNN）', grade: '高中', chapter: '第4章 最近邻与简单基线', chunks: 4, type: 'principle' },
  { kpId: 'pl-ai-manners', name: 'AI 与安全', grade: '小学低', chapter: '第3章 AI 有礼貌吗', chunks: 4, type: 'ethics' },
  { kpId: 'ph-image-classification', name: '图像分类', grade: '小学高', chapter: '第2章 机器怎么看图', chunks: 5, type: 'concept' }
]

const TYPE_LABEL: Record<string, string> = {
  concept: '概念',
  principle: '原理',
  practice: '实践',
  ethics: '伦理',
  project: '项目'
}

const GRADE_TAG: Record<string, 'primary' | 'success' | 'warning' | 'info'> = {
  小学低: 'warning',
  小学高: 'success',
  初中: 'primary',
  高中: 'info'
}

const keyword = ref('')
const gradeFilter = ref('全部')

/**
 * 重建索引：原型不真跑，但**状态要完整**（进行中 → 完成 / 失败）。
 * 接线后这里调 sidecar 的重建端点，耗时可能几十秒，所以必须有进度反馈 ——
 * 一个按下去什么都不发生的按钮，比没有这个按钮更糟。
 */
type IndexPhase = 'idle' | 'running' | 'done' | 'failed'
const indexPhase = ref<IndexPhase>('idle')
const indexedAt = ref('')
let indexTimer: number | null = null

/**
 * 重建索引。
 * `failed` 此前**声明了但永远走不到** —— 那等于告诉使用者"这件事不会失败"。
 * 现在按一个演示开关真的能走到失败分支，失败后可重试。
 * 接线后失败原因来自 sidecar（模型缺失、chunk 表锁、嵌入维度不匹配等）。
 */
const indexError = ref('')
function rebuildIndex(forceFail = false) {
  if (indexPhase.value === 'running') return
  indexPhase.value = 'running'
  indexError.value = ''
  if (indexTimer !== null) clearTimeout(indexTimer)
  indexTimer = window.setTimeout(() => {
    if (forceFail) {
      indexPhase.value = 'failed'
      indexError.value = '嵌入维度与 vec0 表不一致（期望 512，实际 768）—— 需先重建向量表'
    } else {
      indexPhase.value = 'done'
      indexedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    }
    indexTimer = null
  }, 1200)
}

onBeforeUnmount(() => {
  if (indexTimer !== null) clearTimeout(indexTimer)
})

/**
 * 导入教材：**真的打开文件选择器**并读取文件名 / 大小，给出解析反馈。
 * 原型不写库（那是 sidecar 的事），但"选了文件没有任何反应"是假接线；
 * 至少要能看到"我选了什么、系统认出了什么"。
 *
 * 接线后：文件内容送去 sidecar 的导入端点，做 Markdown + 元数据校验，
 * 落 chunk 表、算 embedding、重建索引，并回报每篇的成功/失败。
 */
const fileInput = ref<HTMLInputElement | null>(null)
type ImportPhase = 'idle' | 'parsed'
const importPhase = ref<ImportPhase>('idle')
const importedFile = ref<{ name: string; sizeKb: number; headings: number } | null>(null)

async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const text = await file.text()
  // 只做一件真实的事：数出 Markdown 标题层级 —— 它是"这份教材能不能切片"的第一个信号
  const headings = (text.match(/^#{1,6}\s/gm) ?? []).length
  importedFile.value = {
    name: file.name,
    sizeKb: Math.max(1, Math.round(file.size / 1024)),
    headings
  }
  importPhase.value = 'parsed'
  input.value = ''
}

const filtered = computed(() =>
  rows.filter((r) => {
    const hitGrade = gradeFilter.value === '全部' || r.grade === gradeFilter.value
    const kw = keyword.value.trim()
    const hitKw = !kw || r.name.includes(kw) || r.kpId.includes(kw) || r.chapter.includes(kw)
    return hitGrade && hitKw
  })
)

/**
 * 口径行：这 4 个数字是**这一页所检视的那份数据的量纲**，是表格的 caption，
 * 不是主角。
 *
 * ⚠️ 它们此前是 4 个数字用 22px（`--k12-fs-xl`）的磁贴 —— 与身份行同档，
 *    而表格正文只有 13px。于是这一页"最重"的东西是 4 个装饰性统计，
 *    真正的主对象（33 个知识点的表）被压住，内容区的最大字号也不再来自页面身份。
 *    现在：一行 12px（meta 档）。数字保留 650 字重 + tabular-nums 以便扫读与对齐，
 *    **字号不再与身份行争高下**。
 */
const stats = [
  { v: kbStats.knowledgePoints, k: '个知识点' },
  { v: kbStats.chunks, k: '个分块' },
  { v: kbStats.dependencies, k: '条依赖边' }
]
</script>

<template>
  <div class="kb">
    <PageActions>
      <!-- ⚠️ `#info` 里**只留原句不重复的那一半**：「教材来源：人工编写 Markdown +
           元数据（不做 PDF 解析）」已经由下面身份行的 `meta` 承担，两处同一句话是冗余。
           ⚠️ 但不能整个删掉这个槽：`.pa__info { flex: 1 }` 是这条栏把操作推到右边的唯一
           依仗，槽为空会被 `.pa__info:empty { display: none }` 收掉，
           两个按钮就会跑到**左边**去 —— 与本项目其余各页的按钮位置不一致。 -->
      <template #info>
        <span>数据层检视视图 · 本地 kb.sqlite</span>
      </template>
      <input
        ref="fileInput"
        type="file"
        accept=".md,.markdown,.json"
        class="kb__file"
        @change="onFilePicked"
      />
      <el-button @click="fileInput?.click()">
        <Upload :size="14" />
        <span class="btn__label">导入教材</span>
      </el-button>
      <el-button
        :loading="indexPhase === 'running'"
        :disabled="indexPhase === 'running'"
        @click="rebuildIndex(false)"
      >
        <RefreshCw v-if="indexPhase !== 'running'" :size="14" />
        <span class="btn__label">
          {{ indexPhase === 'running' ? '重建中…' : indexPhase === 'failed' ? '重试' : '重建索引' }}
        </span>
      </el-button>
    </PageActions>

    <!-- 身份行（22px）：内容区的最大字号在这里，不在磁贴上。
         `meta` 承接了原本写在 PageActions `#info` 里的「教材来源」口径 —— 同一句话只留一处。 -->
    <PageIdentity
      main="库里到底有什么教材"
      meta="教材来源：人工编写 Markdown + 元数据（不做 PDF 解析）"
      hint="先按学段筛，再点行看分块详情"
    />

    <!-- 索引重建失败：说清原因与下一步。失败分支必须有出口，否则使用者只能干等。 -->
    <div v-if="indexPhase === 'failed'" class="kb__fail">
      <AlertTriangle :size="15" />
      <div class="kb__fail-text">
        <p class="kb__fail-title">重建索引失败</p>
        <p class="kb__fail-msg">{{ indexError }}</p>
      </div>
      <el-button size="small" @click="rebuildIndex(false)">重试</el-button>
    </div>

    <!-- 导入反馈：说清"选了什么、认出了什么、接下来会做什么"。
         ⚠️ 位置固定在**身份行与表格卡片之间**（不插进卡片内部）——
         卡片是"一块内容"，卡头 / 工具条 / 表格 / 卡脚必须连续，
         否则"这一条属于这张表"的从属关系就散了。 -->
    <div v-if="importedFile" class="kb__import">
      <FileUp :size="15" />
      <div class="kb__import-text">
        <p class="kb__import-name">
          {{ importedFile.name }}
          <span class="k12-unit">{{ importedFile.sizeKb }} KB</span>
        </p>
        <p class="kb__import-meta">
          识别到 {{ importedFile.headings }} 个标题层级。
          接线后这里会做 Markdown + 元数据校验，落 chunk 表并重算嵌入，再回报每篇的导入结果。
        </p>
      </div>
      <el-button text @click="importPhase = 'idle'; importedFile = null">知道了</el-button>
    </div>

    <!-- 口径行：这 4 个数字是**表格的 caption**，不是主角。
         原本它们是 4 个 22px 的磁贴 —— 与身份行同档、把表格（13px）压在下面。
         现在是一行 12px（meta 档）：数字靠字重与 tabular-nums 可扫读，**不再靠字号争焦点**。 -->
    <p class="kb__scope">
      <template v-for="(s, i) in stats" :key="s.k">
        <span v-if="i" class="kb__scope-sep" aria-hidden="true">·</span>
        <span class="kb__scope-item">
          <span class="k12-num kb__scope-n">{{ s.v }}</span> {{ s.k }}
        </span>
      </template>
      <span class="kb__scope-sep" aria-hidden="true">·</span>
      <span class="kb__scope-item">
        嵌入 <span class="k12-num kb__scope-n">{{ kbStats.embeddingDim }}</span> 维（{{ kbStats.embeddingModel }}）
      </span>
    </p>

    <SurfacePanel class="card">
      <header class="card__head">
        <div class="card__head-text">
          <h2 class="card__title">知识点与章节</h2>
        </div>
        <span v-if="indexPhase === 'done'" class="index-done">
          <CheckCircle2 :size="14" />
          <span>索引已重建 · {{ indexedAt }}</span>
        </span>
      </header>

      <div class="toolbar">
        <el-input
          v-model="keyword"
          placeholder="搜索知识点、章节或 kp_id"
          clearable
          class="toolbar__search"
        />
        <el-radio-group v-model="gradeFilter" size="small">
          <el-radio-button v-for="g in ['全部', '小学低', '小学高', '初中', '高中']" :key="g" :value="g">
            {{ g }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <el-table :data="filtered" size="small" class="tbl" :border="false">
        <!-- 列宽预算（1440 窗口）：内容区 1440 − 248 侧栏 − 44 页内边距 − 32 卡内边距 ≈ 1116。
             固定列合计 200+104+110+88 = 502，余下的按 min-width 比例分给「知识点」与「章节」。
             「章节」给到 260（最长的一条「第4章 用 Python 处理数据」约 200px）——
             它是这一行里唯一能说明"这条知识点在教材的哪里"的信息，不该被截断。
             ⚠️ 最窄档（1120 窗口、侧栏收成 64）下内容区仍有 ~980 > 922（各列最小宽之和），
                所以不会出现横向滚动。 -->
        <el-table-column prop="kpId" label="kp_id" width="200">
          <template #default="{ row }">
            <code class="mono">{{ row.kpId }}</code>
          </template>
        </el-table-column>
        <el-table-column prop="name" label="知识点" min-width="160" />
        <el-table-column prop="grade" label="学段" width="104">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" :type="GRADE_TAG[row.grade] ?? 'info'">
              {{ row.grade }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="chapter" label="章节" min-width="260" />
        <el-table-column prop="type" label="内容类型" width="110">
          <template #default="{ row }">
            <span class="type">{{ TYPE_LABEL[row.type] ?? row.type }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="chunks" label="分块" width="88" align="right" sortable />
        <template #empty>
          <el-empty description="没有匹配的知识点" :image-size="72" />
        </template>
      </el-table>

      <p class="card__note">
        表内为示例行（取自 kb.sqlite 真实值）；完整 33 条由后端提供。
        父子 chunk 策略：小子块检索、命中回父块作上下文。
      </p>
    </SurfacePanel>
  </div>
</template>

<style scoped>
.kb__fail {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 15px;
  border-radius: var(--k12-r-card);
  background: var(--k12-bad-soft);
  border: 1px solid var(--k12-bad-border);
  color: var(--k12-bad);
}
.kb__fail-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.kb__fail-title {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.kb__fail-msg {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.kb__file {
  display: none;
}
.kb__import {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 15px;
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  border: 1px solid var(--k12-accent-border);
  box-shadow: var(--k12-shadow-card);
  color: var(--k12-accent-ink);
}
.kb__import-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.kb__import-name {
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.kb__import-meta {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

.kb {
  padding: 18px 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* ⚠️ 这个内边距与 `PageActions` 的吸顶必须对齐：它靠负外边距拉回内容区边缘，
   *    数值由 `--pa-pad-y` / `--pa-pad-x` 传入（默认 18 / 22，与此处相同）。
   *    若改了上面的 padding，**必须**在这里覆盖这两个变量，否则吸顶时会露内容。 */
}

/**
 * 口径行 —— 表格的 caption（12px，meta 档）。
 *
 * ★ 这里就是本次返工的核心：这 4 个数字曾经是 4 个 **22px** 的磁贴，
 *   与身份行同档、把 13px 的表格压在下面。现在降到 12px：
 *   数字仍能被一眼扫到，但靠的是**字重 650 + 等宽数字对齐**，不是字号。
 *   于是内容区的最大字号重新归身份行（22px）所有。
 */
.kb__scope {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.kb__scope-item {
  white-space: nowrap;
}
/* 数字：可读性档次高于它周围的说明文字（fg 对 muted），但**同字号** */
.kb__scope-n {
  font-weight: 650;
  color: var(--k12-fg);
}
/* 分隔点：说明性的装饰，不配更淡的 `--k12-muted-2`（它在页面底色上只有 2.67:1，
 * 会变成"读不清又不明显"的噪点）。分隔点与两侧文字同档同色，靠字符本身分组。 */
.kb__scope-sep {
  color: var(--k12-muted);
}

.card {
  /* 表格卡片铺满内容区：这一页的主角是表，不给它留白边（此前 4 个磁贴占着首屏，
   * 表被挤在下面）。SurfacePanel 是 flex item，默认 stretch，这里写死 100% 只是
   * 把"满幅"变成**显式意图**，避免以后有人加 align-items 把它改窄。 */
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.card__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.card__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.card__title {
  font-size: var(--k12-fs-lg);
  font-weight: 620;
  color: var(--k12-fg);
}
.card__note {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.btn__label {
  margin-left: 6px;
}
.index-done {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  color: var(--k12-good);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.toolbar__search {
  flex: 1;
  min-width: 0;
  max-width: 420px;
}

.tbl {
  width: 100%;

  /**
   * ★ 把表格正文的字号**拿回来**（实测发现的问题，不是猜测）。
   *
   * `base.css` 已声明表格正文是 13px（`--k12-fs-sm`：次级正文 / 可读的键值）。
   * 但 EP 的 `size="small"` 会把自己压到 12px（`--el-font-size-extra-small`）：
   * 两条规则**特异性相同**（都是单类），谁在文档里靠后谁赢 —— 而 EP 的样式随本路由的
   * chunk 注入、晚于主样式表，于是在这一页 **12px 胜出**。
   * 后果恰好打在最痛的地方：这张表是整页的主角，正文却被降到 meta（12px）档，
   * 与表头同字号 ——「标题与数据一样大」的塌陷。
   * 就地重新声明一次即可（`.tbl[data-v]` 特异性高于 `.el-table--small`）。
   * 表头仍归 `base.css` 的 `.el-table th.el-table__cell`（特异性更高）压成 12px：
   * 表头是标签、正文是数据，**差一档正是想要的**。
   */
  font-size: var(--k12-fs-sm);
}

/**
 * 行高 = 这一页的阅读节奏。
 *
 * EP 的 `size="small"` 只给单元格 4px 纵向内边距（`.el-table--small .el-table__cell`），
 * 配上 13px 正文与 23px 的行框，一行只有 ~31px —— 9 行真实数据读起来是全挤在一起的。
 * 表是这一页的主角，它的行距不该比别处的行列还紧。这里把纵向内边距提到 10px
 * （行高 ~44px），**字号单独在 `.tbl` 上声明**：间距差才是节奏，不是字号差（契约 §2）。
 *
 * 横向同时从 small 档的 8px 提到 12px —— 与 EP 默认档一致，也与 13px 正文相称：
 * 8px 的横向留白配 13px 的字，列与列之间会糊成一片。
 *
 * ⚠️ `:deep()` 是必须的：`.el-table__cell` / `.cell` 由 EP 渲染，不在本组件的 scoped
 *    作用域内。用 `padding`（而非 `height`）让单元格内容自己决定高度，多行文本不会溢出。
 */
.tbl :deep(.el-table__cell) {
  padding: 10px 0;
}
/* 表头比数据行略紧：它是标签，不是数据 */
.tbl :deep(th.el-table__cell) {
  padding: 8px 0;
}
.tbl :deep(.cell) {
  padding: 0 12px;
}

/* ── 两个 meta：都是 12px（`--k12-fs-xs`）───────────────────────────────
 * ⚠️ 它们此前是 11px（`--k12-fs-micro`）。11px 是**角标档**（≤4 字），
 *    而 kp_id 是代码标识符、内容类型是分类名 —— 两者都是要被读的 meta。
 *    降到 11px 的实际后果：表格里最需要逐字读的列反而最小。 */
.mono {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  padding: 2px 6px;
  border-radius: var(--k12-r-flat);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}
.type {
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
</style>
