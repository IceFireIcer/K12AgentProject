import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/base.css'

// Pinia：对话（`stores/chat.ts`）与 sidecar 状态（`stores/sidecar.ts`）两个 store。
// 会话/画像/进度的 store 归后续票。
createApp(App).use(createPinia()).mount('#app')
