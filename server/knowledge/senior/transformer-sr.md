---
kp_id: transformer-sr
grade_level: senior
chapter_title: 第3章 核心技术分支
knowledge_point: Transformer 架构
content_type: principle
summary: 一种能一次读完整个句子、并判断哪些词最重要的深度学习架构，是当前大语言模型的底层骨架。
---

## 机制、边界与关联

Transformer 是 2017 年论文《Attention Is All You Need》提出的序列建模架构，其核心是完全以注意力机制取代循环与卷积结构。

自注意力把输入映射为查询（Q）、键（K）、值（V）三组向量，以缩放点积计算相似度并加权聚合：$\mathrm{Attention}(Q,K,V)=\mathrm{softmax}(QK^{T}/\sqrt{d_{k}})V$。多头注意力让模型在不同子空间并行捕捉句法、语义等多类关系；前馈网络、残差连接与层归一化共同构成每个编码器／解码器层。由于注意力本身对顺序不敏感，须叠加位置编码（正弦式或可学习）注入次序信息。

相较循环网络，Transformer 的关键优势是并行化与长程依赖建模，使千亿参数级模型的训练成为可能；它也是大语言模型（4.1.1）的底座。

局限：标准自注意力对序列长度呈二次复杂度，长文本代价高昂，上下文窗口因此受限（参见 3.2.5）；它依赖大规模数据与算力，且架构本身并不保证输出正确（参见 6.1）。
