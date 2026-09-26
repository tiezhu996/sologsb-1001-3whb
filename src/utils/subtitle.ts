import type { Cue } from '../types'
import { makeId } from './id'

export const formatTime = (seconds: number, separator = ','): string => {
  const safe = Math.max(0, seconds)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  const ms = Math.round((safe - Math.floor(safe)) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`
}

// 可作为断句点的标点（切点在标点之后），以及空白；强标点在等距时优先
const SPLIT_PUNCTUATION = new Set('，。！？；：、,.!?;:…—–')
const STRONG_PUNCTUATION = new Set('。！？!?；;')
const HALF_WIDTH_PUNCTUATION = new Set(',.!?;:-–')
const CJK_CHAR = /[㐀-鿿]/

/**
 * 在文本中寻找最接近 targetRatio 的切点：优先标点（句号等强标点等距优先），
 * 其次空白，最后才按比例硬切。切点永远落在 1..length-1 之间。
 */
const nearestCut = (text: string, targetRatio: number): number => {
  const length = text.length
  if (length <= 1) return length
  const target = length * targetRatio
  let best: { index: number; distance: number; strong: boolean } | null = null
  const spaces: number[] = []
  for (let i = 0; i < length; i += 1) {
    const char = text[i]
    if (SPLIT_PUNCTUATION.has(char)) {
      const index = i + 1
      if (index <= 0 || index >= length) continue
      const distance = Math.abs(index - target)
      const strong = STRONG_PUNCTUATION.has(char)
      if (!best || distance < best.distance || (distance === best.distance && strong && !best.strong)) {
        best = { index, distance, strong }
      }
    } else if (/\s/.test(char) && i > 0 && i < length) {
      spaces.push(i)
    }
  }
  if (best) return best.index
  if (spaces.length) {
    return spaces.reduce((pick, index) => (Math.abs(index - target) < Math.abs(pick - target) ? index : pick), spaces[0])
  }
  return Math.max(1, Math.min(length - 1, Math.round(target)))
}

export interface BilingualSplit {
  sourceBefore: string
  sourceAfter: string
  targetBefore: string
  targetAfter: string
  ratio: number
}

/** 原文在最接近中点的标点处断开，译文在同一比例附近的标点处跟随断开。 */
export const splitBilingual = (source: string, target: string): BilingualSplit => {
  const sourceCut = source ? nearestCut(source, 0.5) : 0
  const ratio = source.length ? sourceCut / source.length : 0.5
  const targetCut = target ? nearestCut(target, ratio) : 0
  return {
    sourceBefore: source.slice(0, sourceCut).trim(),
    sourceAfter: source.slice(sourceCut).trim(),
    targetBefore: target.slice(0, targetCut).trim(),
    targetAfter: target.slice(targetCut).trim(),
    ratio,
  }
}

/** 合并两段台词文本：顺接标点、去重接头标点，中文直接相接、西文保留一个空格。 */
export const joinCueText = (first: string, second: string): string => {
  const left = first.trim()
  const rightRaw = second.trim()
  if (!left) return rightRaw
  if (!rightRaw) return left
  let right = rightRaw
  const lastChar = left[left.length - 1]
  const firstChar = right[0]
  // 接头标点重复（含「……」这类重复标点串）时只保留一组
  if (SPLIT_PUNCTUATION.has(lastChar) && firstChar === lastChar) {
    const escaped = lastChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    right = right.replace(new RegExp(`^${escaped}+`), '').trimStart()
  }
  if (!right) return left
  const nextChar = right[0]
  if (SPLIT_PUNCTUATION.has(lastChar)) {
    // 半角标点后按西文习惯加空格；全角标点直接相接
    return HALF_WIDTH_PUNCTUATION.has(lastChar) ? `${left} ${right}` : `${left}${right}`
  }
  const cjkJunction = CJK_CHAR.test(lastChar) || CJK_CHAR.test(nextChar)
  return cjkJunction ? `${left}${right}` : `${left} ${right}`
}

export const parseTime = (value: string): number => {
  const normalized = value.trim().replace(',', '.')
  const parts = normalized.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return Number(normalized) || 0
}

export const parseSrt = (text: string, actorId = 'actor-narrator'): Cue[] => {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/)
  const parsed: Cue[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean)
    const timeLineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeLineIndex < 0) continue
    const [from, to] = lines[timeLineIndex].split('-->').map((part) => part.trim().split(' ')[0])
    const content = lines.slice(timeLineIndex + 1).join('\n').trim()
    if (!content) continue
    parsed.push({
      id: makeId('cue'),
      start: parseTime(from),
      end: parseTime(to),
      source: content,
      target: '',
      actorId,
      speed: 1,
      termIds: [],
      status: 'draft',
      locked: false,
    })
  }
  return parsed
}

export const parseScript = (text: string, actors: { id: string; name: string }[]): Cue[] => {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean)
  const result: Cue[] = []
  lines.forEach((line, index) => {
    const match = line.match(/^([^：:]{1,18})[：:]\s*(.+)$/)
    const actorName = match?.[1]?.trim()
    const content = match?.[2]?.trim() || line
    const actor = actors.find((item) => item.name === actorName) ?? actors[0]
    result.push({
      id: makeId('cue'),
      start: index * 4,
      end: index * 4 + 3.5,
      source: content,
      target: '',
      actorId: actor?.id ?? 'actor-narrator',
      speed: 1,
      termIds: [],
      status: 'draft',
      locked: false,
    })
  })
  return result
}

export const toSrt = (cues: Cue[]): string =>
  [...cues]
    .sort((a, b) => a.start - b.start)
    .map((cue, index) => `${index + 1}\n${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${cue.target || cue.source}`)
    .join('\n\n') + '\n'
