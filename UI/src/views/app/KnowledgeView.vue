<script setup lang="ts">
/**
 * 教材知识库（数据层检视视图，画布「8. 教材知识库」）。
 * 展示真实统计：33 个知识点 / 271 个 chunk / 47 条依赖边 / 四学段。
 */
import { ref, computed } from 'vue'
import { Database, Search, HardDrive, GitBranch, Layers, RefreshCw } from 'lucide-vue-next'
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

const keyword = ref('')
const gradeFilter = ref('全部')

const filtered = computed(() =>
  rows.filter((r) => {
    const hitGrade = gradeFilter.value === '全部' || r.grade === gradeFilter.value
    const hitKw =
      !keyword.value ||
      r.name.includes(keyword.value) ||
      r.kpId.includes(keyword.value) ||
      r.chapter.includes(keyword.value)
    return hitGrade && hitKw
  })
)
</script>

<template>
  <div class="kb">
    <!-- 统计条 -->
    <section class="kb__stats">
      <div class="kstat"><Database :size="14" /><span class="kstat__k">知识点</span><span class="kstat__v">{{ kbStats.knowledgePoints }}</span></div>
      <div class="kstat"><Layers :size="14" /><span class="kstat__k">教材分块</span><span class="kstat__v">{{ kbStats.chunks }}</span></div>
      <div class="kstat"><GitBranch :size="14" /><span class="kstat__k">依赖边</span><span class="kstat__v">{{ kbStats.dependencies }}</span></div>
      <div class="kstat"><HardDrive :size="14" /><span class="kstat__k">嵌入维度</span><span class="kstat__v">{{ kbStats.embeddingDim }}</span></div>
    </section>

    <section class="card">
      <header class="card__head">
        <div class="card__head-text">
          <h2 class="card__title">知识点与章节</h2>
          <p class="card__sub">
            教材来源：人工编写 Markdown + 元数据（不做 PDF 解析）· 嵌入 {{ kbStats.embeddingModel }}
          </p>
        </div>
        <button type="button" class="ghost"><RefreshCw :size="13" /><span>重建索引</span></button>
      </header>

      <div class="toolbar">
        <div class="search">
          <Search :size="14" />
          <input v-model="keyword" class="search__input" placeholder="搜索知识点、章节或 kp_id" />
        </div>
        <el-radio-group v-model="gradeFilter" size="small">
          <el-radio-button v-for="g in ['全部', '小学低', '小学高', '初中', '高中']" :key="g" :value="g">{{ g }}</el-radio-button>
        </el-radio-group>
      </div>

      <table class="tbl">
        <thead>
          <tr>
            <th class="tbl__th">kp_id</th>
            <th class="tbl__th">知识点</th>
            <th class="tbl__th">学段</th>
            <th class="tbl__th">章节</th>
            <th class="tbl__th">内容类型</th>
            <th class="tbl__th tbl__th--num">分块</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in filtered" :key="r.kpId" class="tbl__row">
            <td class="tbl__td"><code class="mono">{{ r.kpId }}</code></td>
            <td class="tbl__td tbl__td--strong">{{ r.name }}</td>
            <td class="tbl__td"><span class="tag">{{ r.grade }}</span></td>
            <td class="tbl__td tbl__td--muted">{{ r.chapter }}</td>
            <td class="tbl__td"><span class="type">{{ TYPE_LABEL[r.type] ?? r.type }}</span></td>
            <td class="tbl__td tbl__td--num">{{ r.chunks }}</td>
          </tr>
          <tr v-if="filtered.length === 0">
            <td class="tbl__td tbl__empty" colspan="6">没有匹配的知识点</td>
          </tr>
        </tbody>
      </table>

      <p class="card__note">
        表内为示例行（取自 kb.sqlite 真实值）；完整 33 条由后端提供。父子 chunk 策略：小子块检索、命中回父块作上下文。
      </p>
    </section>
  </div>
</template>

<style scoped>
.kb {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.kb__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.kstat {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 14px;
  border-radius: var(--k12-r-3xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
  color: var(--k12-accent);
}
.kstat__k {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.kstat__v {
  margin-left: auto;
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  color: var(--k12-fg);
}

.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border: 1px solid var(--k12-glass-border);
}
.card__head {
  display: flex;
  align-items: center;
  gap: 10px;
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
  font-weight: 650;
  color: var(--k12-fg);
}
.card__sub {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
.card__note {
  font-size: var(--k12-fs-micro);
  line-height: 1.7;
  color: var(--k12-muted);
}
.ghost {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-md);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
  flex: none;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.search {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  color: var(--k12-muted-2);
}
.search__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-family: inherit;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg);
}

.tbl {
  width: 100%;
  border-collapse: collapse;
}
.tbl__th {
  text-align: left;
  padding: 8px 10px;
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  color: var(--k12-muted);
  border-bottom: 1px solid var(--k12-border);
}
.tbl__th--num {
  text-align: right;
}
.tbl__row:hover {
  background: var(--k12-surface-2);
}
.tbl__td {
  padding: 9px 10px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
  border-bottom: 1px solid color-mix(in srgb, var(--k12-border) 50%, transparent);
}
.tbl__td--strong {
  font-weight: 620;
  color: var(--k12-fg);
}
.tbl__td--muted {
  color: var(--k12-muted);
}
.tbl__td--num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.tbl__empty {
  text-align: center;
  color: var(--k12-muted-2);
  padding: 20px;
}
.mono {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-micro);
  padding: 2px 6px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-surface-2);
  color: var(--k12-accent);
}
.tag {
  padding: 2px 7px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
}
.type {
  padding: 2px 7px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
}
</style>
