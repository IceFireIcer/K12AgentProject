<script setup lang="ts">
/**
 * 账号门禁 —— 启动时问一句「今天是谁在学」。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有这一屏（本机多人共用的那台电脑）
 * ══════════════════════════════════════════════════════════════════════════
 * 一人一库：学习记录、错题、画像都挂在一个学生 id 下。家里两三个孩子共用一台
 * 电脑时，之前那个「谁先打开就是谁」的默认身份会让**弟弟看到的哥哥的记录** ——
 * 那不是显示错误，是把隐私串了。所以启动时先问一次，选完再进应用。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条刻意的不设计
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **没有密码 / PIN**（用户裁决）：学生名单本来就是明面上的，加一道密码
 *      只会让忘密码的人进不去，挡不住想换号的兄弟姐妹 —— 它拦的是记性，不是人。
 *   ② **不是「设置项」**：它出现在应用启动时、盖住整个窗口，而不是藏在设置页里。
 *      藏起来的话，下一个人打开电脑时看到的仍然是上一个人的界面。
 *   ③ **不新增导航页**（`stores/ui.ts` 的 PAGES 不许加）：它是应用级门禁，
 *      不是「可以去的一个页面」—— 没进门前连侧栏都不该看见。
 *   判据全在 `stores/accounts.ts`（`gateOpen`）：能力没就绪时这屏**根本不出现**，
 *   应用照常进默认学生（故障开放，见那个文件的文件头）。
 */
import { computed, ref, watch } from 'vue'
import { Plus } from 'lucide-vue-next'
import { useFocusReturn } from '../composables/useFocusReturn'
import type { GradeLevel } from '@shared/ipc-events'
import { GRADE_LEVELS } from '../api/grade'
import { GRADE_LABELS, GRADE_UNKNOWN_LABEL } from '../labels'
import { formatLastUsed, useAccountsStore, type AccountSummary } from '../stores/accounts'
import { useStudentStore } from '../stores/student'
import { DEFAULT_LOGO_URL } from '../brand-logo'

const accounts = useAccountsStore()
const student = useStudentStore()
const cardRef = ref<HTMLElement | null>(null)

/** 新建表单：名单为空时直接摊开，非空时点「新建一个账号」才展开。 */
const creating = ref(false)
const draftName = ref('')
const draftGrade = ref<GradeLevel>('junior')

const canSubmit = computed(() => draftName.value.trim().length > 0)
const hasAccounts = computed(() => accounts.accounts.length > 0)
const showForm = computed(() => !hasAccounts.value || creating.value)
const currentId = computed(() => student.student?.studentId ?? '')

function gradeLabelOf(level: GradeLevel | undefined): string {
  return level === undefined ? GRADE_UNKNOWN_LABEL : GRADE_LABELS[level]
}

function avatarTextOf(account: AccountSummary): string {
  return account.nickname.trim().slice(0, 1) || '同'
}

async function pick(studentId: string): Promise<void> {
  await accounts.enter(studentId)
}

async function submitCreate(): Promise<void> {
  if (!canSubmit.value) return
  await accounts.createAccount(draftName.value, draftGrade.value)
}

/**
 * 门禁出现时读一次「上一次是谁」。
 *
 * ★ 只读身份，**不在这里读账号名单** —— 名单由 App.vue 的首屏取数负责
 *   （它挂在 `useOnBackendReady` 上，会随本地服务的就绪自动重试）。
 *   两处都发一次就是同一个请求打两遍。
 */
watch(
  () => accounts.gateOpen,
  (open) => {
    if (open) void student.load()
  },
  { immediate: true }
)

/**
 * 焦点契约：门禁是**模态**的（没选完不该能操作身后的应用），所以
 * 打开时把焦点移进卡片、Tab 锁在卡片里、关闭时归还 —— 用全站同一个 composable，
 * 不在这里手写一份键盘循环。
 */
useFocusReturn(cardRef, () => accounts.gateOpen, { trap: true })
</script>

<template>
  <Teleport to="body">
    <div v-if="accounts.gateOpen" class="gate" data-testid="account-gate">
      <section
        ref="cardRef"
        class="gate__card k12-float"
        role="dialog"
        aria-modal="true"
        aria-label="选择账号"
        data-testid="account-gate-panel"
      >
        <header class="gate__head">
          <img
            class="gate__logo"
            :src="DEFAULT_LOGO_URL"
            :alt="''"
            aria-hidden="true"
            draggable="false"
          />
          <h1 class="gate__title">今天是谁在学？</h1>
          <p class="gate__sub">
            {{ hasAccounts ? '点一下自己的名字就能继续，不用密码。' : '先给自己起个名字，下次回来还能接着学。' }}
          </p>
        </header>

        <p v-if="accounts.error" class="gate__error" data-testid="account-gate-error">
          {{ accounts.error }}
        </p>

        <!-- 名单（点一下即进） -->
        <div v-if="hasAccounts && !creating" class="gate__list">
          <button
            v-for="item in accounts.accounts"
            :key="item.studentId"
            type="button"
            class="gate__account"
            data-testid="account-gate-pick"
            :disabled="accounts.busy"
            @click="pick(item.studentId)"
          >
            <span class="gate__avatar" aria-hidden="true">{{ avatarTextOf(item) }}</span>
            <span class="gate__account-text">
              <span class="gate__account-name">{{ item.nickname }}</span>
              <span class="gate__account-meta">
                {{ gradeLabelOf(item.gradeLevel) }}
                <template v-if="formatLastUsed(item.lastActiveAt)">
                  · {{ formatLastUsed(item.lastActiveAt) }}
                </template>
              </span>
            </span>
            <!-- 「上次用的」只是一个提示，不是选中态：这次还没选，不该显示成已选 -->
            <span v-if="item.studentId === currentId" class="gate__chip">上次用的</span>
          </button>
        </div>

        <button
          v-if="hasAccounts && !creating"
          type="button"
          class="gate__new"
          data-testid="account-gate-new"
          @click="creating = true"
        >
          <Plus :size="15" />
          <span>新建一个账号</span>
        </button>

        <!-- 新建（也是「第一次用这台电脑」时的唯一入口） -->
        <form v-if="showForm" class="gate__form" data-testid="account-gate-form" @submit.prevent="submitCreate()">
          <label class="gate__field">
            <span class="gate__label">昵称</span>
            <input
              v-model="draftName"
              class="gate__input"
              type="text"
              maxlength="12"
              placeholder="比如：小雨"
              data-testid="account-gate-name"
            />
          </label>
          <div class="gate__field">
            <span class="gate__label">学段</span>
            <div class="gate__grades">
              <button
                v-for="level in GRADE_LEVELS"
                :key="level"
                type="button"
                class="gate__grade"
                :data-on="String(draftGrade === level)"
                :data-testid="`account-gate-grade-${level}`"
                @click="draftGrade = level"
              >
                {{ GRADE_LABELS[level] }}
              </button>
            </div>
          </div>
          <!-- ★ 主行动走设计系统的 .k12-cta，不在这里再写一份主色皮肤：
               门禁这一屏只有这一个主行动（进来就是「建号 + 开始」），
               所以主色填充归它，不会和别处抢（见 base.css 里 .k12-cta 的判据）。 -->
          <button
            type="submit"
            class="k12-cta gate__submit"
            :disabled="!canSubmit || accounts.busy"
            data-testid="account-gate-submit"
          >
            开始学习
          </button>
          <button v-if="hasAccounts" type="button" class="gate__cancel" @click="creating = false">
            取消
          </button>
        </form>

        <!-- 读不到名单时的出口：门禁的目的是选人，不是「读不到就不让用」 -->
        <button
          v-if="accounts.error"
          type="button"
          class="gate__skip"
          data-testid="account-gate-skip"
          @click="accounts.dismissGate()"
        >
          先这样进去
        </button>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* 全屏遮罩：它是启动时的第一屏，不是盖在应用上的一层浮窗 —— 所以底色不透明 */
.gate {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--k12-sp-6);
  background: var(--k12-page);
}
.gate__card {
  width: 100%;
  max-width: 420px;
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  padding: var(--k12-sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--k12-sp-4);
}
.gate__head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--k12-sp-2);
  text-align: center;
}
.gate__logo {
  width: 52px;
  height: 52px;
}
.gate__title {
  font-size: var(--k12-fs-h3);
  font-weight: 700;
  color: var(--k12-fg);
}
.gate__sub {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}

.gate__list {
  display: flex;
  flex-direction: column;
  gap: var(--k12-sp-2);
}
.gate__account {
  display: flex;
  align-items: center;
  gap: var(--k12-sp-3);
  width: 100%;
  min-height: 56px;
  padding: var(--k12-sp-2) var(--k12-sp-3);
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  color: var(--k12-fg);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .gate__account:hover:not(:disabled) {
    border-color: var(--k12-accent-ink);
    box-shadow: var(--k12-shadow-card);
  }
}
.gate__account:disabled {
  opacity: 0.6;
  cursor: default;
}
.gate__avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-body-sm);
  font-weight: 700;
}
.gate__account-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.gate__account-name {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gate__account-meta {
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}
.gate__chip {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-label);
  font-weight: 650;
}

.gate__new,
.gate__cancel,
.gate__skip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .gate__new:hover,
  .gate__cancel:hover,
  .gate__skip:hover {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}

.gate__form {
  display: flex;
  flex-direction: column;
  gap: var(--k12-sp-3);
  padding: var(--k12-sp-4);
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
.gate__field {
  display: flex;
  flex-direction: column;
  gap: var(--k12-sp-1);
}
.gate__label {
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}
.gate__input {
  width: 100%;
  min-height: 34px;
  padding: 0 var(--k12-sp-3);
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg);
  font-family: inherit;
  font-size: var(--k12-fs-body-sm);
}
.gate__input:focus-visible {
  outline: 2px solid var(--k12-accent);
  outline-offset: 1px;
}
.gate__grades {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k12-sp-2);
}
.gate__grade {
  min-height: 30px;
  padding: 0 var(--k12-sp-3);
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  cursor: pointer;
}
.gate__grade[data-on='true'] {
  border-color: var(--k12-accent-ink);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-weight: 650;
}
/* 只补布局：颜色 / 圆角 / 五态全部由 .k12-cta 提供（不在这里抄第二份） */
.gate__submit {
  width: 100%;
}

.gate__error {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-bad);
}
</style>
