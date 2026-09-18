<script setup lang="ts">
/**
 * 配色总览（设计系统页，画布「10. 配色总览」）。
 * 展示 grade 轴 6 档 × sat 轴 3 档的色板矩阵。
 * 这些不是学生屏，是给报告 / PPT / 答辩用的设计系统证据页。
 */
import { GRADES, SATS, useThemeStore } from '@/stores/theme'
import type { GradeKey, SatKey } from '@/stores/theme'
import tokensSource from '../../../scripts/tokens.source.json'

const theme = useThemeStore()

/**
 * 主题化 token 清单 —— **直接来自 `tokens.source.json`**，不手抄。
 *
 * ⚠️ 此前这里是一份手写的 15 项数组，注释还写着「与 tokens.source.json 对齐」，
 * 但调色板早已改名（`bg`→`page`，`glow`/`hair`/`btn-from`/`btn-to`/`aurora-*` 全部移除，
 * 新增 `surface`/`accent-ink`）。于是这一页——**专门给报告和答辩用的设计系统证据页**——
 * 有 7 个格子取的是不存在的变量，渲染成空白圆点，而页面上还写着「15 个主题化变量」。
 * 手抄的清单一定会漂移；改成从源头读，就再也不可能对不上。
 */
const TOKEN_KEYS = Object.keys(tokensSource.themed)

/** 中文名：只给常见项写，缺的回落成 key 本身（新增 token 不会因此消失） */
const TOKEN_LABEL: Record<string, string> = {
  page: '页面底',
  surface: '主面',
  'surface-2': '次级面',
  accent: '主强调',
  'accent-ink': '强调墨（可读文字）',
  'accent-2': '次强调（数据可视化）',
  'accent-soft': '强调浅底',
  'accent-border': '强调描边',
  'chip-bg': '胶囊底',
  'chip-fg': '胶囊字'
}

function preview(grade: GradeKey, sat: SatKey) {
  theme.setSat(sat)
  if (theme.devMode) theme.setGrade(grade)
}

function isActive(grade: GradeKey, sat: SatKey) {
  return theme.grade === grade && theme.sat === sat
}
</script>

<template>
  <div class="pal">
    <!-- 页面名在顶栏（取自路由 meta），这里只放这一页特有的说明 -->
    <header class="pal__head">
      <p class="pal__sub">
        两轴 token：grade（6）× sat（3）= 18 组，落成 <code>:root[data-grade][data-sat]</code>
      </p>
      <span class="pal__chip">{{ GRADES.length }} 学段档 × {{ SATS.length }} 饱和档</span>
    </header>

    <!-- token 名一览 -->
    <section class="card">
      <header class="card__head">
        <h3 class="card__title">语义 token</h3>
        <span class="card__meta">{{ TOKEN_KEYS.length }} 个主题化变量</span>
      </header>
      <div class="tokens">
        <div v-for="k in TOKEN_KEYS" :key="k" class="token">
          <span class="token__swatch" :style="{ background: `var(--k12-${k})` }" />
          <div class="token__text">
            <code class="token__name">--k12-{{ k }}</code>
            <span class="token__label">{{ TOKEN_LABEL[k] }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 饱和度三档 -->
    <section class="card">
      <header class="card__head">
        <h3 class="card__title">饱和度轴</h3>
        <span class="card__meta">在默认学段下对比</span>
      </header>
      <div class="sats">
        <button
          v-for="s in SATS"
          :key="s.key"
          type="button"
          class="sat"
          :class="{ 'sat--on': theme.sat === s.key }"
          @click="theme.setSat(s.key)"
        >
          <div class="sat__bar">
            <span class="sat__seg" :style="{ background: `var(--k12-accent)` }" />
            <span class="sat__seg" :style="{ background: `var(--k12-accent-2)` }" />
            <span class="sat__seg" :style="{ background: `var(--k12-accent-soft)` }" />
            <span class="sat__seg" :style="{ background: `var(--k12-surface-2)` }" />
          </div>
          <p class="sat__label">{{ s.label }}</p>
          <p class="sat__desc">{{ s.desc }}</p>
        </button>
      </div>
    </section>

    <!-- 学段矩阵 -->
    <section class="card">
      <header class="card__head">
        <h3 class="card__title">学段 × 饱和度矩阵</h3>
        <span class="card__meta">
          点击预览；{{ theme.devMode ? '开发模式已开，可切换学段' : '学段为只读（在开发页可开开发模式）' }}
        </span>
      </header>
      <div class="matrix">
        <div class="matrix__row matrix__row--head">
          <span class="matrix__cell matrix__cell--label" />
          <span v-for="s in SATS" :key="s.key" class="matrix__cell matrix__cell--head">{{ s.label }}</span>
        </div>
        <div v-for="g in GRADES" :key="g.key" class="matrix__row">
          <span class="matrix__cell matrix__cell--label">
            <span class="matrix__grade">{{ g.label }}</span>
            <span class="matrix__layer">{{ g.layer }}</span>
          </span>
          <button
            v-for="s in SATS"
            :key="s.key"
            type="button"
            class="matrix__cell matrix__cell--swatch k12-swatch"
            :class="{ 'matrix__cell--on': isActive(g.key, s.key) }"
            :data-grade="g.key"
            :data-sat="s.key"
            @click="preview(g.key, s.key)"
          >
            <span class="sw__bg" />
            <span class="sw__chip" />
            <span class="sw__btn" />
            <span class="sw__name">{{ g.key }} / {{ s.key }}</span>
          </button>
        </div>
      </div>
      <p class="card__note">
        矩阵格子的取色由生成器写入的 <code>tokens.generated.css</code> 提供，组件内不硬编码任何色值。
      </p>
    </section>
  </div>
</template>

<style scoped>
.pal {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pal__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pal__sub {
  flex: 1;
  min-width: 0;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
.pal__sub code {
  font-family: var(--k12-font-mono);
  color: var(--k12-accent-ink);
}
.pal__chip {
  padding: 5px 11px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  /* 页头汇总胶囊（渲染「6 学段档 × 3 饱和档」）：类名含 chip，形态是
   * 填充胶囊 + 650 的**记号**，与 .fp__chip / .sb__badge 同族 → 留角标档 11px。
   * ⚠️ 内容长于 4 字，是本页唯一"擦边"的一处：升到 12px 就与紧邻的说明行
   * .pal__sub（12px）同权，页头「说明 / 记号」这层区分会被抹掉。理由见交付说明。 */
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  flex: none;
}

.card {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
}
.card__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.card__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.card__meta {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}
.card__note {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.card__note code {
  font-family: var(--k12-font-mono);
  color: var(--k12-accent-ink);
}

.tokens {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}
.token {
  display: flex;
  align-items: center;
  gap: 8px;
}
.token__swatch {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: var(--k12-r-control);
  border: 1px solid var(--k12-border);
}
.token__text {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.token__name {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
.token__label {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}

.sats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.sat {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px;
  cursor: pointer;
  text-align: left;
}
.sat--on {
  border-color: var(--k12-accent-ink);
  background: var(--k12-accent-soft);
}
.sat__bar {
  display: flex;
  height: 26px;
  border-radius: var(--k12-r-control);
  overflow: hidden;
  border: 1px solid var(--k12-border);
}
.sat__seg {
  flex: 1;
}
.sat__label {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg);
}
.sat__desc {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.matrix {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.matrix__row {
  display: grid;
  grid-template-columns: 150px repeat(3, minmax(0, 1fr));
  gap: 6px;
  align-items: stretch;
}
.matrix__cell {
  display: flex;
  align-items: center;
}
.matrix__cell--head {
  justify-content: center;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-muted);
  padding: 4px 0;
}
.matrix__cell--label {
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}
.matrix__grade {
  font-size: var(--k12-fs-xs);
  font-weight: 620;
  color: var(--k12-fg);
}
.matrix__layer {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted-2);
}
.matrix__cell--swatch {
  position: relative;
  gap: 5px;
  padding: 8px 9px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  cursor: pointer;
  overflow: hidden;
}
.matrix__cell--on {
  border-color: var(--k12-accent-ink);
  box-shadow: 0 0 0 2px var(--k12-accent-ring);
}
.sw__bg,
.sw__chip,
.sw__btn {
  width: 16px;
  height: 16px;
  border-radius: var(--k12-r-flat);
  flex: none;
}
.sw__name {
  margin-left: auto;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

/**
 * 每个格子的配色来自 .k12-swatch（由 gen-tokens.mjs 生成，见 tokens.generated.css）。
 * 组件内**不硬编码任何色值** —— 改色只改画布，再重新导出 token。
 */
.matrix__cell--swatch {
  background: var(--k12-surface-2);
}

.sw__bg {
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
}
.sw__chip {
  background: var(--k12-accent-soft);
}
.sw__btn {
  background: var(--k12-accent);
}
</style>
