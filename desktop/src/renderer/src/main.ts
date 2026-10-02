import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/base.css'
import { installCodeExecutionBridge } from './sandbox/pyodide-runner'
// ★ 减少动效的三档偏好（报告 §3.3）：模块加载即把用户模式写到 `<html>` 上，
//   CSS 在**第一帧**就知道该不该压掉动效（不等任何组件挂载 / 不等设置页被打开）。
import './stores/reducedMotion'
// ★ 当前学段 → `<html data-grade>`：18 组主题配色与四张学段壁纸都挂在这个属性上。
//   装在这里（而不是某个组件里）是因为它必须在**首帧之前**定下来，否则会看到一次闪跳。
import { installGradeTheme } from './stores/gradeTheme'
import { observePerformance } from './perf'

// 性能埋点（报告 §5.2 阶段 14.3）：FCP / LCP / FID 三个数挂到 window.__k12Perf，
// 真机探针 `npm run ux:perf` 读它。坏掉不影响任何功能（见 perf.ts 的说明）。
observePerformance()

// ★★ 票 18 的硬约束：学生代码**绝不在主进程执行**。
//    这条桥把主进程下发的执行请求接到渲染进程的 Pyodide Worker 上，结果再回传。
//    在缺少该能力的环境（无 preload / 单测）里它静默跳过 —— 卡片自己的「运行」按钮
//    不依赖它，所以缺它只是少一种驱动方式，不是故障。
installCodeExecutionBridge(window.api)

// Pinia：对话（`stores/chat.ts`）与 sidecar 状态（`stores/sidecar.ts`）两个 store。
const app = createApp(App).use(createPinia())
// ★ 必须在 mount **之前**装：`installGradeTheme` 的 watch 是 `immediate` 的，
//   它会立刻写一次 `data-grade` —— 这样第一帧画出来的就是对的学段配色与壁纸。
installGradeTheme()
app.mount('#app')
