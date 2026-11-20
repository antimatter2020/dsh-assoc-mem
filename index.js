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
import { buildGlossInstruction, parseGlossReply, hasGlossSection } from './lib/gloss.js'
import { splitParagraphs, userFragment } from './lib/fragments.js'

const BASE = '/dsh-assoc-mem'
const SECTION_NAME = 'assoc-mem'
const SECTION_ORDER = 860

const here = path.dirname(fileURLToPath(import.meta.url))
const DICT_FILE = path.join(here, 'data', 'jieba_dict.txt')

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
  const store = new Store({ ...(config || {}), workspace })
  const tokenizer = new Tokenizer({ dictPath: DICT_FILE })
  const ready = (async () => {
    await store.init()
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
      const r = store.graph.ingest(words, s)
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
    for (const frag of frags) {
      const spans = tokenizer.spans(frag)
      const words = [...new Set(spans.map((x) => x.word))]
      if (words.length < 2) continue
      for (const w of words) store.node(w)
      const r = store.graph.ingest(words, s)
      added += r.added
      hit += r.hit
      for (const sp of spans) store.seedGloss(sp.word, frag, sp.start, sp.end)
    }
    if (added || hit) {
      store.graph.isolatePrune()
      for (const name of store.nodes.keys()) {
        if (!store.graph.adj.has(name)) store.nodes.get(name).deleted = true
      }
      store.dirty = true
    }
    return { fragments: frags.length, added, hit }
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
      const r = store.graph.ingest(words, s)
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
  // 名词解释的遵守情况：上一轮发了指令，这一轮检查助手回复里有没有「补充解释：」
  const glossState = { askedRound: -1, strike: 0, lastAsked: [] }

  /** 扫最近一条助手回复，判断上一轮指令有没有被执行 */
  function checkGlossCompliance(context) {
    if (glossState.askedRound < 0) return
    try {
      const agent = context && (context.agent || context.scope)
      const log = agent && agent.session && agent.session.log
      if (!Array.isArray(log)) return
      for (let i = log.length - 1; i >= Math.max(0, log.length - 60); i -= 1) {
        const ev = log[i]
        if (!ev || ev.type !== 'assistant/message') continue
        const data = ev.data || {}
        const msg = data.message || data
        const content = msg && msg.content
        let text = ''
        if (typeof content === 'string') text = content
        else if (Array.isArray(content)) {
          text = content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
        }
        if (!text) continue
        if (hasGlossSection(text)) {
          glossState.strike = 0
          // 关键：把「补充解释」段落解析出来，写进词典
          const { items, rejects } = parseGlossReply(text)
          let changed = false
          for (const it of items) { store.setGloss(it.word, it.gloss); changed = true }
          for (const w of rejects) { store.reject(w); changed = true }
          if (changed) {
            store.save().catch((e) => ctx.logger?.warn?.('[assoc-mem] 解释落盘失败：' + messageOf(e)))
            diag.lastParsedGloss = items.length
            diag.lastRejected = rejects.length
          }
        } else {
          glossState.strike += 1
        }
        return
      }
    } catch { /* 读不到就当作没漏 */ }
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
          checkGlossCompliance(context)
          const glossHint = store.state.glossMode === 'llm'
            ? buildGlossInstruction(pending, glossState.strike)
            : ''
          if (pending.length) {
            glossState.askedRound = store.graph.round
            glossState.lastAsked = pending.slice()
          }
          diag.glossStrike = glossState.strike
          const raw = buildInjection(store, tokenizer, userText)
          const out = [glossHint, raw].filter(Boolean).join('\n\n')
          diag.pendingGloss = pending.length
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
        neighbours: nb.map((x) => ({
          name: x.name,
          w: Number(x.w.toFixed(4)),
          gloss: (store.nodes.get(x.name)?.gloss || []).map((g) => g.text).join(' / '),
        })),
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