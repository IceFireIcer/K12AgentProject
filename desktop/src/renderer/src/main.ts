import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

// Pinia 先装上但暂无 store：对话/设置/画像的 store 归票 05 及以后
createApp(App).use(createPinia()).mount('#app')
