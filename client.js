/**
 * dsh-assoc-mem Client 半：记忆词典的图形编辑界面。
 *
 * 挂在 conversation.input.left，与模型选择器同排。
 * 三栏布局：概念列表 / 概念详情 / 参数与统计。
 */
window.__ModuleLoader__.load({
  id: 'dsh-assoc-mem',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const BASE = '/dsh-assoc-mem'
    const HEADERS = { 'x-assoc-mem': '1', 'content-type': 'application/json' }

    const api = {
      get: (p, params) => {
        const qs = params ? '?' + new URLSearchParams(params).toString() : ''
        return fetch(BASE + p + qs, { headers: { 'x-assoc-mem': '1' } }).then((r) => r.json())
      },
      post: (p, body) =>
        fetch(BASE + p, { method: 'POST', headers: HEADERS, body: JSON.stringify(body || {}) }).then((r) => r.json()),
    }

    const CSS = `
.asm-root { display: inline-flex; align-items: center; }
.asm-pill {
  display:inline-flex; align-items:center; gap:5px; height:28px; padding:0 10px;
  border-radius:14px; border:1px solid var(--dsh-border,#e3e3e3);
  background:var(--dsh-surface,#fff); color:var(--dsh-text,#222);
  font-size:12px; cursor:pointer; user-select:none; transition:all .15s;
}
.asm-pill:hover { border-color:#4A9EFF; color:#4A9EFF; }
.asm-pill[data-on="true"] { background:#4A9EFF; border-color:#4A9EFF; color:#fff; }
.asm-dot { width:6px; height:6px; border-radius:50%; background:#bbb; }
.asm-pill[data-on="true"] .asm-dot { background:#fff; }

.asm-mask {
  position:fixed; inset:0; background:rgba(0,0,0,.38); z-index:9998;
  display:flex; align-items:center; justify-content:center;
}
.asm-panel {
  width:min(1080px,94vw); height:min(720px,88vh); background:#fbfbfd;
  border-radius:14px; box-shadow:0 24px 64px rgba(0,0,0,.28);
  display:flex; flex-direction:column; overflow:hidden;
  font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:#1c1c1e;
}
.asm-head {
  display:flex; align-items:center; gap:10px; padding:14px 18px;
  border-bottom:1px solid #e8e8ed; background:#fff;
}
.asm-title { font-size:15px; font-weight:600; letter-spacing:.2px; }
.asm-sub { font-size:12px; color:#8a8a8e; }
.asm-spacer { flex:1; }
.asm-x {
  width:28px; height:28px; border-radius:8px; border:none; background:#f1f1f3;
  color:#8a8a8e; cursor:pointer; font-size:15px; line-height:1;
}
.asm-x:hover { background:#e8e8ed; color:#1c1c1e; }

.asm-body { flex:1; display:flex; min-height:0; }
.asm-col { display:flex; flex-direction:column; min-width:0; }
.asm-col-list { width:290px; border-right:1px solid #e8e8ed; background:#fff; }
.asm-col-detail { flex:1; border-right:1px solid #e8e8ed; }
.asm-col-side { width:280px; background:#fbfbfd; overflow-y:auto; }

.asm-toolbar { padding:10px 12px; border-bottom:1px solid #f0f0f3; display:flex; gap:6px; flex-wrap:wrap; }
.asm-input {
  flex:1; min-width:0; height:28px; padding:0 9px; border:1px solid #e0e0e5;
  border-radius:7px; font-size:12px; outline:none; background:#fafafa; color:#1c1c1e;
}
.asm-input:focus { border-color:#4A9EFF; background:#fff; }
.asm-tab {
  height:24px; padding:0 9px; border-radius:6px; border:none; background:#f1f1f3;
  color:#6e6e73; font-size:11px; cursor:pointer;
}
.asm-tab[data-active="true"] { background:#4A9EFF; color:#fff; }

.asm-list { flex:1; overflow-y:auto; padding:6px; }
.asm-item {
  padding:7px 9px; border-radius:8px; cursor:pointer; margin-bottom:2px;
  display:flex; align-items:baseline; gap:7px;
}
.asm-item:hover { background:#f5f5f7; }
.asm-item[data-active="true"] { background:#e8f2ff; }
.asm-name { font-weight:500; }
.asm-deg { font-size:11px; color:#98989d; margin-left:auto; }
.asm-mark { font-size:10px; color:#4A9EFF; }

.asm-detailpad { flex:1; overflow-y:auto; padding:18px 20px; }
.asm-h2 { font-size:19px; font-weight:600; margin:0 0 4px; }
.asm-meta { font-size:12px; color:#8a8a8e; margin-bottom:16px; }
.asm-label { font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:#98989d; margin:16px 0 7px; font-weight:600; }
.asm-gloss {
  background:#fff; border:1px solid #ececf0; border-radius:9px; padding:9px 11px;
  margin-bottom:6px; display:flex; gap:8px; align-items:flex-start;
}
.asm-gloss-text { flex:1; }
.asm-gloss-time { font-size:10px; color:#b0b0b5; }
.asm-area {
  width:100%; min-height:64px; padding:9px 11px; border:1px solid #e0e0e5;
  border-radius:8px; font-size:12px; font-family:inherit; resize:vertical;
  outline:none; background:#fff; color:#1c1c1e; box-sizing:border-box;
}
.asm-area:focus { border-color:#4A9EFF; }
.asm-row { display:flex; gap:7px; margin-top:8px; flex-wrap:wrap; }
.asm-btn {
  height:28px; padding:0 13px; border-radius:7px; border:1px solid #e0e0e5;
  background:#fff; color:#1c1c1e; font-size:12px; cursor:pointer; transition:all .12s;
}
.asm-btn:hover { border-color:#4A9EFF; color:#4A9EFF; }
.asm-btn[data-primary="true"] { background:#4A9EFF; border-color:#4A9EFF; color:#fff; }
.asm-btn[data-primary="true"]:hover { background:#3891f0; }
.asm-btn[data-danger="true"] { border-color:#ffd9d9; color:#e5484d; }
.asm-btn[data-danger="true"]:hover { background:#fff0f0; }
.asm-btn:disabled { opacity:.45; cursor:default; }

.asm-nb { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid #f4f4f6; }
.asm-nb-name { font-weight:500; }
.asm-nb-gloss { color:#8a8a8e; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.asm-bar { height:4px; width:52px; background:#ececf0; border-radius:2px; overflow:hidden; flex:none; }
.asm-bar-in { height:100%; background:#4A9EFF; }

.asm-side-sec { padding:14px 16px; border-bottom:1px solid #ececf0; }
.asm-stat { display:flex; justify-content:space-between; padding:3px 0; font-size:12px; }
.asm-stat span:last-child { font-weight:600; font-variant-numeric:tabular-nums; }
.asm-param { display:flex; align-items:center; gap:8px; margin-bottom:7px; }
.asm-param label { width:64px; font-size:11px; color:#6e6e73; }
.asm-param input {
  flex:1; min-width:0; height:24px; padding:0 7px; border:1px solid #e0e0e5;
  border-radius:6px; font-size:11px; outline:none; font-variant-numeric:tabular-nums;
}
.asm-mem {
  background:#f4f6fa; border:1px solid #e2e6ee; border-radius:9px;
  padding:9px 10px; font-size:11px; line-height:1.6;
}
.asm-mempath {
  font-family:ui-monospace,Consolas,monospace; font-size:10.5px; color:#5b6474;
  word-break:break-all; background:#fff; border:1px solid #e6e9f0;
  border-radius:6px; padding:5px 7px; margin:5px 0 7px; user-select:all;
}
.asm-inline {
  display:flex; gap:5px; margin-top:6px;
}
.asm-inline input {
  flex:1; min-width:0; height:24px; padding:0 7px; border:1px solid #d6dce8;
  border-radius:6px; font-size:11px; outline:none; background:#fff;
}
.asm-inline input:focus { border-color:#4A9EFF; }
.asm-inline button {
  height:24px; padding:0 9px; border-radius:6px; border:1px solid #d6dce8;
  background:#fff; font-size:11px; cursor:pointer;
}
.asm-inline button[data-primary="true"] { background:#4A9EFF; border-color:#4A9EFF; color:#fff; }
.asm-memlist { max-height:120px; overflow-y:auto; margin-top:6px; }
.asm-memitem {
  display:flex; align-items:center; gap:6px; padding:4px 6px;
  border-radius:6px; cursor:pointer; font-size:11px;
}
.asm-memitem:hover { background:#e9eef7; }
.asm-memitem[data-active="true"] { background:#dbe8fb; font-weight:600; }
.asm-memname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.asm-memdel { color:#e5484d; font-size:10px; padding:0 4px; border:none; background:none; cursor:pointer; }
.asm-mode { display:flex; gap:6px; margin-bottom:8px; }
.asm-mode button {
  flex:1; padding:8px 9px; border-radius:8px; border:1px solid #e0e0e5;
  background:#fff; cursor:pointer; text-align:left; font-size:11px; line-height:1.5;
  color:#1c1c1e; transition:all .12s;
}
.asm-mode button:hover { border-color:#4A9EFF; }
.asm-mode button[data-active="true"] { border-color:#4A9EFF; background:#eef5ff; }
.asm-mode b { display:block; font-size:12px; margin-bottom:2px; }
.asm-mode span { color:#8a8a8e; }
.asm-cost {
  background:#fff4e6; border:1px solid #ffd7a8; color:#9a5b00;
  border-radius:7px; padding:7px 9px; font-size:11px; margin-top:6px; line-height:1.55;
}
.asm-warn {
  background:#fff8e6; border:1px solid #ffe0a3; color:#8a6d1f;
  border-radius:8px; padding:8px 10px; font-size:11px; margin-bottom:7px;
}
.asm-empty { color:#a8a8ad; text-align:center; padding:40px 20px; font-size:12px; }
.asm-toast {
  position:absolute; left:50%; bottom:18px; transform:translateX(-50%);
  background:#1c1c1e; color:#fff; padding:7px 15px; border-radius:8px;
  font-size:12px; opacity:.94; pointer-events:none;
}
`

    function useToast() {
      const [msg, setMsg] = useState('')
      useEffect(() => {
        if (!msg) return undefined
        const t = setTimeout(() => setMsg(''), 2200)
        return () => clearTimeout(t)
      }, [msg])
      return [msg, setMsg]
    }

    function List({ items, active, onPick }) {
      if (!items.length) return h('div', { className: 'asm-empty' }, '没有匹配的概念')
      return h('div', { className: 'asm-list' },
        items.map((it) => h('div', {
          key: it.name,
          className: 'asm-item',
          'data-active': active === it.name ? 'true' : 'false',
          onClick: () => onPick(it.name),
        },
          h('span', { className: 'asm-name' }, it.name),
          it.manual ? h('span', { className: 'asm-mark' }, '手动') : null,
          h('span', { className: 'asm-deg' }, it.degree),
        )),
      )
    }

    function Detail({ data, onGloss, onReject, busy }) {
      const [text, setText] = useState('')
      if (!data) return h('div', { className: 'asm-empty' }, '从左侧选一个概念')
      // 详情接口可能返回 {error}（概念刚被屏蔽、或记忆已切换），
      // 这里必须先判空，否则 .map 抛异常会让整个面板掉线。
      const neighbours = Array.isArray(data.neighbours) ? data.neighbours : []
      const glossList = Array.isArray(data.gloss) ? data.gloss : []
      const maxW = Math.max(0.001, ...neighbours.map((n) => n.w))
      return h('div', { className: 'asm-detailpad' },
        h('div', { className: 'asm-h2' }, data.name || ''),
        h('div', { className: 'asm-meta' },
          neighbours.length + ' 条关联' + (data.manual ? ' · 手动添加' : '')),
        h('div', { className: 'asm-label' }, '解释（一词多义时可追加多条）'),
        glossList.length
          ? glossList.map((g, i) => h('div', { key: i, className: 'asm-gloss' },
              h('span', { className: 'asm-gloss-text' }, g.text),
              h('span', { className: 'asm-gloss-time' }, new Date(g.t).toLocaleDateString('zh-CN')),
            ))
          : h('div', { className: 'asm-meta' }, '还没有解释'),
        h('textarea', {
          className: 'asm-area',
          placeholder: '写一句解释；该词有新义项时再写一条追加，旧条目不会被覆盖',
          value: text,
          onChange: (e) => setText(e.target.value),
        }),
        h('div', { className: 'asm-row' },
          h('button', {
            className: 'asm-btn',
            'data-primary': 'true',
            disabled: busy || !text.trim(),
            onClick: () => { onGloss(data.name, text.trim()); setText('') },
          }, '追加解释'),
          h('button', {
            className: 'asm-btn',
            'data-danger': 'true',
            disabled: busy,
            onClick: () => onReject(data.name),
          }, '不是概念，屏蔽'),
        ),
        h('div', { className: 'asm-label' }, '关联概念（1 hop）'),
        neighbours.length
          ? neighbours.map((n) => h('div', { key: n.name, className: 'asm-nb' },
              h('span', { className: 'asm-nb-name' }, n.name),
              h('span', { className: 'asm-bar' },
                h('span', { className: 'asm-bar-in', style: { width: (n.w / maxW * 100) + '%' } })),
              // 显示这条「边」的关系解释，而不是邻居词的词典释义
              h('span', { className: 'asm-nb-gloss' }, n.edgeGloss || ''),
            ))
          : h('div', { className: 'asm-meta' }, '暂无过线关联'),
      )
    }

    function Side({ state, onParam, onToggle, onGlossMode, onGlossClear, onEdgeMode, onMemOpen, onMemNew, onMemDel, onExplainModel, memories, busy }) {
      const [newName, setNewName] = useState('')
      const [pv, setPv] = useState('')
      const [pm, setPm] = useState('')
      const [pmInit, setPmInit] = useState(false)
      useEffect(() => {
        if (!state || pmInit) return
        setPv(state.explainProvider || '')
        setPm(state.explainModel || '')
        setPmInit(true)
      }, [state, pmInit])
      if (!state) return h('div', { className: 'asm-empty' }, '读取中…')
      const s = state.stats || {}
      const p = state.params || {}
      const fields = [
        ['i', '衰减率'], ['x', '基础加强'], ['y', '命中奖励'],
        ['w0', '新边初值'], ['thr', '召回阈值'], ['wmax', '上限'],
      ]
      const mem = state.memory || {}
      const list = (memories && memories.items) || []
      const submitNew = () => {
        const n = newName.trim()
        if (!n) return
        onMemNew(n)
        setNewName('')
      }
      return h('div', null,
        h('div', { className: 'asm-side-sec' },
          h('div', { className: 'asm-label' }, '记忆文件'),
          h('div', { className: 'asm-mem' },
            h('div', null, mem.note || '存放在工作区'),
            h('div', { className: 'asm-mempath', title: '点击可选中复制' }, mem.path || ''),
            h('div', { className: 'asm-inline' },
              h('input', {
                placeholder: '新记忆名字',
                value: newName,
                disabled: busy,
                onChange: (e) => setNewName(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') submitNew() },
              }),
              h('button', {
                'data-primary': 'true',
                disabled: busy || !newName.trim(),
                onClick: submitNew,
              }, '新建'),
            ),
            list.length
              ? h('div', { className: 'asm-memlist' },
                  list.map((m) => h('div', {
                    key: m.path, className: 'asm-memitem',
                    'data-active': m.path === mem.path ? 'true' : 'false',
                    onClick: () => { if (m.path !== mem.path) onMemOpen(m.path) },
                    title: m.path,
                  },
                    h('span', { className: 'asm-memname' }, m.name.replace(/\\.mem\\.json$/, '')),
                    m.path === mem.path ? h('span', { style: { fontSize: '10px', color: '#4A9EFF' } }, '使用中') : null,
                    m.path === mem.path ? null : h('button', {
                      className: 'asm-memdel',
                      onClick: (e) => { e.stopPropagation(); onMemDel(m.path) },
                    }, '删'),
                  )),
                )
              : h('div', { className: 'asm-meta', style: { marginTop: '6px' } }, '还没有其他记忆文件'),
          ),
        ),
        h('div', { className: 'asm-side-sec' },
          h('div', { className: 'asm-stat' }, h('span', null, '概念'), h('span', null, s.nodes || 0)),
          h('div', { className: 'asm-stat' }, h('span', null, '边'), h('span', null, s.edges || 0)),
          h('div', { className: 'asm-stat' }, h('span', null, '过线边'), h('span', null, s.alive || 0)),
          h('div', { className: 'asm-stat' }, h('span', null, '待写解释'), h('span', null, s.pendingGloss || 0)),
          (s.pendingGloss || 0) > 0
            ? h('button', {
                className: 'asm-btn',
                style: { width: '100%', marginTop: '7px', fontSize: '11px' },
                disabled: busy,
                onClick: onGlossClear,
              }, '清空待解释队列')
            : null,
          h('div', { className: 'asm-stat' }, h('span', null, '轮次'), h('span', null, s.round || 0)),
        ),
        state.warnings && state.warnings.length
          ? h('div', { className: 'asm-side-sec' },
              state.warnings.map((w, i) => h('div', { key: i, className: 'asm-warn' }, w)))
          : null,
        h('div', { className: 'asm-side-sec' },
          h('div', { className: 'asm-label' }, '解释请求使用的模型'),
          h('div', { className: 'asm-meta', style: { marginBottom: '6px' } },
            '插件自己向 LLM 请求解释时用哪个模型。留空则尝试用当前默认模型。'),
          h('div', { className: 'asm-inline' },
            h('input', {
              placeholder: 'provider，如 deepseek',
              value: pv,
              disabled: busy,
              onChange: (e) => setPv(e.target.value),
            }),
          ),
          h('div', { className: 'asm-inline' },
            h('input', {
              placeholder: 'model，如 deepseek-chat',
              value: pm,
              disabled: busy,
              onChange: (e) => setPm(e.target.value),
            }),
          ),
          h('div', { className: 'asm-row' },
            h('button', {
              className: 'asm-btn',
              'data-primary': 'true',
              disabled: busy,
              onClick: () => onExplainModel(pv.trim(), pm.trim()),
            }, '保存模型'),
          ),
        ),
        h('div', { className: 'asm-side-sec' },
          h('div', { className: 'asm-label' }, '名词解释来源'),
          h('div', { className: 'asm-mode' },
            h('button', {
              'data-active': (state.glossMode || 'context') === 'context' ? 'true' : 'false',
              onClick: () => onGlossMode('context', state.glossContextTokens || 30),
            },
              h('b', null, '上下文截取（默认·零消耗）'),
              h('span', null, '取首次出现前后 ' + (state.glossContextTokens || 30) + ' token')),
            h('button', {
              'data-active': state.glossMode === 'llm' ? 'true' : 'false',
              onClick: () => onGlossMode('llm', state.glossContextTokens || 30),
            },
              h('b', null, '模型生成'),
              h('span', null, '一句话解释，更准确')),
          ),
          state.glossMode === 'llm'
            ? h('div', { className: 'asm-cost' },
                '模型生成模式：插件自己在后台向 LLM 请求解释，名词和边一次问完。主对话模型不需要在回复里写任何段落。')
            : null,
        ),
        h('div', { className: 'asm-side-sec' },
          h('div', { className: 'asm-label' }, '边解释（两词关系）'),
          h('div', { className: 'asm-mode' },
            h('button', {
              'data-active': (state.edgeMode || 'context') === 'context' ? 'true' : 'false',
              onClick: () => onEdgeMode('context'),
            },
              h('b', null, '上下文截取'),
              h('span', null, '20 token 内的原文')),
            h('button', {
              'data-active': state.edgeMode === 'llm' ? 'true' : 'false',
              onClick: () => onEdgeMode('llm'),
            },
              h('b', null, '模型生成'),
              h('span', null, '让模型描述关系')),
          ),
          state.edgeMode === 'llm'
            ? h('div', { className: 'asm-cost' },
                '该模式每轮会额外消耗 token 描述新边关系。')
            : null,
        ),
        h('div', { className: 'asm-side-sec' },
          h('div', { className: 'asm-label' }, '参数'),
          fields.map(([k, label]) => h('div', { key: k, className: 'asm-param' },
            h('label', null, label),
            h('input', {
              type: 'number', step: '0.001', defaultValue: p[k],
              onBlur: (e) => {
                const v = Number(e.target.value)
                if (Number.isFinite(v) && v !== p[k]) onParam(k, v)
              },
            }),
          )),
        ),
      )
    }

    function Panel({ onClose }) {
      const [state, setState] = useState(null)
      const [items, setItems] = useState([])
      const [active, setActive] = useState('')
      const [detail, setDetail] = useState(null)
      const [q, setQ] = useState('')
      const [filter, setFilter] = useState('all')
      const [busy, setBusy] = useState(false)
      const [memories, setMemories] = useState(null)
      const [toast, setToast] = useToast()

      const loadState = useCallback(() => {
        api.get('/state').then(setState).catch(() => {})
      }, [])

      const loadMemories = useCallback(() => {
        api.get('/memories').then(setMemories).catch(() => {})
      }, [])

      const loadList = useCallback((kw, fl) => {
        api.get('/nodes', { q: kw, filter: fl }).then((r) => setItems(r.items || [])).catch(() => {})
      }, [])

      useEffect(() => { loadState(); loadList('', 'all'); loadMemories() }, [loadState, loadList, loadMemories])
      useEffect(() => {
        const t = setTimeout(() => loadList(q, filter), 220)
        return () => clearTimeout(t)
      }, [q, filter, loadList])

      const pick = (name) => {
        setActive(name)
        api.get('/node', { name })
          .then((d) => setDetail(d && !d.error ? d : null))
          .catch(() => setDetail(null))
      }

      const act = async (fn, ok) => {
        setBusy(true)
        try {
          await fn()
          if (ok) setToast(ok)
          loadState()
          loadList(q, filter)
          loadMemories()
          if (active) pick(active)
        } finally { setBusy(false) }
      }

      const filters = [['all', '全部'], ['manual', '手动'], ['orphan', '孤立'], ['pending', '待解释']]

      return h('div', { className: 'asm-mask', onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'asm-panel', style: { position: 'relative' } },
          h('div', { className: 'asm-head' },
            h('div', null,
              h('div', { className: 'asm-title' }, '联想记忆'),
              h('div', { className: 'asm-sub' }, '编辑记忆词典 · 权重只决定是否保留，过线即等价'),
            ),
            h('div', { className: 'asm-spacer' }),
            state ? h('button', {
              className: 'asm-btn',
              'data-primary': state.enabled ? 'true' : 'false',
              onClick: () => act(
                () => api.post('/toggle', { enabled: !state.enabled }).then(setState),
                state.enabled ? '已关闭' : '已开启',
              ),
            }, state.enabled ? '已开启' : '已关闭') : null,
            h('button', { className: 'asm-x', onClick: onClose }, '×'),
          ),
          h('div', { className: 'asm-body' },
            h('div', { className: 'asm-col asm-col-list' },
              h('div', { className: 'asm-toolbar' },
                h('input', {
                  className: 'asm-input', placeholder: '搜索概念…', value: q,
                  onChange: (e) => setQ(e.target.value),
                }),
                h('div', { style: { display: 'flex', gap: '4px', width: '100%', marginTop: '4px' } },
                  filters.map(([k, label]) => h('button', {
                    key: k, className: 'asm-tab',
                    'data-active': filter === k ? 'true' : 'false',
                    onClick: () => setFilter(k),
                  }, label)),
                ),
              ),
              h(List, { items, active, onPick: pick }),
            ),
            h('div', { className: 'asm-col asm-col-detail' },
              h(Detail, {
                data: detail, busy,
                onGloss: (name, text) => act(() => api.post('/gloss', { name, text }), '已追加'),
                onReject: (name) => act(
                  () => api.post('/reject', { name }).then(() => { setDetail(null); setActive('') }),
                  '已屏蔽',
                ),
              }),
            ),
            h('div', { className: 'asm-col asm-col-side' },
              h(Side, {
                state, busy, memories,
                onMemOpen: (p) => act(async () => {
                  const snap = await api.post('/memory-open', { path: p })
                  setState(snap); setDetail(null); setActive('')
                  setToast('已切换记忆')
                }),
                onMemNew: (name) => act(async () => {
                  const snap = await api.post('/memory-new', { name })
                  if (snap.error) { setToast('失败：' + snap.error); return }
                  setState(snap); setDetail(null); setActive('')
                  setToast('已新建并切换到「' + name + '」')
                }),
                onMemDel: (p) => act(async () => {
                  const r = await api.post('/memory-delete', { path: p })
                  if (r.error) { setToast('无法删除：' + r.error); return }
                  setMemories(r)
                  setToast('已删除')
                }),
                onParam: (k, v) => act(() => api.post('/params', { [k]: v }).then(setState)),
                onGlossMode: (mode, tokens) => act(() => api.post('/gloss-mode', { mode, tokens }).then(setState)),
                onEdgeMode: (mode) => act(async () => {
                  const snap = await api.post('/edge-mode', { mode })
                  setState(snap)
                  setToast(mode === 'llm' ? '边解释：模型生成' : '边解释：上下文截取')
                }),
                onExplainModel: (provider, model) => act(async () => {
                  const snap = await api.post('/explain-model', { provider, model })
                  if (snap.error) { setToast('保存失败：' + snap.error); return }
                  setState(snap)
                  setToast(provider && model ? '已设为 ' + provider + ' / ' + model : '已清空，改用默认模型')
                }),
                onGlossClear: () => act(async () => {
                  const r = await api.post('/gloss-clear', {})
                  setState(await api.get('/state'))
                  setToast('已清空 ' + (r.cleared || 0) + ' 个待解释词')
                }),
                onToggle: () => act(() => api.post('/toggle', { enabled: !state.enabled }).then(setState)),
              }),
            ),
          ),
          toast ? h('div', { className: 'asm-toast' }, toast) : null,
        ),
      )
    }

    function Pill() {
      const [open, setOpen] = useState(false)
      const [on, setOn] = useState(true)
      useEffect(() => {
        api.get('/state').then((s) => setOn(Boolean(s.enabled))).catch(() => {})
      }, [open])
      return h('span', { className: 'asm-root' },
        h('style', null, CSS),
        h('button', {
          className: 'asm-pill',
          'data-on': on ? 'true' : 'false',
          title: on ? '联想记忆：开（点击设置）' : '联想记忆：关（点击设置）',
          onClick: () => setOpen(true),
        },
          h('span', { className: 'asm-dot' }),
          on ? '记忆' : '记忆·关',
        ),
        open ? h(Panel, { onClose: () => setOpen(false) }) : null,
      )
    }

    const DICT = {
      zh: { title: '联想记忆' },
      en: { title: 'Associative Memory' },
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'assoc-mem',
          order: 45,
          label: '联想记忆',
        }, Pill))
      },
    }
  },
})