/**
 * 账号（Pinia）：这台电脑上有哪些学生、现在用的是谁、以及账号级的四个动作。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么「切换账号」是**整页重载**，而不是逐个 store 清缓存
 * ══════════════════════════════════════════════════════════════════════════
 * 学生态散在十几个 store 里：身份（student）/ 会话（chat）/ 画像（profileCard）/
 * 引导五问（onboarding）/ 闯关进度与题目（quiz）/ 学段（chat 与 grade 桥）/ 主题
 * （theme）/ 工具轨迹（trace）…… 逐个清是一份**手写清单**，而这类清单必然漏项
 * （本仓在滚动跟随那里已经交过一次学费）。漏掉的那一个不会报错，它会以
 * 「上一个学生的数据」的形态出现在新学生的界面上 —— 那是隐私事故，不只是显示错误。
 * 所以这里不做清单：整页重载把「切换」变成「重新启动」，缓存随渲染上下文一起消失，
 * 新学生从零装配。代价是切号会丢掉还没保存的编辑器内容，而切号本来就是
 * 「换一个人用这台电脑」，这个代价是对的。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么门禁判据放在 sessionStorage（而不是 store 里的一个 ref）
 * ══════════════════════════════════════════════════════════════════════════
 * 上面那条「整页重载」与「启动时列出账号」是同一件事的两面：
 *   · 重载之后**不该又弹一次**门禁（学生刚选完）；
 *   · 但**下一次启动**该弹（这台电脑可能换了人用）。
 * 这正好是 sessionStorage 的语义：同一次窗口会话内跨重载保留，应用重启即清空。
 * 放 store 的 ref 会在重载时丢掉 → 每次切号都绕回门禁；放 localStorage 又会让
 * 「换个人用」永远拿不到选择机会。读不到时按「没进门」处理并 try/catch 兜住 ——
 * 门禁多弹一次是可恢复的，白屏不是。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 能力探测临时写在这里（api/* 不在本任务的写入范围）
 * ══════════════════════════════════════════════════════════════════════════
 * 五条 `accounts:*` 通道由主进程侧提供。本文件用 {@link resolveAccountsBridge}
 * **按方法名**逐个探测、缺一个就整块不可用（与 `api/data.ts` / `api/study.ts` 同一口径：
 * 屏幕上是学生话，缺哪个方法进控制台 `warnWiring`）。
 * ⚠️ 主进程/preload 那五条通道落地后：把强类型收进 `api/accounts.ts`，
 *   这里的 `resolveAccountsBridge` 只留一个薄壳（re-export 或转发），**替换只动这一处**。
 * ★ 故障开放：桥不可用时**不拦路** —— 门禁不显示，应用照常进默认学生
 *   （少一个功能，好过多一个死界面）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { GradeLevel } from '@shared/ipc-events'
import { describeClientError, toStudentFacingMessage } from '../api/student-facing'
import { warnWiring } from '../api/wiring-notice'
import { useStudentStore } from './student'

/**
 * 列表里的一条学生记录。
 *
 * ★ 字段都是**可选容错**（除 id 与昵称）：这套通道的契约还在落地中，
 *   缺学段时界面显示「还没认出年级」，缺时间戳时不显示「最近使用」那行 ——
 *   宁可少一行字，也不拿一个猜出来的默认值冒充真实数据。
 */
export interface AccountSummary {
  studentId: string
  nickname: string
  gradeLevel?: GradeLevel
  /** 最近一次使用（毫秒时间戳）。 */
  lastActiveAt?: number
  createdAt?: number
  currentChapter?: string
}

/** 数据面回执（与 `api/data.ts` 的 `DataCallResult` 同形，回执从不抛）。 */
export type AccountsCallResult<T = unknown> = { ok: true; data: T } | { ok: false; message: string }

/** 账号能力（探测通过后由 {@link resolveAccountsBridge} 组装）。 */
export interface AccountsBridge {
  /**
   * 读名单。
   * ★ 回执的 `data` 是 `unknown`，**形状在这里校验**（`readStudents`）而不是靠泛型断言：
   *   主进程转的是 Python 的 JSON，多一个字段少一个字段都不该让界面崩。
   */
  list(): Promise<AccountsCallResult>
  create(payload: { nickname: string; gradeLevel: GradeLevel }): Promise<AccountsCallResult>
  rename(payload: { studentId: string; nickname?: string; gradeLevel?: GradeLevel }): Promise<AccountsCallResult>
  remove(payload: { studentId: string }): Promise<AccountsCallResult>
  switchTo(payload: { studentId: string }): Promise<AccountsCallResult>
}

export type AccountsBridgeLookup =
  | { ready: true; bridge: AccountsBridge }
  | { ready: false; message: string }

/**
 * 账号能力不可用时**给学生看的那句话**。
 *
 * ★ 说清三件事：现在用不了、但你**照样能学**（用中性称呼继续）、需要时找谁。
 *   不出现方法名 / 通道名 / 「接线」这类词（那些进控制台，见 `warnWiring`）。
 */
export const ACCOUNTS_BRIDGE_MISSING_HINT = '这台电脑还没准备好账号功能，先用「同学」继续学。'

/** 名单读不出来时的兜底句（也用于「读到了但形状不对」这种半坏状态）。 */
const ACCOUNTS_READ_FAILED_HINT = '名单暂时读不出来，稍后再试一次。'

/** 某个账号动作没走通时的兜底句。 */
const ACCOUNTS_ACTION_FAILED_HINT = '这一步暂时没走通，稍后再试一次。'

/** 本层需要的五个方法名（**唯一清单**：探测与诊断都读它）。 */
/**
 * preload 白名单上这五个方法的名字（**必须与 `src/preload/index.ts` 的 K12Api 逐字一致**）。
 *
 * ⚠️ 2026-09-30 集成实测踩过：这里最初写的是通道键名（`accountsList`/…），而 preload 暴露的是
 *   方法名（`listAccounts`/…）—— 探测逐个当作函数查，名字差一个字母就整体判「能力不可用」，
 *   而按设计那时是**故障开放**（门禁不出现），于是表现为「账号功能静悄悄没生效」。
 *   通道键名在 `channels.ts`，方法名在 `preload/index.ts`，两处不同名是刻意的（一个给 IPC，一个给学生面 API）。
 */
const REQUIRED_METHODS = [
  'listAccounts',
  'createAccount',
  'renameAccount',
  'deleteAccount',
  'switchAccount'
] as const

/**
 * `window.api` 上这五个方法的**结构形状**。
 *
 * ★ 为什么是「可选 + 结构探测」而不是把 `window.api` 断言成整块 `AccountsBridge`：
 *   主进程与 preload 是分步落地的，此刻类型上还没有这五个方法；整块双重断言会把
 *   真实签名一起抹掉（`api/grade.ts` 里记着这个教训）。这里的做法是
 *   **逐个确认是函数**再按名包装，签名一改这里就报错，且缺方法时不是运行时崩溃。
 */
interface MaybeAccountsApi {
  listAccounts?: () => Promise<AccountsCallResult>
  createAccount?: (payload: { nickname: string; gradeLevel: GradeLevel }) => Promise<AccountsCallResult>
  renameAccount?: (payload: {
    studentId: string
    nickname?: string
    gradeLevel?: GradeLevel
  }) => Promise<AccountsCallResult>
  deleteAccount?: (payload: { studentId: string }) => Promise<AccountsCallResult>
  switchAccount?: (payload: { studentId: string }) => Promise<AccountsCallResult>
}

/**
 * 探测 `window.api` 上的账号能力。
 *
 * ★ 缺方法时**一次把清单列全**（不是遇到第一个就返回）：接线的人要的是完整清单。
 * ★ 显式逐个包装（不用 `as unknown as` 抹平签名）：函数签名一改，typecheck 当场报。
 */
export function resolveAccountsBridge(host: unknown = globalThis.window?.api): AccountsBridgeLookup {
  if (typeof host !== 'object' || host === null) {
    warnWiring(
      'accounts',
      'window.api 缺失：preload 没有加载（整块账号能力不可用）。检查 preload 入口与 contextIsolation / sandbox 配置。'
    )
    return { ready: false, message: ACCOUNTS_BRIDGE_MISSING_HINT }
  }
  const api = host as MaybeAccountsApi
  const missing = REQUIRED_METHODS.filter((method) => typeof api[method] !== 'function')
  if (missing.length > 0) {
    warnWiring(
      'accounts.methods',
      `preload 白名单缺少这 ${missing.length} 个方法：${missing.join(' / ')}。` +
        '需要先在主进程注册 accounts:* 五条通道（list / create / rename / delete / switch），' +
        '再由 preload 白名单逐方法暴露。接线后重启渲染进程即可生效。'
    )
    return { ready: false, message: ACCOUNTS_BRIDGE_MISSING_HINT }
  }
  return {
    ready: true,
    bridge: {
      list: () => api.listAccounts!(),
      create: (payload) => api.createAccount!(payload),
      rename: (payload) => api.renameAccount!(payload),
      remove: (payload) => api.deleteAccount!(payload),
      switchTo: (payload) => api.switchAccount!(payload)
    }
  }
}

/**
 * 「最近使用」那一行。
 *
 * ★ 用**日期差**而不是「距离现在多少小时」：学生记的是「今天 / 昨天」，
 *   而「14 小时前」在一个跨夜使用的场景里会让人读反。
 * ★ 时间戳取不到（老数据 / 形状不对）时返回空串 —— 调用方据此整行省略。
 */
export function formatLastUsed(at: number | undefined, now: number = Date.now()): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return ''
  const day = (value: number): number => {
    const date = new Date(value)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  const days = Math.round((day(now) - day(at)) / 86_400_000)
  if (days <= 0) return '今天用过'
  if (days === 1) return '昨天用过'
  if (days < 30) return `${days} 天前用过`
  return '很久没用过了'
}

/** `k12.account.entered`：本次窗口会话已经进过门禁的那个学生 id（'' = 还没进）。 */
const ENTERED_KEY = 'k12.account.entered'

/** 读「已进门」标记；不可用（沙箱 / 隐私设置抛错）时按「没进」处理，绝不冒泡。 */
function readEntered(): string {
  try {
    return globalThis.sessionStorage?.getItem(ENTERED_KEY) ?? ''
  } catch {
    return ''
  }
}

function writeEntered(studentId: string): void {
  try {
    globalThis.sessionStorage?.setItem(ENTERED_KEY, studentId)
  } catch {
    // 存不下只影响「重载后会不会再弹一次门禁」，不影响这一次的选择
  }
}

function clearEntered(): void {
  try {
    globalThis.sessionStorage?.removeItem(ENTERED_KEY)
  } catch {
    // 同上
  }
}

/** 从任意回执里认出「一个学生」（服务端可能把学生直接放在 data 上，也可能包一层）。 */
function pickStudent(data: unknown): AccountSummary | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  for (const candidate of [record.student, record.data, record]) {
    if (typeof candidate === 'object' && candidate !== null) {
      const account = candidate as Record<string, unknown>
      if (typeof account.studentId === 'string' && typeof account.nickname === 'string') {
        return candidate as AccountSummary
      }
    }
  }
  return null
}

/** 列表回执 → 学生数组（形状不对时给空数组：半截对象不该被渲染成卡片）。 */
function readStudents(data: unknown): AccountSummary[] {
  if (typeof data !== 'object' || data === null) return []
  const list = (data as { students?: unknown }).students
  if (!Array.isArray(list)) return []
  const out: AccountSummary[] = []
  for (const raw of list) {
    const account = pickStudent(raw)
    if (account) out.push(account)
  }
  return out
}

/** 整页重载（见文件头第一段）。测试环境里可能没有真的 location，吞掉即可。 */
function reloadNow(): void {
  try {
    globalThis.location?.reload()
  } catch {
    // 没有真实窗口（单测）时不做任何事
  }
}

export const useAccountsStore = defineStore('accounts', () => {
  /** 本机账号列表（时间无关，顺序由服务端给）。 */
  const accounts = ref<AccountSummary[]>([])
  const loading = ref(false)
  /** 学生可见的失败说明（已过 `toStudentFacingMessage`，不含技术词）。 */
  const error = ref<string | null>(null)
  /** 账号能力是否可用（false 时门禁不显示 —— 故障开放，见文件头）。 */
  const ready = ref(false)
  /** 能力不可用时给学生的那句话（空串 = 可用）。 */
  const bridgeMessage = ref('')
  /** 有账号动作在途（按钮据此禁用，防连点）。 */
  const busy = ref(false)
  /** 账号菜单是否展开（挂在 App.vue 上，由侧栏身份卡切换）。 */
  const menuOpen = ref(false)
  /** 本次窗口会话已经进过门禁的学生 id（'' = 还没进）。 */
  const entered = ref(readEntered())

  /** 当前生效的学生（身份的唯一真相在 `stores/student.ts`，这里只是读它）。 */
  const student = useStudentStore()
  const activeId = computed(() => student.student?.studentId ?? '')

  /**
   * 门禁是否该出现。
   *
   * ★ 只有两条判据：能力就绪（否则故障开放，见文件头）+ 本次会话还没进过门。
   *   **「本机有没有账号」不在判据里** —— 一个都没有时门禁仍然要出现，
   *   只是它显示的是「新建第一个账号」那张表单（见 AccountGate）。
   */
  const gateOpen = computed(() => ready.value && entered.value === '')

  function bridgeOrNull(): AccountsBridge | null {
    const lookup = resolveAccountsBridge()
    ready.value = lookup.ready
    bridgeMessage.value = lookup.ready ? '' : lookup.message
    return lookup.ready ? lookup.bridge : null
  }

  /** 读账号列表（幂等，可反复调用）。 */
  async function load(): Promise<void> {
    const bridge = bridgeOrNull()
    if (!bridge) return
    loading.value = true
    error.value = null
    try {
      const result = await bridge.list()
      if (!result.ok) {
        error.value = toStudentFacingMessage(result.message, { fallback: ACCOUNTS_READ_FAILED_HINT })
        return
      }
      accounts.value = readStudents(result.data)
    } catch (thrown) {
      error.value = describeClientError(thrown, { fallback: ACCOUNTS_READ_FAILED_HINT })
    } finally {
      loading.value = false
    }
  }

  /**
   * 进入某个账号。
   *
   * ★ 点自己（就是当前这个人）**不发切换请求**：什么都不用变，只把「已进门」记下来。
   *   少一次写库，也少一次「切到自己」这种语义空转。
   */
  async function enter(studentId: string): Promise<boolean> {
    if (studentId.trim() === '') return false
    if (studentId === activeId.value) {
      entered.value = studentId
      writeEntered(studentId)
      return true
    }
    const bridge = bridgeOrNull()
    if (!bridge) {
      error.value = bridgeMessage.value
      return false
    }
    busy.value = true
    error.value = null
    try {
      const result = await bridge.switchTo({ studentId })
      if (!result.ok) {
        error.value = toStudentFacingMessage(result.message, { fallback: ACCOUNTS_ACTION_FAILED_HINT })
        return false
      }
      entered.value = studentId
      writeEntered(studentId)
      reloadNow()
      return true
    } catch (thrown) {
      error.value = describeClientError(thrown, { fallback: ACCOUNTS_ACTION_FAILED_HINT })
      return false
    } finally {
      busy.value = false
    }
  }

  /**
   * 新建一个账号并立刻进入它（新账号从零开始 → 现有冷启动五问会自己接管）。
   *
   * ★ 新学生的 id **只能来自服务端**（一人一库，id 是那条记录的键）。
   *   回执里给了就照用；没给就在刷新后的名单里找**刚才没有的那一条**；
   *   两条都拿不到时**不猜** —— 报一句「没走通」比切到一个错的人身上好得多。
   */
  async function createAccount(nickname: string, gradeLevel: GradeLevel): Promise<boolean> {
    const bridge = bridgeOrNull()
    if (!bridge) {
      error.value = bridgeMessage.value
      return false
    }
    const before = new Set(accounts.value.map((item) => item.studentId))
    busy.value = true
    error.value = null
    try {
      const result = await bridge.create({ nickname: nickname.trim(), gradeLevel })
      if (!result.ok) {
        error.value = toStudentFacingMessage(result.message, { fallback: ACCOUNTS_ACTION_FAILED_HINT })
        return false
      }
      const created = pickStudent(result.data)
      await load()
      const target =
        created?.studentId ?? accounts.value.find((item) => !before.has(item.studentId))?.studentId ?? ''
      if (target === '') {
        error.value = ACCOUNTS_ACTION_FAILED_HINT
        return false
      }
      return await enter(target)
    } catch (thrown) {
      error.value = describeClientError(thrown, { fallback: ACCOUNTS_ACTION_FAILED_HINT })
      return false
    } finally {
      busy.value = false
    }
  }

  /**
   * 改名 / 改学段。
   *
   * ★ 改的是**当前这个人**而且动了学段时整页重载：学段是全局环境（主题配色、对话口吻、
   *   教材范围都从它派生），而它们各自的缓存不在本文件能碰的范围内 —— 与切号同一条理由，
   *   与其逐个通知不如重启一次。只改名时不必重载：把身份缓存作废、让侧栏重读一次就够。
   */
  async function renameAccount(
    studentId: string,
    patch: { nickname?: string; gradeLevel?: GradeLevel }
  ): Promise<boolean> {
    const bridge = bridgeOrNull()
    if (!bridge) {
      error.value = bridgeMessage.value
      return false
    }
    busy.value = true
    error.value = null
    try {
      const result = await bridge.rename({ studentId, ...patch })
      if (!result.ok) {
        error.value = toStudentFacingMessage(result.message, { fallback: ACCOUNTS_ACTION_FAILED_HINT })
        return false
      }
      await load()
      const isCurrent = studentId === activeId.value
      if (isCurrent) {
        student.reset()
        if (patch.gradeLevel !== undefined) reloadNow()
        else void student.load()
      }
      return true
    } catch (thrown) {
      error.value = describeClientError(thrown, { fallback: ACCOUNTS_ACTION_FAILED_HINT })
      return false
    } finally {
      busy.value = false
    }
  }

  /**
   * 删除账号。
   *
   * ★ 删掉的正是当前这个人时：**先清掉「已进门」标记再重载** —— 重载后回到门禁，
   *   让剩下的人（或「新建」表单）重新选一次。不这么做的话，门禁会认为「已经进过门」，
   *   而它记住的那个人已经不存在了。
   * ★ 二次确认由调用方（`AccountMenu`）走 `stores/confirm.ts` 完成 —— 这是**不可恢复**
   *   的动作，本文件不做「顺手删掉」的默认路径。
   */
  async function removeAccount(studentId: string): Promise<boolean> {
    const bridge = bridgeOrNull()
    if (!bridge) {
      error.value = bridgeMessage.value
      return false
    }
    busy.value = true
    error.value = null
    try {
      const result = await bridge.remove({ studentId })
      if (!result.ok) {
        error.value = toStudentFacingMessage(result.message, { fallback: ACCOUNTS_ACTION_FAILED_HINT })
        return false
      }
      if (studentId === activeId.value) {
        clearEntered()
        entered.value = ''
        reloadNow()
        return true
      }
      await load()
      return true
    } catch (thrown) {
      error.value = describeClientError(thrown, { fallback: ACCOUNTS_ACTION_FAILED_HINT })
      return false
    } finally {
      busy.value = false
    }
  }

  /**
   * 门禁上的「先这样进去」：**名单读不出来时不许把应用锁死**。
   *
   * ★ 这是 {@link gateOpen} 之外唯一的放行口，且只在界面上出错时才露出来
   *   （见 AccountGate）：能连上服务、只是列表读失败的情况下，学生仍然可以
   *   用当前这个（主进程已有的）身份进去学习。门禁的目的是「选人」，
   *   不是「没网就不让用」。
   */
  function dismissGate(): void {
    entered.value = activeId.value === '' ? '__default__' : activeId.value
    writeEntered(entered.value)
  }

  /** 换人时清掉上一轮的错误行（菜单/门禁重新打开时不该挂着旧失败）。 */
  function clearError(): void {
    error.value = null
  }

  function openMenu(): void {
    menuOpen.value = true
  }

  function closeMenu(): void {
    menuOpen.value = false
  }

  function toggleMenu(): void {
    menuOpen.value = !menuOpen.value
  }

  return {
    accounts,
    loading,
    error,
    ready,
    bridgeMessage,
    busy,
    menuOpen,
    entered,
    activeId,
    gateOpen,
    load,
    enter,
    createAccount,
    renameAccount,
    removeAccount,
    dismissGate,
    clearError,
    openMenu,
    closeMenu,
    toggleMenu
  }
})
