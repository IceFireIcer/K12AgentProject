<script setup lang="ts">
/**
 * 四学段对照（设计系统页，画布「11. 四学段对照」）。
 * 对照的是**语气与认知定位**（执行文档 §10.5），不只是难度数字 ——
 * 只改难度数字而忽略语气是常见错误。
 */
import { GRADES, useThemeStore } from '@/stores/theme'
import { kpNames } from '@/mocks'

const theme = useThemeStore()

/** 只保留四个真实学段（default / brand 是设计系统档，不对应真实学段） */
const realGrades = GRADES.filter((g) => g.key !== 'default' && g.key !== 'brand')

/** 真实 kp（取自 kb.sqlite），演示同主题在不同学段的取材差异 */
const columns = [
  {
    key: 'primary-low',
    sample: '用「小猫认图片」讲故事，不提「特征」这个词，只讲「它看到了什么」',
    example: '机器没有眼睛，但它可以「数一数」图片里亮的地方多不多。',
    terms: ['图片', '亮不亮'],
    forbid: ['特征', '向量', '权重']
  },
  {
    key: 'primary-high',
    sample: '引入「特征」但用生活例子，配合可动手的体验活动',
    example: '我们可以教机器认猫：先告诉它哪些线索有用，比如耳朵尖不尖。',
    terms: ['特征', '线索', '训练'],
    forbid: ['梯度', '损失函数']
  },
  {
    key: 'junior',
    sample: '引入原理与算法术语，强调「为什么」，给可验证的结论',
    example: '图像先被表示成像素数值，再提取特征，最后用分类器给出概率。',
    terms: ['像素', '特征向量', '分类器', '概率'],
    forbid: ['反向传播推导', '张量运算']
  },
  {
    key: 'senior',
    sample: '工程化表述：全流程、可评估、可复现，谈指标与取舍',
    example: '从数据划分、特征工程到模型评估，讨论过拟合与泛化误差的权衡。',
    terms: ['过拟合', '泛化误差', '训练/验证/测试集', '指标'],
    forbid: []
  }
]

function gradeLabelOf(key: string) {
  return realGrades.find((g) => g.key === key)?.label ?? key
}
</script>

<template>
  <div class="gm">
    <header class="gm__head">
      <div class="gm__title-block">
        <h2 class="gm__title">四学段对照</h2>
        <p class="gm__sub">
          语气与认知定位的差异，不只在难度数字上 —— 学段由系统自动推断，无人工入口
        </p>
      </div>
      <span class="gm__chip">4 学段 · 全自动</span>
    </header>

    <!-- 轴：认知定位 -->
    <section class="card">
      <header class="card__head">
        <h3 class="card__title">认知定位与语气</h3>
        <span class="card__meta">执行文档 §10.5</span>
      </header>
      <div class="axis">
        <button
          v-for="g in realGrades"
          :key="g.key"
          type="button"
          class="axis__item k12-swatch"
          :class="{ 'axis__item--on': theme.grade === g.key }"
          :data-grade="g.key"
          :data-sat="theme.sat"
          @click="theme.devMode && theme.setGrade(g.key)"
        >
          <span class="axis__swatch">
            <span class="axis__dot" :style="{ background: 'var(--k12-accent)' }" />
          </span>
          <span class="axis__label">{{ g.label }}</span>
          <span class="axis__layer">{{ g.layer }}</span>
          <span class="axis__tone">{{ g.tone }}</span>
        </button>
      </div>
      <p class="card__note">
        当前页面主题跟随系统学段；切换入口只在开发页（需先开开发模式）。
      </p>
    </section>

    <!-- 对照表 -->
    <section class="card">
      <header class="card__head">
        <h3 class="card__title">同一知识点的四种讲法</h3>
        <span class="card__meta">以「{{ kpNames['jr-data-features'] }}」为例</span>
      </header>
      <div class="cols">
        <article
          v-for="c in columns"
          :key="c.key"
          class="col k12-swatch"
          :data-grade="c.key"
          :data-sat="theme.sat"
        >
          <header class="col__head">
            <span class="col__dot" :style="{ background: 'var(--k12-accent)' }" />
            <span class="col__grade">{{ gradeLabelOf(c.key) }}</span>
            <span class="col__tone">{{ realGrades.find((g) => g.key === c.key)?.tone }}</span>
          </header>

          <p class="col__k">讲解策略</p>
          <p class="col__v">{{ c.sample }}</p>

          <p class="col__k">示例表达</p>
          <p class="col__quote">{{ c.example }}</p>

          <p class="col__k">可用术语</p>
          <div class="col__tags">
            <span v-for="t in c.terms" :key="t" class="tag tag--ok">{{ t }}</span>
          </div>

          <p class="col__k">禁用术语（超纲）</p>
          <div class="col__tags">
            <span v-if="c.forbid.length === 0" class="tag tag--none">无</span>
            <span v-for="t in c.forbid" :key="t" class="tag tag--no">{{ t }}</span>
          </div>
        </article>
      </div>
      <p class="card__note">
        System Prompt 按学段各一份模板，放在主进程的 prompts/ 下；术语白名单随学段放开。
      </p>
    </section>
  </div>
</template>

<style scoped>
.gm {
  padding: 16px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.gm__head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.gm__title-block {
  flex: 1;
  min-width: 0;
}
.gm__title {
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  color: var(--k12-fg);
}
.gm__sub {
  margin-top: 3px;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}
.gm__chip {
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

.axis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.axis__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-3xl);
  background: var(--k12-bg);
  cursor: pointer;
  text-align: left;
}
.axis__item--on {
  border-color: var(--k12-accent);
  box-shadow: 0 0 0 2px var(--k12-accent-ring);
}
.axis__swatch {
  display: inline-flex;
  padding: 3px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
}
.axis__dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
}
.axis__label {
  font-size: var(--k12-fs-md);
  font-weight: 650;
  color: var(--k12-fg);
}
.axis__layer {
  font-size: var(--k12-fs-micro);
  color: var(--k12-accent);
  font-weight: 600;
}
.axis__tone {
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted);
}

.cols {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-3xl);
  background: var(--k12-bg);
}
.col__head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--k12-border);
}
.col__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
}
.col__grade {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  color: var(--k12-fg);
}
.col__tone {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.col__k {
  margin-top: 4px;
  font-size: 8.5px;
  font-weight: 650;
  color: var(--k12-muted-2);
  letter-spacing: 0.04em;
}
.col__v {
  font-size: var(--k12-fs-micro);
  line-height: 1.7;
  color: var(--k12-fg-2);
}
.col__quote {
  padding: 8px 9px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-accent-soft);
  font-size: var(--k12-fs-micro);
  line-height: 1.7;
  color: var(--k12-chip-fg);
}
.col__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tag {
  padding: 2px 7px;
  border-radius: var(--k12-r-xs);
  font-size: 8.5px;
  font-weight: 600;
}
.tag--ok {
  background: var(--k12-good-soft);
  color: var(--k12-good);
}
.tag--no {
  background: color-mix(in srgb, var(--k12-bad) 10%, #fff);
  color: var(--k12-bad);
  text-decoration: line-through;
}
.tag--none {
  background: var(--k12-surface-2);
  color: var(--k12-muted-2);
}
</style>
