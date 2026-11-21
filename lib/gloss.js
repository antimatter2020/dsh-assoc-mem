/**
 * 解释相关的公共常量与「手动粘贴」解析。
 *
 * 注意：从 2026-11-21 起，解释**不再靠系统提示催促主对话模型**。
 * 插件自己调 ctx.llm.stream() 要解释（见 lib/explain.js），
 * 因此这里的 buildExplainInstruction 已删除——留着只会让人以为
 * 还有一条「让模型写段落」的通路。
 *
 * 仍然保留 parseGlossReply：界面上的「从文本导入解释」和旧数据迁移还要用。
 */

const GLOSS_MAX = 20

/**
 * 逐条冷却的轮数：某一条解释问过之后，N 轮内不再重复问它。
 * 记录在 store 的 glossAsked / edgeAsked 里。
 */
export const GLOSS_COOLDOWN_TURNS = 10

export function needGloss(pending) {
  return Array.isArray(pending) && pending.length > 0
}

const HEADER = /^\s*(?:\u8865\u5145\u89e3\u91ca|\u540d\u8bcd\u89e3\u91ca)\s*[:\uff1a]\s*(.*)$/

/** 文本里有没有出现过「补充解释：」标题 */
export function hasGlossSection(text) {
  return String(text || '').split(/\r?\n/).some((l) => HEADER.test(l.trim()))
}

/**
 * 解析「补充解释：」段落里的「词 —— 解释」行。
 * 用于界面手动粘贴，以及把用户历史里已有的段落补录进库。
 */
export function parseGlossReply(text) {
  const lines = String(text || '').split(/\r?\n/)
  let armed = false
  const items = []
  const rejects = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const h = line.match(HEADER)
    if (h) {
      armed = true
      const rest = h[1].trim()
      if (rest) collect(rest, items, rejects)
      continue
    }
    if (!armed) continue
    if (/^\s*(?:\u5173\u7cfb\u89e3\u91ca|\u8fb9\u89e3\u91ca)\s*[:\uff1a]/.test(line) || /^[\u3010#]/.test(line)) break
    collect(line, items, rejects)
  }
  return { items, rejects }
}

function collect(line, items, rejects) {
  const m = line.match(/^\s*[-*\u00b7]?\s*([^\u2014\-:\uff1a]{1,20}?)\s*(?:\u2014\u2014|\u2014|--|[:\uff1a])\s*(.+)$/)
  if (!m) return
  const word = m[1].trim()
  const body = m[2].trim().replace(/^["'\u300c]|["'\u300d]$/g, '')
  if (!word || !body) return
  if (/^\u975e\u540d\u8bcd/.test(body) || /^\u4e0d\u662f\u540d\u8bcd/.test(body)) { rejects.push(word); return }
  items.push({ word, gloss: body.length > GLOSS_MAX ? body.slice(0, GLOSS_MAX) : body })
}

/** 兼容旧调用：解析「关系解释：」段落（界面手动粘贴时用） */
const EDGE_HEADER = /^\s*(?:\u5173\u7cfb\u89e3\u91ca|\u8fb9\u89e3\u91ca)\s*[:\uff1a]\s*(.*)$/

export function parseEdgeReply(text) {
  const lines = String(text || '').split(/\r?\n/)
  let armed = false
  const items = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const h = line.match(EDGE_HEADER)
    if (h) {
      armed = true
      const rest = h[1].trim()
      if (rest) collectEdge(rest, items)
      continue
    }
    if (!armed) continue
    if (/^[\u3010#]/.test(line)) break
    collectEdge(line, items)
  }
  return items
}

function collectEdge(line, items) {
  const m = line.match(/^\s*[-*\u00b7]?\s*(.+?)\s*(?:\u2014\u2014|\u2014|--|[:\uff1a])\s*(.+)$/)
  if (!m) return
  const pair = m[1].trim().replace(/[\s\u3001]/g, '')
  const body = m[2].trim()
  if (!pair || !body) return
  const parts = pair.split(/[-\uff0d\u2013]/)
  if (parts.length !== 2) return
  const a = parts[0].trim()
  const b = parts[1].trim()
  if (!a || !b || a === b) return
  items.push({ a, b, gloss: body.length > GLOSS_MAX ? body.slice(0, GLOSS_MAX) : body })
}