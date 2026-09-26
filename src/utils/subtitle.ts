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

type SplitStrength = 'sentence' | 'clause' | 'word'

interface CutScan {
  sentence: number[]
  clause: number[]
  word: number[]
}

// 句末标点（中英日）后可断；句号需后跟空白，避免切开 0.5 这类数字
const SENTENCE_CUT = /[…。！？!?]+[」』”’"']?|\.(?=\s)/g
// 句中标点（逗号、顿号、分号、冒号、破折号）后可断
const CLAUSE_CUT = /[，、；：,;—–]+[」』”’"']?/g
// 拉丁系语言按词间断行
const WORD_CUT = / +/g

const scanCuts = (text: string): CutScan => {
  const collect = (regex: RegExp): number[] => {
    const indices: number[] = []
    for (const match of text.matchAll(regex)) {
      const index = match.index! + match[0].length
      if (index >= 1 && index < text.length) indices.push(index)
    }
    return indices
  }
  return { sentence: collect(SENTENCE_CUT), clause: collect(CLAUSE_CUT), word: collect(WORD_CUT) }
}

const nearestTo = (indices: number[], target: number): number =>
  indices.reduce((best, index) => (Math.abs(index - target) < Math.abs(best - target) ? index : best), indices[0])

export interface SplitPlan {
  sourceIndex: number
  targetIndex: number
}

/**
 * 在原文的标点处找拆分点（优先句末标点、再句中标点，都要求尽量靠近中段；
 * 标点只出现在两端时退而取最近的标点，拉丁文本最后退到词间空格）。
 * 译文优先跟随“同序号、同级别的标点”，找不到时再按同一套规则自行选点，
 * 保证词和译文都不会断在中间。
 */
export const planSplit = (sourceRaw: string, targetRaw: string): SplitPlan | null => {
  const source = sourceRaw.trim()
  if (source.length < 2) return null
  const scan = scanCuts(source)
  const mid = source.length / 2
  const low = Math.round(source.length * 0.2)
  const high = Math.round(source.length * 0.8)

  const tiers: { indices: number[]; strength: Exclude<SplitStrength, 'word'> }[] = [
    { indices: scan.sentence, strength: 'sentence' },
    { indices: scan.clause, strength: 'clause' },
  ]
  let sourceIndex = -1
  let strength: SplitStrength = 'word'
  let ordinal = 0
  const inRange = (indices: number[]) => indices.filter((index) => index >= low && index <= high)
  for (const tier of tiers) {
    const pool = inRange(tier.indices)
    if (pool.length) {
      sourceIndex = nearestTo(pool, mid)
      strength = tier.strength
      ordinal = tier.indices.indexOf(sourceIndex) + 1
      break
    }
  }
  if (sourceIndex < 0) {
    for (const tier of tiers) {
      if (tier.indices.length) {
        sourceIndex = nearestTo(tier.indices, mid)
        strength = tier.strength
        ordinal = tier.indices.indexOf(sourceIndex) + 1
        break
      }
    }
  }
  if (sourceIndex < 0) {
    const wordPool = inRange(scan.word).length ? inRange(scan.word) : scan.word
    if (wordPool.length) {
      sourceIndex = nearestTo(wordPool, mid)
      strength = 'word'
    }
  }
  if (sourceIndex < 0) return null

  const target = targetRaw.trim()
  let targetIndex = target.length
  if (target.length >= 2) {
    const targetScan = scanCuts(target)
    const sameTier = strength === 'sentence' ? targetScan.sentence : strength === 'clause' ? targetScan.clause : []
    if (ordinal > 0 && sameTier[ordinal - 1] !== undefined) {
      targetIndex = sameTier[ordinal - 1]
    } else {
      const targetMid = target.length / 2
      const targetLow = Math.round(target.length * 0.2)
      const targetHigh = Math.round(target.length * 0.8)
      const balanced = (indices: number[]) => indices.filter((index) => index >= targetLow && index <= targetHigh)
      const preferred = balanced(targetScan.sentence)
        .concat(balanced(targetScan.clause))
        .concat(targetScan.sentence, targetScan.clause)
        .concat(balanced(targetScan.word), targetScan.word)
      if (preferred.length) targetIndex = nearestTo(preferred, targetMid)
    }
  }

  return { sourceIndex, targetIndex }
}

const CJK_TEXT = /[㐀-䶿一-鿿぀-ヿ]/
const LEADING_SEPARATOR = /^[，、；：,;:\s]+/
const ENDS_WITH_SENTENCE = /[…。！？!?\.]["」』”’]?$/
const ENDS_WITH_CLAUSE = /[，、；：,;—–]["」』”’]?$/

/** 合并两段台词文本：顺着已有标点相接，缺标点时按中日英习惯补上，不重复加标点。 */
export const joinCueText = (leftRaw: string, rightRaw: string): string => {
  const left = leftRaw.trim()
  const right = rightRaw.trim().replace(LEADING_SEPARATOR, '')
  if (!left) return right
  if (!right) return left
  if (ENDS_WITH_SENTENCE.test(left) || ENDS_WITH_CLAUSE.test(left)) return left + right
  if (CJK_TEXT.test(left) || CJK_TEXT.test(right)) return `${left}，${right}`
  return `${left} ${right}`
}

export const toSrt = (cues: Cue[]): string =>
  [...cues]
    .sort((a, b) => a.start - b.start)
    .map((cue, index) => `${index + 1}\n${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${cue.target || cue.source}`)
    .join('\n\n') + '\n'
