/**
 * **当前教材章节**（软偏好）在主进程侧的取数层：`chapterPath` / `readChapterTitle` /
 * `fetchChapterState` / `saveChapterState`。
 *
 * ---------------------------------------------------------------------------
 * 章节是什么（决定了它不该做什么）
 * ---------------------------------------------------------------------------
 * 学生可以显式选定「当前在学哪一章教材」，它作为**软偏好**进每轮 System Prompt，
 * 让回答与检索**优先围绕本章**。因此：
 *   - **不做 SQL 硬过滤**：模型仍可回答其它章节的问题（学生本来就该能自由提问）；
 *   - **章节清单**只读 `kb.sqlite`（走既有的 `/api/knowledge/chapters/{grade}`），
 *     而「当前章节」只写该学生自己的 `learning.db` —— 两者**不许混**；
 *   - **不给模型写章节的能力**：它是学生的显式选择（与学段的手动入口同一条纪律），
 *     模型的观察写进 `profile_pref`（`remember_preference`），不写这里。
 *
 * ---------------------------------------------------------------------------
 * 两条纪律（与 `study/client.ts` 同源）
 * ---------------------------------------------------------------------------
 * 1. **绝不抛异常**：调用点在 `ipcMain.handle` 里，抛出去会变成渲染进程侧的
 *    `Error invoking remote method` 堆栈文本；失败一律回可读中文（判别联合）。
 * 2. **错误归一化只有一份**：状态码 / 超时 / 异常到中文的映射全在 `client.ts` 的
 *    `requestStudyJson`（写操作的动词它自己会换成「保存失败」）。
 *
 * ★ **`readChapterTitle` 同时是 IPC 边界的白名单**：渲染进程递来的值一律不当真
 *   （`ipc/handlers.ts` 的 `chapter:set` 处理器用它做入参校验）——
 *   与 `study/client.ts` 的 `readStudyGradeLevel` 同一手法。
 */

import {
  requestStudyJson,
  type StudyRequestOptions,
  type StudyResult
} from './client.ts'

/**
 * 章标题长度上限（**与 `contracts.py` 的 `CHAPTER_TITLE_MAX_CHARS` 同一个数**）。
 *
 * ★ 两处必须一致：服务端超限会 422，而主进程若放过它，学生会看到一句
 *   服务端抛回来的校验消息；在这里先挡住则能得到「本地就能看懂」的提示。
 */
export const CHAPTER_TITLE_MAX_CHARS = 80

/** 当前章节端点（`GET` / `PUT` `/api/profile/{student_id}/chapter`，读写同形）。 */
export function chapterPath(studentId: string): string {
  return `/api/profile/${encodeURIComponent(studentId)}/chapter`
}

/**
 * 字符串 → 章标题（**认不出 / 超长返回 `null`，不是兜底成空串**）。
 *
 * 取值语义：
 *   - 非 string（数字 / 对象 / `null` / `undefined`）→ `null`（拒收，不猜）；
 *   - `trim()` 之后为空 → `''`（★ **空串 = 清除**：回到「不限章节，自由问答」；
 *     它与 `null` 是**两件事** —— 前者是学生的意图，后者是非法入参）；
 *   - 超过 {@link CHAPTER_TITLE_MAX_CHARS} 个**码点** → `null`
 *     （按码点而不是 UTF-16 长度计：与服务端 `len()` 的口径一致，
 *     否则一个全 emoji 的标题会在本地通过、到服务端被 422）。
 */
export function readChapterTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const title = value.trim()
  return Array.from(title).length > CHAPTER_TITLE_MAX_CHARS ? null : title
}

/** 章节请求的测试注入点（与 `requestStudyJson` 的 `options` 同一份）。 */
export type ChapterRequestOptions = Pick<StudyRequestOptions, 'timeoutMs' | 'request'>

/** 读当前章节（`GET .../chapter`，回 `{gradeLevel, chapterTitle}`；失败回可读中文）。 */
export async function fetchChapterState(
  studentId: string,
  options: ChapterRequestOptions = {}
): Promise<StudyResult> {
  return await requestStudyJson(chapterPath(studentId), options)
}

/**
 * 设定 / 清除当前章节（`PUT .../chapter`，body `{chapterTitle}`；空串 = 清除）。
 *
 * ★ 走 `PUT` 而不是 `POST`：这是**幂等的覆盖写**（同一章重复选两次结果一样），
 *   而且它的语义就是「把这个学生的这一列改成这个值」。
 */
export async function saveChapterState(
  studentId: string,
  title: string,
  options: ChapterRequestOptions = {}
): Promise<StudyResult> {
  return await requestStudyJson(chapterPath(studentId), {
    ...options,
    method: 'PUT',
    body: { chapterTitle: title }
  })
}
