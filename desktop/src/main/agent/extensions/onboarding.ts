/**
 * 引导 Extension（票 25 主进程半）。
 *
 * ★★ **它故意是一个空工厂** —— 没有 Tool、不订阅任何 Pi 事件。两个理由，都不是偷懒：
 *
 * 1. **能力不由 Pi 事件驱动**。引导流程的驱动方是 **IPC**（渲染层挂载时读
 *    onboarding:state，学生答一问就发一次 onboarding:answer）与
 *    **grade.ts 的 systemPromptFor()**（引导模式下换整份 prompt）。
 *    这与 grade.ts 返工后的结论同一条：在本项目的嵌入形态下，
 *    input / before_agent_start 在无 Key 路径上不可靠，观察与覆盖都改成**显式调用**。
 *
 * 2. **冷启动五问不该有工具**。执行报告 §1.3 明文：引导模式下工具必须关掉 ——
 *    「检索 / 动画 / 出题都不该出现在学生前 30 秒」。一个不注册 Tool 的扩展，
 *    让这条纪律成为**结构上的事实**，而不是靠 prompt 里一句「不要调工具」。
 *
 * ★ 保留这个文件与工厂（而不是干脆不写）的理由：extensions/index.ts 的注册器按
 *   「是不是一个函数」判定扩展是否就位，report.missing 会点名缺谁 —— 留一个空工厂，
 *   「引导这条能力在不在」在启动日志里就是可判定的，不靠人去读代码。
 *
 * ⚠️ 它**不在** AGENT_EXTENSION_SPECS 那六个业务扩展里（那份清单是票 08 冻结的，
 *   且被 agent-trace 的守卫逐字断言）。它由 runtime.ts 经 extra 注入 ——
 *   见 extensions/index.ts 的 ONBOARDING_EXTRA_EXTENSION。
 */

import type { AgentExtensionApi } from './index.ts'

/** 与本仓其它扩展同形：一个「接收 Pi API 面」的函数（注册器按「是不是函数」判定就位）。 */
export interface OnboardingExtension {
  (pi: AgentExtensionApi): void
}

/**
 * 工厂本体。**刻意什么都不做**（理由见文件头）——
 * 引导的流程状态住在 agent/onboarding/service.ts，prompt 分支由 C 在 grade.ts 里加。
 */
const extension = ((_pi: AgentExtensionApi): void => {
  // 无事件订阅、无 Tool 注册（见文件头：这两件都是刻意的）。
}) as OnboardingExtension

export default extension

/** 具名导出（便于单测直接拿工厂，不必依赖默认导出的形状）。 */
export { extension as onboardingExtension }
