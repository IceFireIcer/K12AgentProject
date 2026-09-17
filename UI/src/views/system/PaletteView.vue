<script setup lang="ts">
/**
 * 配色总览（设计系统页，画布「10. 配色总览」）。
 * 展示 grade 轴 6 档 × sat 轴 3 档的色板矩阵。
 * 这些不是学生屏，是给报告 / PPT / 答辩用的设计系统证据页。
 */
import { GRADES, SATS, useThemeStore } from '@/stores/theme'
import type { GradeKey, SatKey } from '@/stores/theme'

const theme = useThemeStore()

/** 需要展示的 token 名（与 tokens.source.json 的主题化 token 对齐） */
const TOKEN_KEYS = [
  'bg', 'surface-2', 'accent', 'accent-2', 'accent-soft', 'accent-border',
  'glow', 'hair', 'btn-from', 'btn-to', 'chip-bg', 'chip-fg', 'aurora-a', 'aurora-b', 'aurora-c'
] as const

const TOKEN_LABEL: Record<string, string> = {
  bg: '页面底',
  'surface-2': '次级面',
  accent: '主强调',
  'accent-2': '次强调',
  'accent-soft': '强调浅底',
  'accent-border': '强调描边',
  glow: '辉光',
  hair: '细线',
  'btn-from': '按钮起',
  'btn-to': '按钮止',
  'chip-bg': '胶囊底',
  'chip-fg': '胶囊字',
  'aurora-a': '极光 A',
  'aurora-b': '极光 B',
  'aurora-c': '极光 C'
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
    <header class="pal__head">
      <div class="pal__title-block">
        <h2 class="pal__title">配色总览</h2>
        <p class="pal__sub">
          两轴 token：grade（6）× sat（3）= 18 组，落成 <code>:root[data-grade][data-sat]</code>
        </p>
      </div>
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
.pal__title-block {
  flex: 1;
  min-width: 0;
}
.pal__title {
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  color: var(--k12-fg);
}
.pal__sub {
  margin-top: 3px;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
.pal__sub code {
  font-family: var(--k12-font-mono);
  color: var(--k12-accent);
}
.pal__chip {
  padding: 5px 11px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
  font-size: var(--k12-fs-micro);
  font-weight: 650;
  flex: none;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
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
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.card__note {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
.card__note code {
  font-family: var(--k12-font-mono);
  color: var(--k12-accent);
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
  border-radius: var(--k12-r-sm);
  border: 1px solid var(--k12-border);
}
.token__text {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.token__name {
  font-family: var(--k12-font-mono);
  font-size: 8.5px;
  color: var(--k12-fg-2);
}
.token__label {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}

.sats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.sat {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-3xl);
  background: var(--k12-surface);
  cursor: pointer;
  text-align: left;
}
.sat--on {
  border-color: var(--k12-accent);
  background: var(--k12-accent-soft);
}
.sat__bar {
  display: flex;
  height: 26px;
  border-radius: var(--k12-r-md);
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
  font-size: var(--k12-fs-micro);
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
  font-size: var(--k12-fs-micro);
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
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.matrix__cell--swatch {
  position: relative;
  gap: 5px;
  padding: 8px 9px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-xl);
  cursor: pointer;
  overflow: hidden;
}
.matrix__cell--on {
  border-color: var(--k12-accent);
  box-shadow: 0 0 0 2px var(--k12-accent-ring);
}
.sw__bg,
.sw__chip,
.sw__btn {
  width: 16px;
  height: 16px;
  border-radius: var(--k12-r-xs);
  flex: none;
}
.sw__name {
  margin-left: auto;
  font-family: var(--k12-font-mono);
  font-size: 8px;
  color: var(--k12-muted-2);
}

/**
 * 每个格子的配色来自 .k12-swatch（由 gen-tokens.mjs 生成，见 tokens.generated.css）。
 * 组件内**不硬编码任何色值** —— 改色只改画布，再重新导出 token。
 */
.matrix__cell--swatch {
  background: var(--k12-bg);
}

.sw__bg {
  background: var(--k12-bg);
  border: 1px solid var(--k12-border);
}
.sw__chip {
  background: var(--k12-accent-soft);
}
.sw__btn {
  background: var(--k12-accent);
}
</style>
