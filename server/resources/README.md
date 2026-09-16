随包分发的只读资源。

| 目录/文件 | 内容 | 落地票 |
| --- | --- | --- |
| `models/fastembed/` | 嵌入模型 `BAAI/bge-small-zh-v1.5`（512 维，约 90MB） | 票 10 |
| `templates/` | 动画模板（排序 / 神经网络 / 决策树 / 梯度下降 / 循环 / 变量） | 票 17 |
| `quizbank/` | 预置题库 | 票 14 |
| `sensitive-words.json` | 敏感词库 | 票 22 |

⚠️ **`models/` 永不入 git**（`.gitignore` 里的 `**/resources/models/` 负责拦住它；
注意模式必须带 `**/`，写 `resources/models/` 是锚定到仓库根的，拦不住 `server/` 下的这份）。
模型文件由 `scripts/fetch_embedding_model.py` 获取。
