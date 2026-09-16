import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/base.css'
import { installCodeExecutionBridge } from './sandbox/pyodide-runner'

// ★★ 票 18 的硬约束：学生代码**绝不在主进程执行**。
//    这条桥把主进程下发的执行请求接到渲染进程的 Pyodide Worker 上，结果再回传。
//    在缺少该能力的环境（无 preload / 单测）里它静默跳过 —— 卡片自己的「运行」按钮
//    不依赖它，所以缺它只是少一种驱动方式，不是故障。
installCodeExecutionBridge(window.api)

// Pinia：对话（`stores/chat.ts`）与 sidecar 状态（`stores/sidecar.ts`）两个 store。
createApp(App).use(createPinia()).mount('#app')
