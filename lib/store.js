/**
 * 状态与记忆库的持久化。
 *
 * 记忆文件放在**工作区**（当前会话的 cwd）下，不写系统目录。
 * 只有插件自身的轻量配置放在 $DSH_HOME/plugin-data/dsh-assoc-mem/config.json，
 * 里面记录「上次用的记忆文件路径」和开关等偏好。
 *
 * 记忆库文件（*.mem.json）自带全部内容：概念、图、屏蔽词、自定义词。
 * 因此一个文件就是一个完整记忆，可以直接拷给别人或另存一份。
 */

import { mkdir, readFile, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { MemoryGraph, DEFAULTS } from './graph.js'

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv
  return path.join(homedir(), '.dsh')
}

export function configDir() {
  return path.join(dshHome(), 'plugin-data', 'dsh-assoc-mem')
}

/** 记忆目录：工作区下的 dsh-memory/ */
export function memoryDir(workspace) {
  return path.join(workspace || process.cwd(), 'dsh-memory')
}

export const MEMORY_EXT = '.mem.json'

function blankPrefs() {
  return {
    version: 1,
    enabled: true,
    injectLimit: 8,
    glossMode: 'context',
    glossContextTokens: 20,
    memoryFile: null,
    params: { ...DEFAULTS },
  }
}

function blankMemory() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    round: 0,
    params: { ...DEFAULTS },
    nodes: [],
    graph: { edges: [], round: 0 },
    blocked: [],
    custom: [],
  }
}

async function readJson(file, fallback) {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

function safeName(name) {
  return String(name || 'memory')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'memory'
}

export class Store {
  constructor(config = {}) {
    this.config = config || {}
    this.workspace = config.workspace || process.cwd()
    this.dir = memoryDir(this.workspace)
    this.prefPath = path.join(configDir(), 'config.json')

    this.prefs = blankPrefs()
    this.state = blankPrefs()
    this.graph = new MemoryGraph(this.prefs.params)
    this.nodes = new Map()
    this.blocked = new Set()
    this.custom = new Set()
    this.note = ''
    this.ready = null
    this.dirty = false
  }

  get memoryPath() {
    const saved = this.prefs.memoryFile
    const fallback = path.join(this.dir, 'default' + MEMORY_EXT)
    if (!saved) return fallback
    // 配置里的路径若不属于当前工作区，视为过期，回到当前目录
    try {
      const rel = path.relative(this.dir, path.resolve(saved))
      if (rel.startsWith('..') || path.isAbsolute(rel)) return fallback
    } catch {
      return fallback
    }
    return path.resolve(saved)
  }

  async init() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const prefs = await readJson(this.prefPath, null)
      if (prefs) {
        this.prefs = { ...blankPrefs(), ...prefs, params: { ...DEFAULTS, ...(prefs.params || {}) } }
      }
      if (typeof this.config.enabled === 'boolean') this.prefs.enabled = this.config.enabled
      if (this.config.memoryFile) this.prefs.memoryFile = this.config.memoryFile

      await this.loadMemory(this.memoryPath)
      return this
    })()
    return this.ready
  }

  /** 载入（或新建）一个记忆文件 */
  async loadMemory(file) {
    const target = path.resolve(file)
    const mem = await readJson(target, null)
    this.prefs.memoryFile = target
    this.state = { ...this.prefs }
    if (mem && typeof mem.glossClearAt === 'number') this.state.glossClearAt = mem.glossClearAt
    this.graph = new MemoryGraph(this.prefs.params)
    this.nodes = new Map()
    this.blocked = new Set()
    this.custom = new Set()

    if (!mem) {
      this.note = '已新建记忆文件'
      return this
    }

    if (mem.params && typeof mem.params === 'object') {
      this.graph = MemoryGraph.fromJSON({ ...(mem.graph || {}), params: { ...this.prefs.params, ...mem.params } })
    } else {
      this.graph = MemoryGraph.fromJSON(mem.graph || {})
      this.graph.params = { ...this.prefs.params }
    }
    const nodes = Array.isArray(mem.nodes) ? mem.nodes : []
    for (const n of nodes) {
      if (!n || typeof n.name !== 'string') continue
      this.nodes.set(n.name, {
        name: n.name,
        gloss: Array.isArray(n.gloss) ? n.gloss : [],
        deleted: Boolean(n.deleted),
        manual: Boolean(n.manual),
      })
    }
    if (Array.isArray(mem.blocked)) for (const w of mem.blocked) this.blocked.add(w)
    if (Array.isArray(mem.custom)) for (const w of mem.custom) this.custom.add(w)
    this.note = '已载入 ' + path.basename(target)
    return this
  }

  /** 切到另一个记忆文件：先把当前数据存回**当前**文件，再载入目标 */
  async switchMemory(file) {
    await this.ready
    const target = path.resolve(file)
    // 只有真的换了文件才保存当前数据，避免自己覆盖自己
    if (path.resolve(this.memoryPath) !== target) {
      await this.save()
    }
    await this.loadMemory(target)
    await this.loadFromDiskPrefs()
    return this.snapshot()
  }

  /** 空白记忆不写盘，等真正有数据再保存 */
  async loadFromDiskPrefs() {
    this.prefs.memoryFile = this.memoryPath
    await this.savePrefs()
  }

  async savePrefs() {
    await writeJson(this.prefPath, this.prefs)
  }

  async save() {
    const mem = {
      version: 1,
      updatedAt: new Date().toISOString(),
      params: this.graph.params,
      nodes: [...this.nodes.values()],
      graph: this.graph.toJSON(),
      blocked: [...this.blocked],
      custom: [...this.custom],
    }
    await writeJson(this.memoryPath, mem)
    this.prefs.params = this.graph.params
    this.prefs.enabled = this.state.enabled
    this.prefs.glossMode = this.state.glossMode
    this.prefs.glossContextTokens = this.state.glossContextTokens
    this.prefs.glossClearAt = this.state.glossClearAt
    this.prefs.edgeMode = this.state.edgeMode
    this.prefs.injectLimit = this.state.injectLimit
    await this.savePrefs()
    this.dirty = false
  }

  /** 列出工作区里的记忆文件 */
  async listMemories() {
    const out = []
    try {
      await mkdir(this.dir, { recursive: true })
      const names = await readdir(this.dir)
      for (const n of names) {
        if (!n.endsWith(MEMORY_EXT)) continue
        const full = path.join(this.dir, n)
        const info = await stat(full).catch(() => null)
        if (!info) continue
        out.push({ name: n, path: full, bytes: info.size, mtime: info.mtimeMs })
      }
    } catch {
      /* 目录还没建 */
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return { dir: this.dir, current: this.memoryPath, items: out }
  }

  async createMemory(name) {
    await this.ready
    const file = path.join(this.dir, safeName(name) + MEMORY_EXT)
    await mkdir(this.dir, { recursive: true })
    const info = await stat(file).catch(() => null)
    if (info) throw new Error('同名记忆已存在')
    // 先保存当前记忆，再切到新的空记忆，最后把空记忆落盘
    await this.save()
    await this.loadMemory(file)
    this.prefs.memoryFile = file
    await this.save()
    return this.snapshot()
  }

  async deleteMemory(file) {
    const target = path.resolve(file)
    if (target === path.resolve(this.memoryPath)) throw new Error('不能删除正在使用的记忆')
    if (!target.startsWith(path.resolve(this.dir))) throw new Error('只能删除工作区记忆目录内的文件')
    await unlink(target)
    return this.listMemories()
  }

  node(name) {
    let n = this.nodes.get(name)
    if (!n) {
      n = { name, gloss: [], deleted: false, manual: false, t: Date.now() }
      this.nodes.set(name, n)
    }
    return n
  }

  /** 上下文截取模式：首次入库时自动写入 */
  seedGloss(name, contextText, hitStart, hitEnd) {
    const n = this.node(name)
    if (n.gloss.length) return false
    if (this.state.glossMode === 'llm') return false
    const tokens = this.state.glossContextTokens || 30
    const chars = Math.max(20, Math.round(tokens * 1.5))
    const from = Math.max(0, (hitStart ?? 0) - chars)
    const to = Math.min(String(contextText).length, (hitEnd ?? 0) + chars)
    const snippet = String(contextText).slice(from, to).replace(/\s+/g, ' ').trim()
    if (!snippet) return false
    n.gloss.push({ text: snippet, t: Date.now(), kind: 'context' })
    this.dirty = true
    return true
  }

  /** llm 模式下待生成解释的概念 */
  pendingGloss(limit = 0) {
    if (this.state.glossMode !== 'llm') return []
    const floor = this.state.glossClearAt || 0
    const out = []
    for (const n of this.nodes.values()) {
      if (n.deleted) continue
      if (n.gloss.length) continue
      if (this.blocked.has(n.name)) continue
      // 清空队列时划掉的词不再追问；之后新出现的词照常入队
      if (floor && (n.t || 0) <= floor) continue
      out.push(n.name)
      if (limit > 0 && out.length >= limit) break
    }
    return out
  }

  /**
   * 清空待解释队列。
   *
   * 只记一个时间点：此刻之前出现的概念不再追问解释，
   * 之后新出现的概念照常入队。不改动任何概念的 gloss，
   * 因此不会让真正需要的解释永久丢失。
   */
  clearPendingGloss() {
    const list = this.pendingGloss()
    this.state.glossClearAt = Date.now()
    this.prefs.glossClearAt = this.state.glossClearAt
    this.dirty = true
    return list.length
  }

  setGloss(name, text) {
    const n = this.node(name)
    const t = String(text || '').trim()
    if (!t) return
    if (n.gloss.some((g) => g.text === t)) return
    n.gloss.push({ text: t, t: Date.now(), kind: 'manual' })
    this.dirty = true
  }

  reject(name) {
    this.blocked.add(name)
    this.graph.dropNode(name)
    const n = this.nodes.get(name)
    if (n) n.deleted = true
    this.dirty = true
  }

  remove(name) {
    this.nodes.delete(name)
    this.graph.dropNode(name)
    this.dirty = true
  }

  addCustom(name) {
    const t = String(name || '').trim()
    if (!t) return
    this.custom.add(t)
    this.blocked.delete(t)
    this.node(t).manual = true
    this.dirty = true
  }

  snapshot() {
    const stats = this.graph.stats()
    const byS = stats.byS || [0, 0, 0, 0]
    const totalS = byS.reduce((a, b) => a + b, 0) || 1
    return {
      enabled: this.state.enabled,
      glossMode: this.state.glossMode,
      glossContextTokens: this.state.glossContextTokens,
      edgeMode: this.state.edgeMode,
      params: this.graph.params,
      memory: { path: this.memoryPath, dir: this.dir, note: this.note },
      stats: {
        nodes: this.nodes.size,
        edges: stats.total,
        alive: stats.alive,
        round: stats.round,
        pendingGloss: this.pendingGloss(999).length,
        blocked: this.blocked.size,
        custom: this.custom.size,
        tierDist: byS.map((v) => v / totalS),
      },
      warnings: this.warnings(byS, totalS),
    }
  }

  warnings(byS, totalS) {
    const out = []
    const s3 = (byS[3] || 0) / totalS
    if (s3 > 0.05) out.push('重要性 s=3 的边占比 ' + (s3 * 100).toFixed(1) + '%，超过 5% 会让图快速饱和')
    return out
  }
}