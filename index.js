/**
 * dsh-assoc-mem Host 半。
 *
 * 注入点：ctx.systemPrompt.section()，text 为每次组装提示词时求值的函数，
 * 因此开关与参数一改即生效，无需重启。
 *
 * 面板接口（同源，POST 需带 x-assoc-mem: 1）：
 *   GET  /dsh-assoc-mem/state            开关、参数、统计
 *   GET  /dsh-assoc-mem/nodes            概念列表（?q= 搜索 &filter=all|manual|orphan|pending）
 *   GET  /dsh-assoc-mem/node?name=       单个概念详情（含邻居）
 *   GET  /dsh-assoc-mem/preview?text=    预览注入内容
 *   POST /dsh-assoc-mem/toggle           { enabled }
 *   POST /dsh-assoc-mem/params           { ... }
 *   POST /dsh-assoc-mem/gloss            { name, text }
 *   POST /dsh-assoc-mem/reject           { name }
 *   POST /dsh-assoc-mem/remove           { name }
 *   POST /dsh-assoc-mem/merge            { from, to }
 *   POST /dsh-assoc-mem/add              { name }
 *   POST /dsh-assoc-mem/ingest           { text, s } 手动喂入
 *   POST /dsh-assoc-mem/ingest-file      { path, s } 读文件入记忆
 *   POST /dsh-assoc-mem/save             立即落盘
 *   GET  /dsh-assoc-mem/memories         列出工作区记忆文件
 *   POST /dsh-assoc-mem/memory-open      { path } 切换记忆文件
 *   POST /dsh-assoc-mem/memory-new       { name } 新建记忆文件
 *   POST /dsh-assoc-mem/memory-delete    { path } 删除记忆文件
 *   POST /dsh-assoc-mem/gloss-mode       { mode:'context'|'llm', tokens }
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Store } from './lib/store.js'
import { Tokenizer } from './lib/tokenizer.js'
import { buildInjection, previewLines } from './lib/retrieve.js'
import { parseGlossReply, GLOSS_COOLDOWN_TURNS } from './lib/gloss.js'
import { buildExplainRequest, parseExplainReply, collectStream, EXPLAIN_LIMITS } from './lib/explain.js'
import { splitParagraphs, userFragment } from './lib/fragments.js'

const BASE = '/dsh-assoc-mem'
const SECTION_NAME = 'assoc-mem'
const SECTION_ORDER = 860

const here = path.dirname(fileURLToPath(import.meta.url))
const DICT_FILE = path.join(here, 'data', 'jieba_dict.txt')

// llm 走 ctx.get('llm') 可选获取，不写进 inject：
// inject 里写对象形式在 Cordis 上不保证被接受，写错会导致整个插件加载失败，
// 而解释生成本来就是可选能力，没有 llm 也该能正常记共现。
export const inject = ['webServer', 'systemPrompt']

function sendJson(res, code, body) {
  const text = JSON.stringify(body)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

function queryOf(req) {
  try {
    const url = new URL(req.url, 'http://localhost')
    return url.searchParams
  } catch {
    return new URLSearchParams()
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 4 * 1024 * 1024) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function isUserAuthored(message) {
  if (!message || typeof message !== 'object') return false
  const source = message.source && typeof message.source === 'object' ? message.source : null
  if (!source) return message.role === 'user'
  return source.kind === 'user'
}

function textOfContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (!b) continue
    if (typeof b === 'string') { parts.push(b); continue }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'input_text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

/** 只取用户亲手写的消息，跳过系统注入与工具回显 */
function latestUserText(context) {
  try {
    const agent = context && (context.agent || context.scope)
    const session = agent && agent.session
    if (!session || !Array.isArray(session.log)) return ''
    const log = session.log
    for (let i = log.length - 1; i >= Math.max(0, log.length - 300); i -= 1) {
      const ev = log[i]
      const data = ev && ev.data
      if (!data) continue
      if (ev.type === 'agent/inbox/spliced') {
        const arr = Array.isArray(data.inserted) ? data.inserted : []
        for (let j = arr.length - 1; j >= 0; j -= 1) {
          const msg = arr[j]
          if (!isUserAuthored(msg)) continue
          const text = textOfContent(msg.content)
          if (text) return text
        }
        continue
      }
      if (ev.type === 'user/message') {
        const msg = data.message && typeof data.message === 'object' ? data.message : data
        if (!isUserAuthored(msg)) continue
        const text = textOfContent(msg.content)
        if (text) return text
      }
    }
    return ''
  } catch {
    return ''
  }
}

export function apply(ctx, config) {
  const workspace = (() => {
    const fromEnv = process.env.DSH_WORKSPACE || process.env.DSH_WORKSPACE_ROOT || process.env.DSH_CWD
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
    if (config && typeof config.workspace === 'string' && config.workspace.trim()) return config.workspace.trim()
    try { return process.cwd() } catch { return '' }
  })()
  // 冷却是程序内部的相对计数，但必须跨重启延续：
  // 若重启后从 0 重新数，旧记录里的轮次会比当前还大，
  // 冷却判定会误判成「刚催过」，所有条目又被锁 10 轮。
  const turn = { n: 0 }

  const store = new Store({ ...(config || {}), workspace })
  const tokenizer = new Tokenizer({ dictPath: DICT_FILE })
  const ready = (async () => {
    await store.init()
    // 恢复对话轮次计数：必须在 init 之后，因为要从记忆文件里读
    turn.n = Number.isFinite(store.state.turnCount) ? store.state.turnCount : 0
    tokenizer.extraWords = new Set(store.custom)
    tokenizer.blocked = new Set(store.blocked)
    tokenizer.customConcepts = new Set(store.custom)
    await tokenizer.load()
    tokenizer.buildAutomaton()
  })().catch((error) => {
    ctx.logger?.warn?.('[assoc-mem] 初始化失败：' + messageOf(error))
  })

  async function ingestText(text, s = 1) {
    await ready
    const frags = userFragment(text)
    let added = 0
    let hit = 0
    let glossed = 0
    for (const frag of frags) {
      const spans = tokenizer.spans(frag)
      const words = [...new Set(spans.map((x) => x.word))]
      if (words.length < 2) continue
      for (const w of words) store.node(w)
      const positions = new Map()
      for (const sp of spans) if (!positions.has(sp.word)) positions.set(sp.word, { start: sp.start, end: sp.end })
      const r = store.graph.ingest(words, s, { positions, text: frag })
      added += r.added
      hit += r.hit
      for (const sp of spans) {
        if (store.seedGloss(sp.word, frag, sp.start, sp.end)) glossed += 1
      }
    }
    const isolated = store.graph.isolatePrune()
    for (const name of store.nodes.keys()) {
      if (!store.graph.adj.has(name)) store.nodes.get(name).deleted = true
    }
    store.dirty = true
    return { fragments: frags.length, added, hit, glossed, isolated }
  }

  /**
   * 同步摄入：分词与建图都是同步的，只有落盘是异步的。
   * section 是同步函数，必须用这个版本，否则本轮抽不到新概念。
   */
  function ingestSync(text, s = 1) {
    if (!tokenizer.ac) return { fragments: 0, added: 0, hit: 0 }
    const frags = userFragment(text)
    let added = 0
    let hit = 0
    let pendingEdges = []
    for (const frag of frags) {
      const spans = tokenizer.spans(frag)
      const words = [...new Set(spans.map((x) => x.word))]
      if (words.length < 2) continue
      for (const w of words) store.node(w)
      // 每个词取第一次出现的位置，用于算词间距
      const positions = new Map()
      for (const sp of spans) if (!positions.has(sp.word)) positions.set(sp.word, { start: sp.start, end: sp.end })
      const r = store.graph.ingest(words, s, { positions, text: frag })
      added += r.added
      hit += r.hit
      if (r.pendingEdges) pendingEdges.push(...r.pendingEdges)
      for (const sp of spans) store.seedGloss(sp.word, frag, sp.start, sp.end)
    }
    if (added || hit) {
      store.graph.isolatePrune()
      for (const name of store.nodes.keys()) {
        if (!store.graph.adj.has(name)) store.nodes.get(name).deleted = true
      }
      store.dirty = true
    }
    // 挂到 store 上，注入段落才拿得到「本轮新增、还没解释的边」。
    store.pendingEdges = pendingEdges
    return { fragments: frags.length, added, hit, pendingEdges }
  }

  async function ingestFile(filePath, s = 1) {
    await ready
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error('not-a-file')
    if (info.size > 8 * 1024 * 1024) throw new Error('file-too-large')
    const text = await readFile(filePath, 'utf8')
    const frags = splitParagraphs(text, 75)
    let added = 0
    let hit = 0
    let glossed = 0
    for (const frag of frags) {
      const spans = tokenizer.spans(frag)
      const words = [...new Set(spans.map((x) => x.word))]
      if (words.length < 2) continue
      for (const w of words) store.node(w)
      const positions = new Map()
      for (const sp of spans) if (!positions.has(sp.word)) positions.set(sp.word, { start: sp.start, end: sp.end })
      const r = store.graph.ingest(words, s, { positions, text: frag })
      added += r.added
      hit += r.hit
      for (const sp of spans) {
        if (store.seedGloss(sp.word, frag, sp.start, sp.end)) glossed += 1
      }
    }
    store.dirty = true
    return { fragments: frags.length, added, hit, glossed, chars: text.length }
  }

  // 已处理过的消息指纹，避免同一段文字被重复摄入
  const seen = new Set()
  const diag = { sectionCalls: 0, lastUserLen: 0, lastInjectedLen: 0, lastError: '', hasLogger: false }
  // 解释任务：插件自己向 LLM 请求，不再依赖主对话模型写段落。
  // 同时只跑一个任务，避免连续多轮叠出并发请求。
  const explainJob = { running: false, lastAt: 0 }

  /**
   * 后台请求解释：名词 + 边**一次问完、一次收回**。
   *
   * 这是本轮重构的核心。以前靠系统提示让主对话模型在回复末尾写
   * 「补充解释：」「关系解释：」，但它经常漏写关系段，插件只能干等。
   * 现在改成插件自己调 ctx.llm.stream()，模型没有「不写」的余地。
   */
  async function runExplainJob(nouns, edges) {
    await ready
    // 卡死保护：流如果不返回 finish，running 会永远是 true，
    // 之后每一轮都被 busy 挡掉（实测踩过）。超过 90 秒一律当它死了。
    const STALE = 90 * 1000
    if (explainJob.running) {
      if (Date.now() - (explainJob.startedAt || 0) < STALE) {
        diag.explainSkipped = 'busy'
        return
      }
      diag.explainSkipped = 'stale-reclaimed'
    }

    // 每次开跑先清掉上一轮的残留，否则 diag 会一直显示旧错误，
    // 让人误以为配置没生效（这轮就踩过这个坑）。
    diag.explainError = ''
    diag.explainSkipped = ''
    diag.explainNouns = 0
    diag.explainEdges = 0
    diag.explainMissed = 0
    diag.explainReplyLen = 0

    explainJob.running = true
    explainJob.startedAt = Date.now()
    explainJob.lastAt = Date.now()
    let ok = false
    try {
      const llm = ctx.get?.('llm') ?? ctx.llm
      if (!llm || typeof llm.stream !== 'function') {
        diag.explainError = 'llm-service-unavailable'
        return
      }
      const { system, user } = buildExplainRequest({ nouns, edges })
      if (!system && !user) { ok = true; return }

      // 模型路由：优先用面板里手动配置的，没配才用当前默认模型。
      // 默认模型对象的字段名不可靠猜测，所以这里把整个对象记进 diag，
      // 拿不到时能直接看到它长什么样，而不是只看到一个 'no-model-configured'。
      let provider = String(store.state.explainProvider || '').trim()
      let model = String(store.state.explainModel || '').trim()
      if (!provider || !model) {
        let sel = {}
        try { sel = ctx.get?.('agentDefaultModel')?.currentSelection?.() || {} } catch { sel = {} }
        diag.explainSelection = sel
        const pick = (obj, keys) => {
          for (const k of keys) {
            const v = obj && obj[k]
            if (typeof v === 'string' && v.trim()) return v.trim()
          }
          return ''
        }
        provider = provider || pick(sel, ['provider', 'providerId'])
        model = model || pick(sel, ['model', 'modelId'])
        if (!provider) provider = pick(sel.route || {}, ['provider', 'providerId'])
        if (!model) model = pick(sel.route || {}, ['model', 'modelId'])
        diag.explainFrom = 'default'
      } else {
        diag.explainFrom = 'config'
      }
      if (!provider || !model) {
        diag.explainError = 'no-model-configured'
        return
      }

      diag.explainProvider = provider
      diag.explainModel = model

      // 主动超时：不给流无限等待的机会。
      // 之前有请求挂住不返回 finish，导致 running 永远为 true、
      // 后续每一轮都被 busy 挡掉，看起来就是「彻底不动了」。
      const ac = new AbortController()
      const timer = setTimeout(() => { try { ac.abort() } catch { /* 已结束 */ } }, 60 * 1000)
      let text = ''
      let failure = null
      try {
        const stream = llm.stream({
          provider,
          model,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
          temperature: 0,
          maxTokens: 800,
          signal: ac.signal,
        })
        const r = await collectStream(stream)
        text = r.text
        failure = r.failure
      } catch (e) {
        failure = failure || { message: messageOf(e) }
      } finally {
        clearTimeout(timer)
      }
      if (failure) {
        // 不 return，让 finally 里的「失败解除冷却」生效
        diag.explainError = 'llm-failed: ' + (failure.message || failure.code || '')
        return
      }

      diag.explainReplyLen = text.length
      // 留一份原文样本，格式对不上时能直接看到模型到底回了什么
      diag.explainSample = text.slice(0, 600)

      const parsed = parseExplainReply(text, { nouns, edges })
      diag.explainNouns = parsed.nouns.length
      diag.explainEdges = parsed.edges.length

      let changed = false
      for (const it of parsed.nouns) {
        if (it.reject) { store.reject(it.word); changed = true }
        else { store.setGloss(it.word, it.gloss); changed = true }
      }
      for (const e of parsed.edges) {
        const key = e.a < e.b ? e.a + '\u0000' + e.b : e.b + '\u0000' + e.a
        const edge = store.graph.edges.get(key)
        if (edge) { edge.gloss = e.gloss; edge.glossKind = 'llm'; changed = true }
      }

      // 没拿到的条目解除冷却，下一轮立刻能再问——
      // 不能让一次失败的请求把它们锁死 10 轮。
      const gotNouns = new Set(parsed.nouns.map((x) => x.word))
      const gotEdges = new Set(parsed.edges.map((x) => x.a + '|' + x.b))
      const missedNouns = nouns.filter((n) => !gotNouns.has(n))
      const missedEdges = edges.filter((e) =>
        !gotEdges.has(e.a + '|' + e.b) && !gotEdges.has(e.b + '|' + e.a))
      if (missedNouns.length) store.unmarkAsked(missedNouns, [])
      if (missedEdges.length) store.unmarkAsked([], missedEdges)
      diag.explainMissed = missedNouns.length + missedEdges.length

      // 只有真正拿到结果的条目才记冷却。
      // 没拿到的那些已经被 unmark 放行，下一轮立刻重问。
      const doneNouns = nouns.filter((n) => gotNouns.has(n))
      const doneEdges = edges.filter((e) =>
        gotEdges.has(e.a + '|' + e.b) || gotEdges.has(e.b + '|' + e.a))
      if (doneNouns.length || doneEdges.length) {
        store.markAsked(doneNouns, doneEdges, store.state.turnCount || 0)
      }
      diag.explainDone = doneNouns.length + doneEdges.length

      if (changed || missedNouns.length || missedEdges.length || doneNouns.length || doneEdges.length) {
        await store.save()
      }
      diag.explainAt = new Date().toISOString()
      ok = true
    } catch (e) {
      diag.explainError = messageOf(e)
    } finally {
      explainJob.running = false
      // 整体失败（配置错、服务不可用、抛异常）时，把所有条目解除冷却。
      // 否则一次失败会把它们锁 10 轮，用户看到的就是「问过但永远没有解释」。
      if (!ok) {
        store.unmarkAsked(nouns, edges)
        diag.explainMissed = (nouns ? nouns.length : 0) + (edges ? edges.length : 0)
        store.save().catch(() => {})
      }
    }
  }

  const promptService = ctx.get?.('systemPrompt') ?? ctx.systemPrompt
  if (promptService && typeof promptService.section === 'function') {
    ctx.effect(() => promptService.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: (context) => {
        try {
          diag.sectionCalls += 1
          diag.hasLogger = Boolean(ctx.logger)
          if (!store.state.enabled) { diag.lastError = 'disabled'; return '' }
          const userText = latestUserText(context)
          diag.lastUserLen = userText.length
          if (!userText) { diag.lastError = 'no-user-text'; return '' }

          // 静默摄入（同步！）：必须在注入之前完成，否则本轮抽不到新概念
          const fingerprint = userText.length + ':' + userText.slice(0, 40) + ':' + userText.slice(-40)
          if (!seen.has(fingerprint)) {
            seen.add(fingerprint)
            if (seen.size > 400) seen.clear()
            // 见到一条新的用户消息，才是一个新轮次
            turn.n += 1
            // 轮次计数跨重启延续，否则旧记录会误判成「刚催过」
            store.state.turnCount = turn.n
            try {
              const r = ingestSync(userText, 1)
              diag.lastIngest = r
              if (r.added || r.hit) {
                store.save().catch((e) => ctx.logger?.warn?.('[assoc-mem] 落盘失败：' + messageOf(e)))
              }
            } catch (e) {
              diag.lastError = 'ingest-failed: ' + messageOf(e)
            }
          }

          const pending = store.pendingGloss()
          store.graph.params.edgeMode = store.state.edgeMode || 'context'

          // 解释改由插件自己向 LLM 请求，不再要求主对话模型写段落。
          // 这里只负责「排队」：把本轮该问的条目挑出来交给后台任务。
          const nounCandidates = store.state.glossMode === 'llm' ? pending : []
          const edgeCandidates = store.state.glossMode === 'llm' &&
            store.graph.params.edgeMode === 'llm' &&
            Array.isArray(store.pendingEdges) ? store.pendingEdges : []

          // 逐条冷却：前 GLOSS_COOLDOWN_TURNS 轮内问过的那一条跳过，不影响其它条目
          const round = turn.n
          const freshNouns = store.freshNouns(nounCandidates, round, GLOSS_COOLDOWN_TURNS)
          const freshEdges = store.freshEdges(edgeCandidates, round, GLOSS_COOLDOWN_TURNS)

          if (freshNouns.length || freshEdges.length) {
            // 不在这里 markAsked：要等请求真的有结果再记。
            // 提前记的话，一次失败就把这些条目锁 10 轮，
            // 表现就是「问过却永远没有解释」——这个坑已经踩过两次了。
            //
            // 注意 section 一轮会被调用多次（组装提示词时反复求值），
            // 这里必须按轮次去重，否则第二次就撞上 busy 白白跳过。
            if (explainJob.lastRound !== round) {
              explainJob.lastRound = round
              void runExplainJob(freshNouns, freshEdges)
            }
          }

          diag.round = round
          diag.pendingGloss = pending.length
          diag.glossCooling = Math.max(0, nounCandidates.length - freshNouns.length) +
            Math.max(0, edgeCandidates.length - freshEdges.length)
          diag.lastAskedNouns = freshNouns.length
          diag.lastAskedEdges = freshEdges.length

          // 注入内容只剩记忆本身，不再有催办文案——省掉的正是这段 token
          const out = buildInjection(store, tokenizer, userText)
          diag.lastInjectedLen = out.length
          diag.lastError = out ? 'ok' : 'empty-injection'
          return out
        } catch (e) {
          diag.lastError = 'exception: ' + messageOf(e)
          return ''
        }
      },
    }))
  }

  const server = ctx.get?.('webServer') ?? ctx.webServer
  if (!server || typeof server.register !== 'function') return

  const guard = (req, res, method) => {
    if (req.method !== method) { sendJson(res, 405, { error: 'method-not-allowed' }); return false }
    if (method === 'POST' && req.headers['x-assoc-mem'] !== '1') { sendJson(res, 403, { error: 'forbidden' }); return false }
    return true
  }

  const route = (p, handler) => ctx.effect(() => server.register({ kind: 'exact', path: BASE + p, handler }))

  route('/state', async (req, res) => {
    if (!guard(req, res, 'GET')) return
    try { await ready; sendJson(res, 200, store.snapshot()) }
    catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/nodes', async (req, res) => {
    if (!guard(req, res, 'GET')) return
    try {
      await ready
      const q = queryOf(req)
      const kw = (q.get('q') || '').trim().toLowerCase()
      const filter = q.get('filter') || 'all'
      const stats = store.graph.stats()
      const out = []
      for (const n of store.nodes.values()) {
        if (n.deleted) continue
        if (kw && !n.name.toLowerCase().includes(kw)) continue
        const deg = stats.degree.get(n.name) || 0
        if (filter === 'manual' && !n.manual) continue
        if (filter === 'orphan' && deg > 0) continue
        if (filter === 'pending' && n.gloss.length) continue
        out.push({
          name: n.name,
          gloss: n.gloss.length ? n.gloss[n.gloss.length - 1].text : '',
          glossCount: n.gloss.length,
          degree: deg,
          manual: n.manual,
        })
      }
      out.sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name))
      sendJson(res, 200, { total: out.length, items: out.slice(0, 500) })
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/node', async (req, res) => {
    if (!guard(req, res, 'GET')) return
    try {
      await ready
      const name = queryOf(req).get('name') || ''
      const n = store.nodes.get(name)
      if (!n) return sendJson(res, 404, { error: 'not-found' })
      const nb = store.graph.neighbours(name, 50)
      sendJson(res, 200, {
        name: n.name,
        gloss: n.gloss,
        manual: n.manual,
        neighbours: nb.map((x) => {
          // 这一栏是「边」的信息，不是邻居词的词典释义：
          // 取这条边自己的关系解释，没有才退回邻居的概念解释。
          const key = name < x.name
            ? name + '\u0000' + x.name
            : x.name + '\u0000' + name
          const edge = store.graph.edges.get(key)
          const edgeGloss = (edge && edge.gloss) || ''
          const nodeGloss = (store.nodes.get(x.name)?.gloss || [])
            .map((g) => g.text).join(' / ')
          return {
            name: x.name,
            w: Number(x.w.toFixed(4)),
            dist: edge && Number.isFinite(edge.dist) ? edge.dist : 9999,
            edgeGloss,
            edgeGlossKind: (edge && edge.glossKind) || '',
            gloss: edgeGloss || nodeGloss,
          }
        }),
      })
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/gloss-clear', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const n = store.clearPendingGloss()
      await store.save()
      sendJson(res, 200, { cleared: n, remaining: store.pendingGloss().length })
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/gloss-extract', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      const { items, rejects } = parseGlossReply(String(body.text || ''))
      for (const it of items) store.setGloss(it.word, it.gloss)
      for (const w of rejects) store.reject(w)
      if (items.length || rejects.length) await store.save()
      sendJson(res, 200, {
        accepted: items.length,
        rejected: rejects.length,
        items,
      })
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/diag', async (req, res) => {
    if (!guard(req, res, 'GET')) return
    try { await ready; sendJson(res, 200, { ...diag, injectDeclared: inject }) }
    catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/preview', async (req, res) => {
    if (!guard(req, res, 'GET')) return
    try {
      await ready
      const text = queryOf(req).get('text') || ''
      sendJson(res, 200, previewLines(store, tokenizer, text))
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/toggle', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      store.state.enabled = Boolean(body.enabled)
      await store.save()
      sendJson(res, 200, store.snapshot())
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/params', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      const next = { ...store.graph.params }
      for (const key of Object.keys(next)) {
        if (body[key] === undefined) continue
        const v = Number(body[key])
        if (Number.isFinite(v)) next[key] = v
      }
      store.graph.params = next
      store.state.params = next
      await store.save()
      sendJson(res, 200, store.snapshot())
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/edge-mode', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      const m = String(body.mode || '')
      if (m === 'off' || m === 'context' || m === 'llm') {
        store.state.edgeMode = m
        store.graph.params.edgeMode = m
        await store.save()
      }
      sendJson(res, 200, store.snapshot())
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/explain-reset', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      // 清空所有逐条冷却记录。请求失败过的条目会一直占着冷却位，
      // 修好配置后需要一次性放开，否则要等 10 轮才重问。
      const n = Object.keys(store.state.glossAsked || {}).length
      const e = Object.keys(store.state.edgeAsked || {}).length
      store.state.glossAsked = {}
      store.state.edgeAsked = {}
      store.dirty = true
      await store.save()
      diag.explainError = ''
      sendJson(res, 200, { cleared: n + e, glossAsked: n, edgeAsked: e })
    } catch (err) { sendJson(res, 500, { error: messageOf(err) }) }
  })

  route('/explain-model', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      store.state.explainProvider = String(body.provider || '').trim()
      store.state.explainModel = String(body.model || '').trim()
      await store.save()
      sendJson(res, 200, store.snapshot())
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/gloss-mode', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      if (body.mode === 'context' || body.mode === 'llm') store.state.glossMode = body.mode
      const tk = Number(body.tokens)
      if (Number.isFinite(tk) && tk > 0) store.state.glossContextTokens = Math.min(200, Math.round(tk))
      await store.save()
      sendJson(res, 200, store.snapshot())
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/gloss', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      store.setGloss(String(body.name || ''), String(body.text || ''))
      await store.save()
      sendJson(res, 200, { ok: true })
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/reject', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      store.reject(String(body.name || ''))
      await store.save()
      sendJson(res, 200, { ok: true })
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/remove', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      store.remove(String(body.name || ''))
      await store.save()
      sendJson(res, 200, { ok: true })
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/merge', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      const from = String(body.from || '')
      const to = String(body.to || '')
      if (!from || !to || from === to) return sendJson(res, 400, { error: 'bad-args' })
      store.graph.mergeNodes(from, to)
      const src = store.nodes.get(from)
      const dst = store.node(to)
      if (src) {
        for (const g of src.gloss) if (!dst.gloss.some((x) => x.text === g.text)) dst.gloss.push(g)
        store.nodes.delete(from)
      }
      await store.save()
      sendJson(res, 200, { ok: true })
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/add', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      store.addCustom(String(body.name || ''))
      await store.save()
      sendJson(res, 200, { ok: true })
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/ingest', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      const body = await readBody(req)
      const result = await ingestText(String(body.text || ''), Number(body.s) || 1)
      await store.save()
      sendJson(res, 200, result)
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/ingest-file', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      const body = await readBody(req)
      const result = await ingestFile(String(body.path || ''), Number(body.s) || 1)
      await store.save()
      sendJson(res, 200, result)
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/workspace', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      const p = String(body.path || '').trim()
      if (!p) return sendJson(res, 400, { error: 'missing-path' })
      store.workspace = p
      store.dir = path.join(p, 'dsh-memory')
      await store.switchMemory(path.join(store.dir, 'default' + '.mem.json'))
      sendJson(res, 200, store.snapshot())
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/memories', async (req, res) => {
    if (!guard(req, res, 'GET')) return
    try { await ready; sendJson(res, 200, await store.listMemories()) }
    catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/memory-open', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      const p = String(body.path || '').trim()
      if (!p) return sendJson(res, 400, { error: 'missing-path' })
      const snap = await store.switchMemory(p)
      sendJson(res, 200, snap)
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/memory-new', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      const snap = await store.createMemory(String(body.name || 'memory'))
      sendJson(res, 200, snap)
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/memory-delete', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try {
      await ready
      const body = await readBody(req)
      await store.deleteMemory(String(body.path || ''))
      sendJson(res, 200, await store.listMemories())
    } catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })

  route('/save', async (req, res) => {
    if (!guard(req, res, 'POST')) return
    try { await ready; await store.save(); sendJson(res, 200, { ok: true }) }
    catch (e) { sendJson(res, 500, { error: messageOf(e) }) }
  })
}