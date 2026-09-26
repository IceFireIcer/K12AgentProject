/**
 * 导出文件名的**共享拼装件**（渲染进程一侧）。
 *
 * 这一组函数只解决两件事，两处导出（学习报告 / 错题本 / 依赖边）共用：
 *
 *   ① **本地时区的 `YYYYMMDD`**：不能用 `toISOString()` —— 它是 UTC，
 *      东八区下午四点之后会写成「昨天」，学生看到文件名与今天不符。
 *   ② **文件名里不出现内部 id**（P2-2）：`student_001` 是内部主键，
 *      学生面（含他要交给老师的文件名）不该出现它 —— 这是 D-063 双视角纪律的一部分。
 *      姓名改用品牌名 + 对象 + 日期，与依赖边导出的既有口径一致
 *      （`智团团-初中学习地图-20260926.csv`）。
 *
 * ⚠️ 主进程的 `study/export-naming.ts` 是**另一件事**（后缀白名单 + 路径清理，
 *    在 `file:export` 通道里兜底），两者不要合并：那一个跑在 Node 侧、进不了渲染进程。
 */

/** 本地时区的 `YYYYMMDD`（见文件头①）。 */
export function todayStamp(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}${month}${day}`
}
