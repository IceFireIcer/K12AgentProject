<script setup lang="ts">
/**
 * 学习档案 · **学习报告**（学生 / 家长视图）。
 *
 * 四张表在这一页汇合：`mastery`（会什么）、`learning_history`（做了多少）、
 * `progress`（闯到哪关了）、`grade_history`（学段怎么变的）——
 * 而 `grade_history` 的表注释里本来就写着「家长报告」，这是补上那处设计意图。
 *
 * ★ **页面不自己算任何数**：连续天数、正确率、章节聚合全部来自
 *   `GET /api/profile/{id}/report`（`stores/study.ts` 只负责取回来）。
 * ★ **不在这里算「下一步」**：推荐有唯一出口（`/recommendation`），
 *   本页只给一句「回对话里问一句」的指引 —— 自己猜一个推荐会与对话里给出的不一致。
 * ★ 导出直接把屏幕上这份数据拼成 Markdown（纯函数 `study/report-markdown.ts`）。
 */
import { computed } from 'vue'
import { useStudyStore, REPORT_DAY_OPTIONS } from '../stores/study'
import { masteryLabel, formatMs, summaryLine } from '../study/report-markdown'
import { GRADE_LABELS } from '../labels'

defineOptions({ name: 'StudyReportTab' })

const study = useStudyStore()

const report = computed(() => study.report)
const gradeLabel = computed(() => {
  const level = report.value?.gradeLevel
  return level ? (GRADE_LABELS[level] ?? level) : '待判定'
})
const summary = computed(() =>
  report.value ? summaryLine(report.value, study.reportDays) : ''
)

/** 掌握度条形宽度（0..1 → 百分比；**只用于显示**，不参与任何判定）。 */
function barWidth(score: number): string {
  const clamped = Math.max(0, Math.min(1, score))
  return `${Math.round(clamped * 100)}%`
}
</script>

<template>
  <section class="tab-body" data-testid="study-report">
    <div class="toolbar">
      <div class="toolbar__group">
        <span class="toolbar__label">时间范围</span>
        <button
          v-for="days in REPORT_DAY_OPTIONS"
          :key="days"
          class="chip"
          type="button"
          :class="{ 'chip--on': days === study.reportDays }"
          :data-testid="`report-days-${days}`"
          @click="study.loadReport(days)"
        >
          近 {{ days }} 天
        </button>
      </div>
      <button
        class="btn"
        type="button"
        data-testid="report-export"
        :disabled="!report || study.exporting"
        @click="study.exportReport()"
      >
        {{ study.exporting ? '导出中…' : '导出 Markdown' }}
      </button>
    </div>

    <p v-if="study.exportNotice" class="notice" data-testid="report-export-notice">
      {{ study.exportNotice }}
    </p>

    <p v-if="study.loading.report" class="state" data-testid="report-loading">正在汇总学习记录…</p>
    <p v-else-if="study.errors.report" class="state state--error" data-testid="report-error">
      {{ study.errors.report }}
    </p>

    <template v-else-if="report">
      <div class="cards">
        <div class="card">
          <p class="card__label">学习活动</p>
          <p class="card__value" data-testid="report-total">{{ report.totalActivities }}</p>
          <p class="card__hint">近 {{ study.reportDays }} 天</p>
        </div>
        <div class="card">
          <p class="card__label">练习题</p>
          <p class="card__value" data-testid="report-quiz">
            {{ report.quizCorrect }}/{{ report.quizTotal }}
          </p>
          <p class="card__hint">
            {{
              report.quizTotal > 0
                ? `正确率 ${Math.round((report.quizCorrect / report.quizTotal) * 100)}%`
                : '还没有作答'
            }}
          </p>
        </div>
        <div class="card">
          <p class="card__label">连续学习</p>
          <p class="card__value" data-testid="report-streak">{{ report.streakDays }} 天</p>
          <p class="card__hint">{{ report.todayStudied ? '今天已学习' : '今天还没开始' }}</p>
        </div>
        <div class="card">
          <p class="card__label">当前学段</p>
          <p class="card__value" data-testid="report-grade">{{ gradeLabel }}</p>
          <p class="card__hint">由系统自动判定</p>
        </div>
      </div>

      <p class="summary" data-testid="report-summary">{{ summary }}</p>

      <!-- 每日活动 -->
      <h3 class="section">每日学习</h3>
      <p v-if="report.daily.length === 0" class="state">这段时间还没有学习记录。</p>
      <table v-else class="table" data-testid="report-daily">
        <thead>
          <tr><th>日期</th><th class="num">活动</th><th class="num">练习</th><th class="num">答对</th></tr>
        </thead>
        <tbody>
          <tr v-for="day in report.daily" :key="day.day">
            <td>{{ day.day }}</td>
            <td class="num">{{ day.count }}</td>
            <td class="num">{{ day.quizCount }}</td>
            <td class="num">{{ day.correctCount }}</td>
          </tr>
        </tbody>
      </table>

      <!-- 掌握度 -->
      <h3 class="section">知识点掌握</h3>
      <p v-if="report.mastery.length === 0" class="state">还没有掌握度记录。</p>
      <ul v-else class="list" data-testid="report-mastery">
        <li v-for="item in report.mastery" :key="item.kpId" class="row">
          <span class="row__name">{{ item.kpId }}</span>
          <span class="bar"><span class="bar__fill" :style="{ width: barWidth(item.score) }"></span></span>
          <span class="row__score">{{ item.score.toFixed(2) }}</span>
          <span class="row__tag">{{ masteryLabel(item.score) }}</span>
          <span class="row__meta">{{ item.correct }}/{{ item.attempts }} 次答对</span>
        </li>
      </ul>

      <!-- 章节进度 -->
      <h3 class="section">章节进度</h3>
      <p v-if="report.chapters.length === 0" class="state">还没有章节进度记录。</p>
      <ul v-else class="list" data-testid="report-chapters">
        <li v-for="chapter in report.chapters" :key="chapter.chapterTitle" class="row">
          <span class="row__name">{{ chapter.chapterTitle }}</span>
          <span class="bar">
            <span
              class="bar__fill"
              :style="{
                width: chapter.kpCount > 0
                  ? `${Math.round((chapter.masteredCount / chapter.kpCount) * 100)}%`
                  : '0%'
              }"
            ></span>
          </span>
          <span class="row__score">{{ chapter.masteredCount }}/{{ chapter.kpCount }}</span>
          <span class="row__meta">已测验 {{ chapter.quizzedCount }}</span>
        </li>
      </ul>

      <!-- 闯关 + 徽章 -->
      <h3 class="section">闯关与徽章</h3>
      <p v-if="Object.keys(report.stageCounts).length === 0" class="state">还没有开始闯关。</p>
      <ul v-else class="list" data-testid="report-stages">
        <li v-for="(count, stage) in report.stageCounts" :key="stage" class="row">
          <span class="row__name">{{ stage }}</span>
          <span class="row__score">{{ count }}</span>
          <span class="row__meta">个知识点</span>
        </li>
      </ul>
      <p v-if="report.badges.length > 0" class="badges" data-testid="report-badges">
        已获得徽章：{{ report.badges.join('、') }}
      </p>

      <!-- 学段轨迹 -->
      <h3 class="section">学段变化</h3>
      <p v-if="report.gradeHistory.length === 0" class="state">还没有学段变化记录。</p>
      <ul v-else class="list" data-testid="report-grade-history">
        <li v-for="(entry, index) in report.gradeHistory" :key="index" class="row">
          <span class="row__name">第 {{ entry.turn }} 轮</span>
          <span class="row__score">
            {{ entry.fromLevel ? (GRADE_LABELS[entry.fromLevel] ?? entry.fromLevel) : '（初始）' }}
            → {{ GRADE_LABELS[entry.toLevel] ?? entry.toLevel }}
          </span>
          <span class="row__meta">置信度 {{ entry.confidence.toFixed(2) }} · {{ formatMs(entry.ts) }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.tab-body {
  padding: 16px 24px 32px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.toolbar__group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.toolbar__label {
  font-size: 12px;
  color: var(--text-faint);
}

.chip {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-faint);
  font-size: 12px;
  cursor: pointer;
}

.chip--on {
  background: var(--accent-soft);
  border-color: rgba(47, 111, 208, 0.28);
  color: var(--accent-strong);
  font-weight: 600;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}

.card {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.card__label {
  font-size: 12px;
  color: var(--text-faint);
}

.card__value {
  margin-top: 4px;
  font-size: 22px;
  font-weight: 700;
}

.card__hint {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-faint);
}

.summary {
  margin-top: 12px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
}

.section {
  margin: 20px 0 8px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.row__name {
  min-width: 140px;
  flex-shrink: 0;
}

.row__score {
  min-width: 68px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.row__tag {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 11px;
}

.row__meta {
  color: var(--text-faint);
}

.bar {
  flex: 1;
  min-width: 60px;
  height: 6px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
}

.bar__fill {
  display: block;
  height: 100%;
  background: var(--accent);
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.table th,
.table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.badges {
  margin-top: 8px;
  font-size: 12px;
  color: var(--ok);
}

.state {
  padding: 10px 0;
  font-size: 12px;
  color: var(--text-faint);
}

.state--error {
  color: var(--warn);
  line-height: 1.7;
}

.notice {
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--ok);
}
</style>
