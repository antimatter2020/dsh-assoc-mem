# dsh-assoc-mem

给 AI 装一副**像动物那样的联想记忆**。

人和动物记住事物，靠的是神经连接被反复激活而增强、长期不激活而消退。这个插件把这套机制搬到词与词的关系上：两个概念反复一起出现，它们之间的关联就越来越强；久不同时出现，就慢慢淡忘。

整个过程不打扰对话：记忆在后台读写，模型看到的只是回答问题时顺带浮现的相关联想。

---

## 它解决什么问题

上下文窗口会满，对话会断，但人对世界的记忆不会因为聊天结束就清空。现有的记忆方案大多靠向量检索——把所有内容压成语义向量、按相似度捞回来。这有个根本问题：**它记不住「这两个东西之间有联系」这件事本身**。

「牛顿」和「苹果」在语义空间里的距离，和对「苹果」这个词的相似度是两回事。真正被记住的，是它们**一起被想过**这件事。

本项目只做一件事：记共现，并让它随时间淡去。

---

## 机制

### 建边

一段输入里出现的概念，两两相连。这是 Hebb 规则最直接的形式——同时被激活的两个单元之间，连接增强。

### 强化与衰减

每个片段都执行三件事：

1. **全图衰减**：所有已有边按固定比例减弱
2. **命中加强**：两端都出现在本片段里的旧边，额外加强
3. **新边建立**：本片段内新出现的词对，以基础权重建立

「命中」是**边级**的，不是节点级：一条边只有两个端点同时在场才算命中。某个概念单独出现，并不意味着以它为中心的所有边都命中——缺席那一端的边照样衰减。

### 重要性

重要的事记得更久。片段带一个 0–3 的重要性档位，档位不改变加强量，而是**把这条边的衰减率除以 3 的 s 次方**：

```
i_edge = i / pow(3, s)
```

这样「重要」体现为「活得久」，而不是「权重更高」。权重更高只会让它在排序里靠前，遗忘得一样快——那不符合记忆的实际表现。

### 检索

严格 1 跳：输入里出现某个概念，直接取它的邻居。不做多跳扩散，不做相似度计算。

---

## 生物学依据

下面列的每一条都是真实文献。**但要说清楚：这是启发式类比，不是神经机制的复现。** 本项目的公式是工程选择，文献提供的是动机和形状。

### 1. Hebb 规则：一起激活就连在一起

> When an axon of cell A is near enough to excite a cell B and repeatedly or persistently takes part in firing it, some growth process or metabolic change takes place in one or both cells such that A's efficiency, as one of the cells firing B, is increased.
>
> — Hebb, D. O. *The Organization of Behavior*. Wiley, 1949.

这是整个项目的起点。共现时 `w += η` 的加强，就是这句话的离散形式。

### 2. 长时程增强与长时程抑制

高频刺激导致突触效能持久增强（LTP），低频刺激导致持久减弱（LTD）。这是 Hebb 规则的细胞层面证据。

- Bliss, T. V. P. & Lømo, T. *Long-lasting potentiation of synaptic transmission in the dentate area of the anaesthetized rabbit following stimulation of the perforant path*. **Journal of Physiology** 232(2):331–356, 1973. [doi](https://doi.org/10.1113/jphysiol.1973.sp010273)
- Dudek, S. M. & Bear, M. F. *Homosynaptic long-term depression in area CA1 of hippocampus and effects of N-methyl-D-aspartate receptor blockade*. **PNAS** 89(10):4363–4367, 1992. [PMC48997](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC48997/)

**对应**：`w += k*x + y` 的加强，与 `w *= (1-i)` 的减弱。

### 3. 遗忘曲线

Ebbinghaus 用无意义音节测量自己的记忆保持率，发现遗忘是指数的：新学的内容在最初几小时内丢失最快，之后趋于平缓。

- Ebbinghaus, H. *Über das Gedächtnis: Untersuchungen zur experimentellen Psychologie*. Duncker & Humblot, 1885.（英译：*Memory: A Contribution to Experimental Psychology*, Teachers College, 1913）

**对应**：`w *= (1-i)`，以及惰性结算 `w * (1-i)^Δt`。

每轮相乘本身就是指数衰减，和连续时间的 `exp(-λt)` 形式一致——这是选择乘法衰减而非减法衰减的原因。

### 4. 间隔效应

分散在多次里重复，比一次性集中重复记得牢。同样总时长，间隔呈现的保持率显著高于集中呈现。

- Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T. & Rohrer, D. *Distributed practice in verbal recall tasks: A review and quantitative synthesis*. **Psychological Bulletin** 132(3):354–380, 2006. [doi](https://doi.org/10.1037/0033-2909.132.3.354)

**对应**：一条边被多次命中才积累起高权重；一次密集出现，不如多次分散出现的留存效果好。这是衰减率与加强量之比决定的。

### 5. 突触标记与捕获（为什么新内容也会被记住）

弱的刺激单独施加，只能维持短时程可塑性；但如果附近同时出现强刺激，弱突触会被打标记并捕获可塑性相关蛋白，转为长时程。

- Frey, U. & Morris, R. G. M. *Synaptic tagging and long-term potentiation*. **Nature** 385:533–536, 1997. [doi](https://doi.org/10.1038/385533a0)

**对应**：命中数 `h` 参与调制。一个片段里如果有大量已熟悉的概念（`h` 大），这段话里新出现的无关组合，出生权重也会跟着提高——`k = (h+1)^α`。

**必须说清楚**：文献里的标记是**局部、输入特异**的，且有时间窗（约 1–2 小时）。本项目把它简化为「同一片段内全部生效」，这**超出了文献描述的范围**，是工程简化。

### 6. 唤起对记忆巩固的调制

情绪唤起状态下，杏仁核释放应激激素，**调制**（而非决定）海马依赖的记忆巩固过程。唤起度高时，同样的经历记得更牢。

- McGaugh, J. L. *The amygdala modulates the consolidation of memories of emotionally arousing experiences*. **Annual Review of Neuroscience** 27:1–28, 2004. [doi](https://doi.org/10.1146/annurev.neuro.27.070203.144157)
- Cahill, L. & McGaugh, J. L. *A novel demonstration of enhanced memory associated with emotional arousal*. **Consciousness and Cognition** 4(4):410–421, 1995. [PubMed](https://pubmed.ncbi.nlm.nih.gov/8750416/)

**对应**：片段的 0–3 档重要性，乘以衰减率的分母。

**必须说清楚**：这里的 `g_s = 3^s` 是经验取值，没有任何文献给出「闲聊 : 普通 : 重要 : 突发 = 0.33 : 1 : 3 : 9」这样的映射。文献支持的是「唤起调制巩固强度」这个定性方向。

反向证据也存在：唤起会**损害**外周细节的记忆（Easterbrook 线索利用假说、arousal-biased competition）。本项目只取了有利的那一半。

### 7. 关于闪光灯记忆的更正

早期讨论中曾用 Brown & Kulik (1977) 的闪光灯记忆支持「突发事件时周围无关细节也被牢牢记住」。**这个引用是错的。**

- Brown, R. & Kulik, J. *Flashbulb memories*. **Cognition** 5(1):73–99, 1977.
- **反证**：Talarico, J. M. & Rubin, D. C. *Confidence, not consistency, characterizes flashbulb memories*. **Psychological Science** 14(5):455–461, 2003. [PDF](https://dukespace.lib.duke.edu/server/api/core/bitstreams/db6afb03-2804-4eab-a559-8e75dd2c03ee/content)

Talarico & Rubin 对 9·11 事件做了 1 周 / 6 周 / 32 周追踪，结论是：闪光灯记忆与普通自传体记忆在**准确率上没有差异**，差异只在**信心和生动性**。文献标题写的就是 Confidence, not consistency。

所以本项目**不引用**闪光灯记忆作为依据。

### 8. 与 HeLa-Mem 的关系

最接近的先行工作是 HeLa-Mem，同样用 Hebbian 动力学维护记忆图：

- Zhu, J. et al. *HeLa-Mem: Hebbian Learning and Associative Memory for LLM Agents*. **ACL 2026** Long Papers, pp. 13757–13769. [arXiv:2604.16839](https://arxiv.org/abs/2604.16839) | [code](https://github.com/ReinerBRO/HeLa-Mem)

它的更新式是：

```
w_ij^(t+1) = (1-λ)·w_ij^(t) + η·I(v_i, v_j ∈ K_t)
```

其中 `K_t` 是**当前检索出来的记忆集合**——**读时强化**。

**本项目是写时强化**：`K_t` 是当前输入片段里出现的概念。这是根本性差异：

- HeLa-Mem 的检索集合被外部查询过滤过，天然稀疏且相关，等于自带「有用才检索」的隐式监督
- 本项目的写入集合是任意片段内的全部词对，噪声更高，没有成功信号

代价是本项目精度上限更低（词共现本身有噪声，一词多义、偶然同现都解不了），收益是不需要检索这个环节，写入即记忆。

---

## 参数

| 参数 | 默认 | 含义 |
|---|---|---|
| `i` | 0.005 | 衰减率。**唯一真正敏感的旋钮** |
| `x` | 0.03 | 基础加强量 |
| `y` | 0.06 | 命中奖励 |
| `w0` | 0.05 | 新边出生权重 |
| `thr` | 0.05 | 边存活与召回阈值 |
| `wmax` | 0.9 | 权重上限 |
| `gBase` | 3 | 重要性增益底数，`i_edge = i / 3^s` |

参数由仿真网格搜索得到，不是凭感觉定的。扫描结论：`i` 从 0.005 到 0.03，可召回边覆盖率从 69% 掉到 20%；其余参数在同一量级内变化对结果影响小于 10%。

---

## 分词

**零 LLM**。用 jieba 词典做词性判定，只收名词类（`n` / `nr` / `ns` / `nt` / `nz` / `nrt`）。

### 词典来源与改动

`data/jieba_dict.txt` **不是原版**，是从 [jieba](https://github.com/fxsjy/jieba) 的 `dict.txt`（349,045 条，MIT 协议）裁剪而来。

原版每行格式为 `词语 词频 词性`。裁剪规则如下，与 `lib/tokenizer.js` 里的 `accepts()` 完全一致：

| 规则 | 丢弃数 | 说明 |
|---|---|---|
| 单字词 | 11,580 | 中文单字极少是独立概念，保留只会切出碎片 |
| 含虚词字 | 29,179 | 词里出现「的、了、是、不、我、这」等字的，一律不收 |
| 非名词词性 | 93,249 | 只留 `n` / `nr` / `ns` / `nt` / `nz` / `nrt` / `nrfg` / `ng` |
| **保留** | **215,038** | 输出 3.15 MB |

未做「超常见度」过滤——该阈值为 100,000，几乎没有词条触及。

**为什么要裁剪**：原版包含全部词性，加载后仍需运行时过滤；裁剪后体积从 5.07 MB 降到 3.15 MB，加载更快，且文件本身就是「可用概念集合」，一目了然。

**原版备份**保留在 `data/jieba_dict_raw.txt`，可用于重新生成或对照。

几个必要的处理：

- **允许重叠切分**：长词和它内部的短词并存，因为它们可能是不同概念
- **重叠或包含的词对不建边**：两个词位置重叠，不该说它们共现
- **跨边界剔除**：`9个子女` 里 `个` 加 `子` 不能拼成 `个子`
- **中文语料里的外文词直接当概念**：`TensorFlow`、`GPT-4` 不切分
- **非中文内容整段跳过**：防止英文单词污染记忆库

---

## 名词解释

两种模式：

| 模式 | 成本 | 说明 |
|---|---|---|
| 上下文截取（默认） | 零 | 取该词首次出现处前后 20 token 的原文 |
| 模型生成 | 约 60–90 token / 词 | 让模型写一句话解释 |

模型生成模式下，插件在系统提示里加一条指令，要求回答末尾附「补充解释：」段落。**这段不会被抹除**——用户看得见，写得不对可以手改。标「非名词」的条目会被自动屏蔽出记忆库。

---


## 边解释（两词之间的关系）

节点有解释，边也可以有。一条边记录的是「这两个词为什么连在一起」。

| 模式 | 成本 | 说明 |
|---|---|---|
| 上下文截取（默认） | 零 | 两词在 40 字符内，存它们之间的原文；超出则不记录 |
| 模型生成 | 消耗 token | 让模型描述这两个词的关系 |
| 关闭 | 零 | 完全不记录 |

注入时，只取**本轮命中的边里两词距离最近的 6 条**，避免撑爆上下文：

```
【关系】
芭蕉—香蕉：香蕉和芭蕉是近亲
```

这和名词解释是两个独立开关：可以只要名词解释、只要边解释、或两者都要。

## 界面

输入框左边的「记忆」胶囊，点开是三栏：

- **概念列表**：搜索、按全部 / 手动 / 孤立 / 待解释筛选
- **概念详情**：追加解释（一词多义不覆盖）、屏蔽假词、删除、合并
- **参数与统计**：实时调参、记忆文件管理、警告提示

---

## 记忆文件

一个文件就是一份完整记忆（概念、边、屏蔽词、自定义词全在里面），可以直接拷给别人。界面上可以新建、切换、删除。跨对话记忆用同一个文件；仅对话内记忆用完就删。

---

## 已知局限

- **一词多义**：靠追加解释缓解，不是根治。同一个词的不同义项共用一套边。
- **偶然同现**：两个词恰好出现在同一段里就会被连边，没有语义校验。
- **否定语境**：「这不是牛顿的苹果」照样会建边。
- **精度上限**：词共现的噪声决定了召回精度天花板大约 0.6，调参救不回来。
- **重要性档位**：`g_s` 的四档取值是经验设定，没有文献依据。

---

## 安装

```bash
dsh plugin --profile desktop add "link:<本目录绝对路径>"
```

装完重启 DSH。首次加载会读取裁剪后的 215,038 条名词词典，约 1 秒。

---

## 许可

[MIT](LICENSE) © 2026 antimatter2020

分词词典裁剪自 [jieba](https://github.com/fxsjy/jieba)（MIT 协议）。