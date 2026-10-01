<script setup lang="ts">
/**
 * 账号菜单 —— 侧栏身份卡点开后弹出的那一块。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么挂在应用根（App.vue 的 overlay）而不是侧栏内部
 * ══════════════════════════════════════════════════════════════════════════
 * 侧栏在窄窗口会被收成 68px 图标条，菜单要是长在它里面就会跟着被裁掉；
 * 而且「换个人用」这件事**不属于任何一页**（换人要整页重载，见
 * `stores/accounts.ts` 的文件头）。所以这里是一块全局浮层，只由 store 的
 * `menuOpen` 控制 —— 侧栏那一行只负责把它打开。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三件用户裁决（别顺手改回去）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **没有密码 / PIN**：这台电脑是共用机，学生名单本来就是明面上的；
 *      加一道密码只会让忘密码的人进不去，挡不住想换号的兄弟姐妹。
 *   ② **删号必须二次确认**，且确认文案写明「不可恢复」并指路「先导出学习档案」，
 *      因为一人一库，删号等于把那个人的学习记录一起清掉。
 *   ③ 菜单里保留**「看学习记录」**：身份卡原来那一下点击就是去学习档案的，
 *      改成开菜单之后不能让学生少一条路（所以它是这个菜单的第一项）。
 */
import { computed, ref, watch } from 'vue'
import { BookMarked, ChevronRight, Download, Pencil, Plus, Trash2, X } from 'lucide-vue-next'
import type { GradeLevel } from '@shared/ipc-events'
import { GRADE_LEVELS } from '../api/grade'
import { GRADE_LABELS, GRADE_UNKNOWN_LABEL } from '../labels'
import { useAccountsStore, type AccountSummary } from '../stores/accounts'
import { useConfirm } from '../stores/confirm'
import { useStudentStore } from '../stores/student'
import { useStudyStore } from '../stores/study'
import { useUiStore } from '../stores/ui'
import { useEscape } from '../composables/useEscape'
import { useFocusReturn } from '../composables/useFocusReturn'

const accounts = useAccountsStore()
const confirm = useConfirm()
const student = useStudentStore()
const study = useStudyStore()
const ui = useUiStore()

const rootRef = ref<HTMLElement | null>(null)

/** 学段四选一：顺序与标签都取自既有来源，不在这里另排一份。 */
const gradeOptions = GRADE_LEVELS

/** 内联小面板：同一时刻只开一个（开两个会让人不知道该填哪个）。 */
type Pane = 'none' | 'create' | 'rename'
const pane = ref<Pane>('none')

const draftName = ref('')
const draftGrade = ref<GradeLevel>('junior')

/** 当前这个人之外的账号（「换个人用」列表）。 */
const others = computed(() =>
  accounts.accounts.filter((item) => item.studentId !== accounts.activeId)
)

const currentGradeLabel = computed(() =>
  student.gradeLevel === null ? GRADE_UNKNOWN_LABEL : GRADE_LABELS[student.gradeLevel]
)

const canSubmit = computed(() => draftName.value.trim().length > 0)

function gradeLabelOf(level: GradeLevel | undefined): string {
  return level === undefined ? GRADE_UNKNOWN_LABEL : GRADE_LABELS[level]
}

function avatarTextOf(account: AccountSummary): string {
  return account.nickname.trim().slice(0, 1) || '同'
}

/**
 * 打开内联面板。
 *
 * ★ 改名表单的初值取**库里的真名**（`student.student`），不取显示用的
 *   `student.nickname` —— 后者在缺名字时会兜成「同学」，把它填进输入框
 *   等于替学生填了一个他没打过的名字。
 */
function togglePane(next: Exclude<Pane, 'none'>): void {
  pane.value = pane.value === next ? 'none' : next
  accounts.clearError()
  if (next === 'create') {
    draftName.value = ''
    draftGrade.value = student.gradeLevel ?? 'junior'
    return
  }
  draftName.value = student.student?.nickname ?? ''
  draftGrade.value = student.gradeLevel ?? 'junior'
}

function goStudy(): void {
  ui.go('study')
  accounts.closeMenu()
}

async function switchTo(studentId: string): Promise<void> {
  const ok = await accounts.enter(studentId)
  // 换人会整页重载（那之后这段不会再跑）；点到自己时不重载，关掉菜单即可
  if (ok && studentId === accounts.activeId) accounts.closeMenu()
}

async function submitCreate(): Promise<void> {
  if (!canSubmit.value) return
  const ok = await accounts.createAccount(draftName.value, draftGrade.value)
  if (ok) {
    pane.value = 'none'
    accounts.closeMenu()
  }
}

async function submitRename(): Promise<void> {
  if (!canSubmit.value || accounts.activeId === '') return
  const ok = await accounts.renameAccount(accounts.activeId, {
    nickname: draftName.value.trim(),
    gradeLevel: draftGrade.value
  })
  if (ok) pane.value = 'none'
}

async function exportArchive(): Promise<void> {
  // 复用学习档案页同一条导出实现（拼装是纯函数、写盘走主进程的原生保存框）——
  // 这里不自己拼 Markdown，否则两处口径会分叉。
  await study.loadReport()
  await study.exportReport()
}

/**
 * 删除当前账号。
 *
 * ★ 确认文案说三件事：会发生什么、**不可恢复**、以及先做什么（导出）。
 *   `confirm.ask` 的 body 是**纯文本**（不解析标记符号），所以里面不用任何格式符。
 */
async function askDelete(): Promise<void> {
  if (accounts.activeId === '') return
  const ok = await confirm.ask({
    title: '删除这个账号？',
    body: '删除后，这个账号的学习记录会一起清掉，无法恢复。建议先用上面的「导出学习档案」保存一份。',
    danger: true,
    confirmText: '删除'
  })
  if (!ok) return
  await accounts.removeAccount(accounts.activeId)
}

/**
 * 打开时重读名单 + 收起内联面板。
 *
 * ★ 为什么要在打开时读：菜单可以开很多次，期间可能在别处建过号；
 *   上一轮的失败行也不该跨次挂着（`clearError`）。
 */
watch(
  () => accounts.menuOpen,
  (open) => {
    if (!open) return
    accounts.clearError()
    pane.value = 'none'
    void accounts.load()
  }
)

/** Esc 关闭 + 打开时焦点移入、关闭归还（非模态浮层，不锁 Tab）。 */
useEscape(() => accounts.closeMenu(), () => accounts.menuOpen)
useFocusReturn(rootRef, () => accounts.menuOpen, { trap: false })
</script>

<template>
  <Teleport to="body">
    <div v-if="accounts.menuOpen" class="acctm" data-testid="account-menu">
      <!-- 遮罩：点空白也算「我不选了」（菜单是非模态的，不拦着后面操作） -->
      <div class="acctm__scrim" @click="accounts.closeMenu()" />

      <section
        ref="rootRef"
        class="acctm__panel k12-float"
        role="dialog"
        aria-label="账号"
        data-testid="account-menu-panel"
      >
        <header class="acctm__head">
          <div class="acctm__avatar" aria-hidden="true">{{ student.avatarText }}</div>
          <div class="acctm__who">
            <p class="acctm__name">{{ student.nickname }}</p>
            <p class="acctm__grade">{{ currentGradeLabel }}</p>
          </div>
          <button
            type="button"
            class="acctm__icon-btn"
            title="关闭"
            data-testid="account-menu-close"
            @click="accounts.closeMenu()"
          >
            <X :size="14" />
          </button>
        </header>

        <p v-if="!accounts.ready" class="acctm__note">{{ accounts.bridgeMessage }}</p>
        <p v-else-if="accounts.error" class="acctm__error" data-testid="account-menu-error">
          {{ accounts.error }}
        </p>

        <div class="acctm__body">
          <!-- ① 身份卡原来那一下的目的地：留着，别让学生少一条路 -->
          <button
            type="button"
            class="acctm__item"
            data-testid="account-go-study"
            @click="goStudy()"
          >
            <BookMarked :size="15" />
            <span class="acctm__item-text">看学习记录</span>
            <ChevronRight :size="15" class="acctm__chev" />
          </button>

          <!-- ② 换个人用（点一下即进，没有密码） -->
          <section v-if="others.length > 0" class="acctm__group" data-testid="account-switch-list">
            <p class="acctm__label">换个人用</p>
            <button
              v-for="item in others"
              :key="item.studentId"
              type="button"
              class="acctm__account"
              data-testid="account-switch"
              :disabled="accounts.busy"
              @click="switchTo(item.studentId)"
            >
              <span class="acctm__mini" aria-hidden="true">{{ avatarTextOf(item) }}</span>
              <span class="acctm__account-name">{{ item.nickname }}</span>
              <span class="acctm__account-grade">{{ gradeLabelOf(item.gradeLevel) }}</span>
            </button>
          </section>

          <!-- ③ 新建账号 -->
          <button
            type="button"
            class="acctm__item"
            data-testid="account-create-toggle"
            @click="togglePane('create')"
          >
            <Plus :size="15" />
            <span class="acctm__item-text">新建账号</span>
            <ChevronRight :size="15" class="acctm__chev" />
          </button>
          <div v-if="pane === 'create'" class="acctm__form" data-testid="account-create-form">
            <label class="acctm__field">
              <span class="acctm__label">昵称</span>
              <input
                v-model="draftName"
                class="acctm__input"
                type="text"
                maxlength="12"
                placeholder="比如：小雨"
                data-testid="account-create-name"
              />
            </label>
            <div class="acctm__field">
              <span class="acctm__label">学段</span>
              <div class="acctm__grades">
                <button
                  v-for="level in gradeOptions"
                  :key="level"
                  type="button"
                  class="acctm__grade-btn"
                  :data-on="String(draftGrade === level)"
                  :data-testid="`account-grade-${level}`"
                  @click="draftGrade = level"
                >
                  {{ GRADE_LABELS[level] }}
                </button>
              </div>
            </div>
            <button
              type="button"
              class="acctm__confirm"
              :disabled="!canSubmit || accounts.busy"
              data-testid="account-create-submit"
              @click="submitCreate()"
            >
              建好了，开始
            </button>
          </div>

          <!-- ★ 管理项只在**账号能力可用**时出现：桥没就绪时它们点了只会报一句
               「用不了」，摆在菜单里等于给了一个按不动的按钮。 -->
          <template v-if="accounts.ready && accounts.activeId !== ''">
            <!-- ④ 改名与学段（只改当前这个人） -->
            <button
              type="button"
              class="acctm__item"
              data-testid="account-rename-toggle"
              @click="togglePane('rename')"
            >
              <Pencil :size="15" />
              <span class="acctm__item-text">改名与学段</span>
              <ChevronRight :size="15" class="acctm__chev" />
            </button>
            <div v-if="pane === 'rename'" class="acctm__form" data-testid="account-rename-form">
              <label class="acctm__field">
                <span class="acctm__label">昵称</span>
                <input
                  v-model="draftName"
                  class="acctm__input"
                  type="text"
                  maxlength="12"
                  data-testid="account-rename-name"
                />
              </label>
              <div class="acctm__field">
                <span class="acctm__label">学段</span>
                <div class="acctm__grades">
                  <button
                    v-for="level in gradeOptions"
                    :key="level"
                    type="button"
                    class="acctm__grade-btn"
                    :data-on="String(draftGrade === level)"
                    :data-testid="`account-rename-grade-${level}`"
                    @click="draftGrade = level"
                  >
                    {{ GRADE_LABELS[level] }}
                  </button>
                </div>
              </div>
              <button
                type="button"
                class="acctm__confirm"
                :disabled="!canSubmit || accounts.busy"
                data-testid="account-rename-submit"
                @click="submitRename()"
              >
                保存
              </button>
            </div>

            <!-- ⑤ 导出学习档案（删号前的退路，先摆出来） -->
            <button
              type="button"
              class="acctm__item"
              :disabled="study.exporting"
              data-testid="account-export"
              @click="exportArchive()"
            >
              <Download :size="15" />
              <span class="acctm__item-text">{{ study.exporting ? '正在导出…' : '导出学习档案' }}</span>
            </button>
            <p v-if="study.exportNotice" class="acctm__note" data-testid="account-export-notice">
              {{ study.exportNotice }}
            </p>

            <!-- ⑥ 危险动作放最后，且要二次确认 -->
            <button
              type="button"
              class="acctm__item acctm__item--danger"
              :disabled="accounts.busy"
              data-testid="account-delete"
              @click="askDelete()"
            >
              <Trash2 :size="15" />
              <span class="acctm__item-text">删除这个账号</span>
            </button>
          </template>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
/* 浮层：遮罩只压一层很浅的暗（它不锁后面的操作，所以不该看起来像模态框） */
.acctm {
  position: fixed;
  inset: 0;
  z-index: 70;
}
.acctm__scrim {
  position: absolute;
  inset: 0;
}
/* 面板贴着侧栏身份卡的位置展开（左侧栏 264px / 窄屏 68px，都从左边 16px 起） */
.acctm__panel {
  position: absolute;
  top: 92px;
  left: 16px;
  width: 272px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  padding: var(--k12-sp-3);
  display: flex;
  flex-direction: column;
  gap: var(--k12-sp-2);
}

.acctm__head {
  display: flex;
  align-items: center;
  gap: var(--k12-sp-2);
}
.acctm__avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-size: var(--k12-fs-caption);
  font-weight: 700;
}
.acctm__who {
  flex: 1;
  min-width: 0;
}
.acctm__name {
  font-size: var(--k12-fs-body-sm);
  font-weight: 650;
  color: var(--k12-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acctm__grade {
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}
.acctm__icon-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .acctm__icon-btn:hover {
    background: var(--k12-surface-2);
    color: var(--k12-fg-2);
  }
}

.acctm__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-top: 1px solid var(--k12-border);
  padding-top: var(--k12-sp-2);
}

/* 菜单项：整行可点，右端一个箭头表示「点进去还有一层」 */
.acctm__item {
  display: flex;
  align-items: center;
  gap: var(--k12-sp-2);
  width: 100%;
  min-height: 32px;
  padding: 0 var(--k12-sp-2);
  border: none;
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  text-align: left;
  cursor: pointer;
}
.acctm__item-text {
  flex: 1;
  min-width: 0;
}
.acctm__chev {
  flex: none;
  color: var(--k12-muted-2);
}
@media (hover: hover) and (pointer: fine) {
  .acctm__item:hover:not(:disabled) {
    background: var(--k12-surface-2);
    color: var(--k12-fg);
  }
}
.acctm__item:disabled {
  color: var(--k12-muted-2);
  cursor: default;
}
/* 危险动作：只用文字色表达（不给整行铺红底 —— 那会让它变成这一屏最抢眼的一项） */
.acctm__item--danger {
  color: var(--k12-bad);
}
@media (hover: hover) and (pointer: fine) {
  .acctm__item--danger:hover:not(:disabled) {
    background: var(--k12-bad-soft);
    color: var(--k12-bad);
  }
}

.acctm__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--k12-sp-1);
}
.acctm__label {
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}
.acctm__account {
  display: flex;
  align-items: center;
  gap: var(--k12-sp-2);
  width: 100%;
  min-height: 32px;
  padding: 0 var(--k12-sp-2);
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .acctm__account:hover:not(:disabled) {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
.acctm__account:disabled {
  opacity: 0.6;
  cursor: default;
}
.acctm__mini {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-label);
  font-weight: 700;
}
.acctm__account-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acctm__account-grade {
  flex: none;
  font-size: var(--k12-fs-label);
  color: var(--k12-muted);
}

.acctm__form {
  display: flex;
  flex-direction: column;
  gap: var(--k12-sp-2);
  margin: var(--k12-sp-1) 0;
  padding: var(--k12-sp-3);
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-inset);
  background: var(--k12-surface-2);
}
.acctm__field {
  display: flex;
  flex-direction: column;
  gap: var(--k12-sp-1);
}
.acctm__input {
  width: 100%;
  min-height: 30px;
  padding: 0 var(--k12-sp-2);
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg);
  font-family: inherit;
  font-size: var(--k12-fs-body-sm);
}
.acctm__input:focus-visible {
  outline: 2px solid var(--k12-accent);
  outline-offset: 1px;
}
.acctm__grades {
  display: flex;
  flex-wrap: wrap;
  gap: var(--k12-sp-1);
}
.acctm__grade-btn {
  min-height: 28px;
  padding: 0 var(--k12-sp-2);
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-family: inherit;
  font-size: var(--k12-fs-label);
  cursor: pointer;
}
.acctm__grade-btn[data-on='true'] {
  border-color: var(--k12-accent-ink);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
  font-weight: 650;
}
/* 表单提交走**描边**而不是主色填充：菜单可能开在任意页面上，
 * 再来一处主色就会让那一屏出现两个「主行动」（判据见 base.css 里 .k12-cta 的说明）。 */
.acctm__confirm {
  min-height: 32px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg);
  font-family: inherit;
  font-size: var(--k12-fs-caption);
  font-weight: 650;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .acctm__confirm:hover:not(:disabled) {
    border-color: var(--k12-accent-ink);
    color: var(--k12-accent-ink);
  }
}
.acctm__confirm:disabled {
  border-color: var(--k12-border);
  background: var(--k12-surface-2);
  color: var(--k12-muted-2);
  cursor: default;
}

.acctm__note {
  font-size: var(--k12-fs-label);
  line-height: var(--k12-lh-ui);
  color: var(--k12-muted);
}
.acctm__error {
  font-size: var(--k12-fs-label);
  line-height: var(--k12-lh-ui);
  color: var(--k12-bad);
}
</style>
