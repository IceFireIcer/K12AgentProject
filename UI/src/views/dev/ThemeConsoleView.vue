<script setup lang="ts">
/**
 * 主题切换台（开发页）—— 全应用**唯一**允许手动切学段的地方。
 *
 * ★ 用户的决定：「先默认色调配置，学段切换藏到开发页面，
 *    只有手动点击开发模式按钮才会进行能手动切换学段」。
 *
 * 因此门禁是两层的：
 *   1. 页面本身在 /dev/theme，不在学生端导航里；
 *   2. 必须先打开 devMode，否则 setGrade 会拒绝（见 stores/theme.ts 的守卫）。
 * 这样既满足开发期对比 18 组配色的需要，又不会把已作废的「学段选择」交互带回产品。
 *
 * ⚠️ 接线后本页应整体删除（或移到仅开发构建可用），学段改由服务端推断驱动。
 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Palette, Lock, Unlock, RotateCcw, FlaskConical, Eye, ShieldAlert } from 'lucide-vue-next'
import { GRADES, SATS, useThemeStore } from '@/stores/theme'

const theme = useThemeStore()

const status = computed(() => (theme.devMode ? '开发模式已开启' : '开发模式关闭 · 学段只读'))

function toggleDev() {
  theme.setDevMode(!theme.devMode)
  ElMessage({
    message: theme.devMode ? '开发模式已开启，可手动切换学段' : '开发模式已关闭，学段已复位为只读',
    type: theme.devMode ? 'success' : 'info'
  })
}

function pickGrade(key: string) {
  if (!theme.devMode) {
    ElMessage({ message: '请先开启开发模式（学段在正式产品里没有人工入口）', type: 'warning' })
    return
  }
  theme.setGrade(key as never)
}
</script>

<template>
  <div class="dev">
    <header class="dev__head">
      <div class="dev__title-block">
        <!-- 页面名在顶栏（取自路由 meta），这里只放这一页特有的说明 -->
        <p class="dev__sub">
          <FlaskConical :size="15" />
          开发期工具，非学生端页面。用于对比 grade × sat 的 18 组配色。
        </p>
      </div>
      <button type="button" class="dev__toggle" :class="{ 'dev__toggle--on': theme.devMode }" @click="toggleDev">
        <component :is="theme.devMode ? Unlock : Lock" :size="14" />
        <span>{{ theme.devMode ? '关闭开发模式' : '开启开发模式' }}</span>
      </button>
    </header>

    <!-- 门禁状态 -->
    <section class="banner" :class="{ 'banner--on': theme.devMode }">
      <component :is="theme.devMode ? Eye : ShieldAlert" :size="15" />
      <div>
        <p class="banner__title">{{ status }}</p>
        <p class="banner__desc">
          {{
            theme.devMode
              ? '学段可手动切换，仅用于开发期对比配色；关闭后会复位为默认色调。'
              : '学段为只读。正式产品中学段由服务端自动推断，无人工入口、无确认、无纠偏。'
          }}
        </p>
      </div>
    </section>

    <div class="dev__grid">
      <!-- 学段 -->
      <section class="card">
        <header class="card__head">
          <Palette :size="14" />
          <h3 class="card__title">学段色调</h3>
          <span class="card__meta">{{ theme.devMode ? '可切换' : '已锁定' }}</span>
        </header>
        <div class="grades" :class="{ 'grades--locked': !theme.devMode }">
          <button
            v-for="g in GRADES"
            :key="g.key"
            type="button"
            class="gbtn k12-swatch"
            :class="{ 'gbtn--on': theme.grade === g.key }"
            :data-grade="g.key"
            :data-sat="theme.sat"
            :disabled="!theme.devMode"
            @click="pickGrade(g.key)"
          >
            <span class="gbtn__bar">
              <span class="gbtn__seg" :style="{ background: 'var(--k12-accent)' }" />
              <span class="gbtn__seg" :style="{ background: 'var(--k12-accent-2)' }" />
              <span class="gbtn__seg" :style="{ background: 'var(--k12-accent-soft)' }" />
            </span>
            <span class="gbtn__label">{{ g.label }}</span>
            <span class="gbtn__key">{{ g.key }}</span>
          </button>
        </div>
        <p class="card__note">
          <code>default</code> 与 <code>brand</code> 是设计系统专用档，不对应真实学段。
        </p>
      </section>

      <!-- 饱和度 -->
      <section class="card">
        <header class="card__head">
          <Palette :size="14" />
          <h3 class="card__title">饱和度</h3>
          <span class="card__meta">始终可调</span>
        </header>
        <div class="sats">
          <button
            v-for="s in SATS"
            :key="s.key"
            type="button"
            class="sbtn"
            :class="{ 'sbtn--on': theme.sat === s.key }"
            @click="theme.setSat(s.key)"
          >
            <span class="sbtn__label">{{ s.label }}</span>
            <span class="sbtn__desc">{{ s.desc }}</span>
          </button>
        </div>
      </section>

      <!-- 当前值 -->
      <section class="card card--wide">
        <header class="card__head">
          <FlaskConical :size="14" />
          <h3 class="card__title">当前作用域</h3>
          <button type="button" class="reset" @click="theme.reset()"><RotateCcw :size="12" /><span>复位</span></button>
        </header>
        <div class="code">
          <p class="code__line">&lt;html <span class="code__a">data-grade</span>=<span class="code__s">"{{ theme.grade }}"</span> <span class="code__a">data-sat</span>=<span class="code__s">"{{ theme.sat }}"</span>&gt;</p>
        </div>
        <div class="livedemo">
          <span class="ld__sample ld__sample--btn">按钮</span>
          <span class="ld__sample ld__sample--chip">胶囊</span>
          <span class="ld__sample ld__sample--soft">浅底</span>
          <span class="ld__sample ld__sample--fg">正文</span>
          <span class="ld__sample ld__sample--muted">次要文字</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.dev {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dev__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dev__title-block {
  flex: 1;
  min-width: 0;
}
.dev__sub {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-fg-2);
}
.dev__toggle {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 14px;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  cursor: pointer;
  flex: none;
}
.dev__toggle--on {
  background: var(--k12-accent);
  border-color: var(--k12-accent-ink);
  color: var(--k12-surface);
}

.banner {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-radius: var(--k12-r-inset);

  display: flex;
  gap: 10px;
  padding: 12px 14px;
  color: var(--k12-muted);
}
.banner--on {
  background: var(--k12-good-soft);
  border-color: var(--k12-good-border);
  color: var(--k12-good);
}
.banner__title {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
}
.banner__desc {
  margin-top: 3px;
  font-size: var(--k12-fs-xs);
  line-height: 1.6;
}

.dev__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
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
.card--wide {
  grid-column: 1 / -1;
}
.card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--k12-muted);
}
.card__title {
  font-size: var(--k12-fs-md);
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
.reset {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  color: var(--k12-fg-2);
  /* 按钮文字是 meta（判据：11px 只给 ≤4 字的角标）→ 12px */
  font-size: var(--k12-fs-xs);
  font-weight: 600;
  cursor: pointer;
}

.grades {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.grades--locked {
  opacity: 0.6;
}
.gbtn {
  background: var(--k12-surface-2);
  border: 1px solid color-mix(in srgb, var(--k12-border) 70%, transparent);
  border-radius: var(--k12-r-inset);

  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  cursor: pointer;
  text-align: left;
}
.gbtn:disabled {
  cursor: not-allowed;
}
.gbtn--on {
  border-color: var(--k12-accent-ink);
  box-shadow: 0 0 0 2px var(--k12-accent-ring);
}
.gbtn__bar {
  display: flex;
  height: 14px;
  border-radius: var(--k12-r-flat);
  overflow: hidden;
}
.gbtn__seg {
  flex: 1;
}
.gbtn__label {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg);
}
.gbtn__key {
  /* 学段键名（primary-low / junior …）：名字里的 `key` 是角标词，且它是
   * 名称下方的**次级键名**（mono），留角标档 11px。 */
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}

.sats {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.sbtn {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 11px;
  cursor: pointer;
  text-align: left;
}
.sbtn--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent-border);
}
.sbtn__label {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg);
}
.sbtn__desc {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}

.code {
  padding: 11px 12px;
  border-radius: var(--k12-r-card);
  background: var(--k12-fg);
  overflow-x: auto;
}
.code__line {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-xs);
  color: var(--k12-screen-fg);
  white-space: nowrap;
}
.code__a {
  color: var(--k12-screen-key);
}
.code__s {
  color: var(--k12-screen-num);
}
.livedemo {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  align-items: center;
}
.ld__sample {
  padding: 8px 13px;
  border-radius: var(--k12-r-control);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
}
.ld__sample--btn {
  background: var(--k12-accent);
  color: var(--k12-surface);
}
.ld__sample--chip {
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}
.ld__sample--soft {
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
.ld__sample--fg {
  color: var(--k12-fg);
  padding-left: 0;
}
.ld__sample--muted {
  color: var(--k12-muted);
  padding-left: 0;
}
</style>
