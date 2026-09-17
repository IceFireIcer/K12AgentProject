<script setup lang="ts">
import { useRouter } from 'vue-router'
import { Compass } from 'lucide-vue-next'

const router = useRouter()
</script>

<template>
  <div class="nf">
    <div class="nf__box">
      <Compass :size="26" class="nf__ico" />
      <h1 class="nf__title">这个页面不存在</h1>
      <p class="nf__desc">原型里尚未实现的界面，或链接已失效。</p>
      <button type="button" class="nf__btn" @click="router.push('/app/home')">回到学习台</button>
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
  background: var(--k12-bg);
}
.nf__box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 32px 40px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  border: 1px solid var(--k12-glass-border);
}
.nf__ico {
  color: var(--k12-accent);
}
.nf__title {
  font-size: var(--k12-fs-xl);
  font-weight: 650;
  color: var(--k12-fg);
}
.nf__desc {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.nf__btn {
  margin-top: 6px;
  padding: 9px 16px;
  border: none;
  border-radius: var(--k12-r-lg);
  background: var(--k12-accent);
  color: #fff;
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  cursor: pointer;
}
</style>
