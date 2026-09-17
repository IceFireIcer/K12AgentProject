import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import './styles/base.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

/**
 * ⚠️ 组件**按需引入**（见 vite.config.ts 的 ElementPlusResolver），所以这里不动手：
 *   - **不做** `app.use(ElementPlus)`；
 *   - **不引入** `element-plus/dist/index.css`。
 * 两者都会把整包拉进主 chunk（实测 1MB+ → gzip 342KB）。中文语言包在 App.vue
 * 用 `<el-config-provider :locale="zhCn">` 提供；主题色覆盖写在 styles/base.css。
 */
app.mount('#app')
