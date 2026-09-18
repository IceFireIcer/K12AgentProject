<script setup lang="ts">
/**
 * 404：唯一渲染在 AppShell 之外的视图（走丢的时候不该再套一层导航）。
 * 文案按 frontend-design 的口径写：空态是「下一步的引导」，不是情绪表达。
 */
import { useRouter } from 'vue-router'
import { Compass } from 'lucide-vue-next'

const router = useRouter()
</script>

<template>
  <div class="nf">
    <div class="nf__box">
      <div class="nf__mark"><Compass :size="24" /></div>
      <h1 class="nf__title">这个地址没有对应页面</h1>
      <p class="nf__desc">
        可能是链接拼错了，或者这个界面还没做出来（本目录是界面原型，部分画布帧有意未实现）。
      </p>
      <el-button type="primary" class="nf__btn" @click="router.push({ name: 'chat' })">
        回到对话课堂
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.nf {
  position: relative;
  width: 100%;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--k12-surface);
}
.nf__box {
  background: var(--k12-surface);
  border: 1px solid var(--k12-border);
  box-shadow: var(--k12-shadow-card);
  border-radius: var(--k12-r-card);

  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 48px;
  text-align: center;
}
.nf__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: var(--k12-r-card);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
.nf__title {
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  line-height: var(--k12-lh-tight);
  color: var(--k12-fg);
}
.nf__desc {
  font-size: var(--k12-fs-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
  max-width: 46ch;
}
.nf__btn {
  margin-top: 4px;
}
</style>
