<script setup lang="ts">
/**
 * 模型 / 供应商选择器（全局模态）。
 *
 * 这个界面此前**根本不存在** —— 模型只能靠学生自己去设置页手打一串 model id，
 * 而输入条上的模型 chip 是个不可点的 `<span>`。学生看到"deepseek-v4-flash"
 * 却没有任何办法换掉它。
 *
 * 三件事在这里同时成立：
 *   ① **选**：从候选清单里挑，选中即生效（输入条、顶栏、设置页同步）；
 *   ② **探测**：选完能当场验证可用性，给延迟与结论，而不是"选完祈祷"；
 *   ③ **兜底**：想用目录里没有的，直接去设置页自填 —— 赛题要求"不写死供应商"。
 *
 * 接线后的形状：候选清单来自 Pi 的 provider 目录（`provider-catalog.ts`），
 * 选择结果写回 `config.json` 并重写 `models.json`。
 */
import { onBeforeUnmount, computed, ref } from 'vue'
import { useEscape } from '@/composables/useEscape'
import { useFocusReturn } from '@/composables/useFocusReturn'
import { useRouter } from 'vue-router'
import { Check, Zap, Image as ImageIcon, Settings2, X, LoaderCircle, CircleCheck, CircleAlert } from 'lucide-vue-next'
import { useModel } from '@/stores/model'

const model = useModel()
const router = useRouter()

/**
 * 面板根元素。它是**模态**（全屏遮罩 + `aria-modal="true"`），所以焦点必须收束：
 * 打开移入、Tab 在层内循环、关闭还回触发它的模型 chip。
 * 开关状态在 store 里（本文件无权改 store）—— getter 直接读 store 的响应式值即可。
 */
const panelRef = ref<HTMLElement | null>(null)

const busy = computed(() => model.probePhase === 'probing')

function isActive(providerId: string, modelId: string) {
  return model.current.providerId === providerId && model.current.modelId === modelId
}

function choose(opt: (typeof model.catalog)[number]) {
  void model.select(opt)
}

function goSettings() {
  model.closePicker()
  void router.push({ name: 'settings' })
}

onBeforeUnmount(() => model.dispose())

/** Esc 关闭：模态必须有键盘出口，否则键盘用户被卡在里面。 */
useEscape(() => model.closePicker(), () => model.pickerOpen)

/**
 * 焦点收束（契约第 8 节）：打开时把焦点移进面板、Tab 在层内循环、关闭还回触发元素。
 * 初焦点显式给「关闭」键而不是列表首项 —— 列表项点一下就**选中并关闭**，
 * 默认聚焦第一项会让「打开后手一抖按了回车」变成误选模型。
 */
useFocusReturn(panelRef, () => model.pickerOpen, {
  initial: () => panelRef.value?.querySelector<HTMLElement>('.mp__close') ?? null
})
</script>

<template>
  <Teleport to="body">
    <Transition name="mp-fade">
      <div
        v-if="model.pickerOpen"
        ref="panelRef"
        class="mp"
        role="dialog"
        aria-modal="true"
        @click.self="model.closePicker()"
      >
        <div class="mp__box k12-float">
          <header class="mp__head">
            <div class="mp__head-text">
              <p class="mp__title">选择模型</p>
              <p class="mp__sub">当前：{{ model.current.providerName }} · {{ model.current.modelId }}</p>
            </div>
            <button type="button" class="mp__close" title="关闭" @click="model.closePicker()">
              <X :size="16" />
            </button>
          </header>

          <div class="mp__list">
            <button
              v-for="opt in model.catalog"
              :key="`${opt.providerId}/${opt.modelId}`"
              type="button"
              class="mp__item"
              :class="{ 'mp__item--on': isActive(opt.providerId, opt.modelId) }"
              @click="choose(opt)"
            >
              <span class="mp__check">
                <Check v-if="isActive(opt.providerId, opt.modelId)" :size="14" />
              </span>
              <span class="mp__item-text">
                <span class="mp__item-name">
                  {{ opt.modelId }}
                  <ImageIcon v-if="opt.vision" :size="12" class="mp__vision" title="支持图片输入" />
                </span>
                <span class="mp__item-meta">{{ opt.providerName }} · {{ opt.baseUrl }}</span>
              </span>
              <span class="mp__tags">
                <span v-for="t in opt.tags" :key="t" class="mp__tag">{{ t }}</span>
              </span>
            </button>
          </div>

          <!-- 探测：选完当场验证。结果文案明确写"未发真实请求"，
               不让界面冒充一件它没做的事。 -->
          <div class="mp__probe">
            <button type="button" class="mp__probe-btn" :disabled="busy" @click="model.probe()">
              <component :is="busy ? LoaderCircle : Zap" :size="14" :class="{ mp__spin: busy }" />
              <span>{{ busy ? '探测中…' : '探测可用性' }}</span>
            </button>

            <div v-if="model.probeResult" class="mp__result" :data-ok="model.probeResult.ok">
              <component
                :is="model.probeResult.ok ? CircleCheck : CircleAlert"
                :size="14"
                class="mp__result-ico"
              />
              <div class="mp__result-text">
                <p class="mp__result-line">
                  {{ model.probeResult.ok ? '可用' : '不可用' }} ·
                  {{ model.probeResult.latencyMs }}ms · {{ model.probeResult.at }}
                </p>
                <p class="mp__result-msg">{{ model.probeResult.message }}</p>
              </div>
            </div>
          </div>

          <footer class="mp__foot">
            <button type="button" class="mp__link" @click="goSettings">
              <Settings2 :size="14" />
              <span>目录里没有我要的？去设置页自定义 BaseURL / Model ID</span>
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mp {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--k12-fg) 34%, transparent);
}
.mp__box {
  width: 100%;
  max-width: 560px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}
.mp__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--k12-border);
}
.mp__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mp__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.mp__sub {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.mp__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .mp__close:hover {
    background: var(--k12-surface-2);
    color: var(--k12-fg-2);
  }
}

.mp__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mp__item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .mp__item:hover {
    border-color: var(--k12-accent-border);
  }
}
/* 选中项：浅底 + 墨色描边。不用投影，靠底色与描边就够分得开。 */
.mp__item--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent);
}
.mp__check {
  flex: none;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}
.mp__item--on .mp__check {
  background: var(--k12-accent-ink);
  color: var(--k12-surface);
}
.mp__item-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mp__item-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.mp__vision {
  color: var(--k12-muted);
}
/* 供应商 · BaseURL：这一项的说明性 meta（读得懂的键值），不是角标 */
.mp__item-meta {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp__tags {
  flex: none;
  display: flex;
  gap: 4px;
}
.mp__tag {
  padding: 1px 7px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
  white-space: nowrap;
}

.mp__probe {
  padding: 12px 18px;
  border-top: 1px solid var(--k12-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 描边式按钮（形态参考 uiverse 社区的 outline 反转款，但用本项目的 token 实现：
 * 零动效、无位移、颜色全走变量） */
.mp__probe-btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .mp__probe-btn:hover:not(:disabled) {
    border-color: var(--k12-accent);
    color: var(--k12-accent-ink);
  }
}
.mp__probe-btn:disabled {
  opacity: 0.6;
  cursor: progress;
}
.mp__spin {
  animation: mp-spin 0.9s linear infinite;
}
@keyframes mp-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mp__spin {
    animation: none;
  }
}

.mp__result {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-good-soft);
  color: var(--k12-good);
}
.mp__result[data-ok='false'] {
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
}
.mp__result-ico {
  flex: none;
  margin-top: 2px;
}
.mp__result-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mp__result-line {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
}
.mp__result-msg {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

.mp__foot {
  padding: 12px 18px;
  border-top: 1px solid var(--k12-border);
}
.mp__link {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .mp__link:hover {
    color: var(--k12-accent-ink);
  }
}
.mp-fade-enter-active,
.mp-fade-leave-active {
  transition: opacity 120ms var(--k12-ease-state);
}
.mp-fade-enter-from,
.mp-fade-leave-to {
  opacity: 0;
}
</style>
