/**
 * 学生身份（Pinia）：当前是谁。
 *
 * ★★ **学生 id 由主进程决定**（`handlers.ts` 的 `resolveActiveStudentId`），
 *   渲染进程既递不进去、也改不了 —— 一旦它变成前端可填的参数，
 *   「读别人的画像与学习记录」就只是改一个字符串的事。
 *
 * ★ 为什么单独一个 store 而不是塞进 `chat`：
 *   侧栏（昵称）、对话页（学段导语）、档案页（报告抬头）、依赖图（节点掌握度）
 *   都要用它，而它们**都不该为了拿一个昵称而把对话 store 拉起来**。
 *
 * ★ 库里一个学生都没有时主进程**建一个**（新装的机器首跑就是这种情况）——
 *   所以这个 store 的加载失败基本只有一种原因：sidecar 没起来。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { GradeLevel } from '@shared/ipc-events'
import { resolveDataBridge, type StudentView } from '../api/data'

export const useStudentStore = defineStore('student', () => {
  const student = ref<StudentView | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 非响应式的在途标记：并发的 `load()` 只发一次请求。 */
  let inFlight: Promise<void> | null = null

  /**
   * 昵称的显示值。
   *
   * ★★ 必须同时挡 `null` 与**空串**：`??` 只拦前者，而库里真有 `nickname = ''` 的行
   *   （早先的建库路径没写昵称就落了盘）。空串会一路渲染成「你好，」—— 界面上
   *   看起来像模板漏了变量，而不像「这个人没名字」。
   * ★ 兜底值是「同学」：K12 场景**不在展示层采集真实姓名**，缺名字时用中性称呼。
   */
  const nickname = computed(() => student.value?.nickname?.trim() || '同学')
  const gradeLevel = computed<GradeLevel | null>(() => student.value?.gradeLevel ?? null)
  const currentChapter = computed(() => student.value?.currentChapter ?? '')
  /** 侧栏头像用的首字（中文取第一个字，英文取首字母）。 */
  const avatarText = computed(() => nickname.value.trim().slice(0, 1) || '同')

  /**
   * 读当前学生（幂等：已有数据就直接返回，除非 `force`）。
   *
   * ★ 失败**不抛**：侧栏拿不到昵称只是少一行字，不该把整页打空。
   *   失败时把原因写进 `error`，由界面决定怎么提示。
   */
  async function load(force = false): Promise<void> {
    if (inFlight) return await inFlight
    if (student.value !== null && !force) return

    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      error.value = lookup.message
      return
    }

    loading.value = true
    error.value = null
    inFlight = (async () => {
      try {
        const result = await lookup.bridge.getStudent()
        if (!result.ok) {
          error.value = result.message
          return
        }
        const data = result.data as StudentView | null
        // ★ 形状校验：主进程会把 Python 的 JSON 原样搬过来，这里挡一手
        //   （半截对象会让 `nickname` 变成 undefined，界面上就是一片空白）
        if (data && typeof data.studentId === 'string' && typeof data.nickname === 'string') {
          student.value = data
        } else {
          error.value = '读取学生信息失败：本地数据服务返回的数据不完整。'
        }
      } catch (thrown) {
        error.value = thrown instanceof Error ? thrown.message : String(thrown)
      } finally {
        loading.value = false
        inFlight = null
      }
    })()
    await inFlight
  }

  /**
   * 更新「当前章节」（学生刚在指示器里改过时调用）。
   *
   * ★ 不重新请求：章节的**权威值**在 `chat.currentChapter`（服务端回执 / 推送），
   *   这里只是把侧栏与档案页读的那一份对齐，免得出现「指示器说第 3 章、
   *   档案页还说第 1 章」这种同页不一致。
   */
  function applyChapter(chapterTitle: string): void {
    if (student.value === null) return
    student.value = { ...student.value, currentChapter: chapterTitle }
  }

  return { student, loading, error, nickname, gradeLevel, currentChapter, avatarText, load, applyChapter }
})
