import { defineStore } from 'pinia'
import type { Cue, EditorDocument, Locale, Snapshot } from '../types'
import { loadDocument, saveDocument } from '../utils/db'
import { makeId } from '../utils/id'
import { joinCueText, parseScript, parseSrt, splitBilingual, toSrt } from '../utils/subtitle'
import { translate, type MessageKey } from '../i18n'

const DOCUMENT_ID = 'subtitle-dubbing-document'
let saveTimer: ReturnType<typeof setTimeout> | undefined
let channel: BroadcastChannel | undefined

const cloneCues = (cues: Cue[]): Cue[] => JSON.parse(JSON.stringify(cues)) as Cue[]
const plainDocument = (document: EditorDocument): EditorDocument => JSON.parse(JSON.stringify(document)) as EditorDocument

const createDefaultDocument = (): EditorDocument => ({
  id: DOCUMENT_ID,
  title: '纪录片《开源之路》中文配音',
  language: 'zh-CN',
  revision: 0,
  updatedAt: Date.now(),
  lastWriter: '',
  actors: [
    { id: 'actor-narrator', name: '旁白 / Narrator', color: '#2f6fed', localeHint: 'zh-CN' },
    { id: 'actor-lin', name: '林博士 / Dr. Lin', color: '#cf5a39', localeHint: 'zh-CN' },
    { id: 'actor-chen', name: '陈工 / Engineer Chen', color: '#14866d', localeHint: 'zh-CN' },
    { id: 'actor-host', name: '主持人 / Host', color: '#7d53b8', localeHint: 'zh-CN' },
  ],
  terms: [
    { id: 'term-01', source: 'open source', target: '开源', note: '产品语境' },
    { id: 'term-02', source: 'maintainer', target: '维护者', note: '不使用“管理者”' },
    { id: 'term-03', source: 'pull request', target: '拉取请求', note: '首次出现保留英文缩写 PR' },
    { id: 'term-04', source: 'community', target: '社区', note: '泛指开发者社区' },
  ],
  cues: [
    { id: 'cue-demo-01', start: 0, end: 4.2, source: '开源并不是一项孤立的技术，而是一种持续协作的方式。', target: '开源并不是一项孤立的技术，而是一种持续协作的方式。', actorId: 'actor-narrator', speed: 1.02, termIds: ['term-01'], status: 'reviewed', locked: true },
    { id: 'cue-demo-02', start: 4.3, end: 8.6, source: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', target: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', actorId: 'actor-host', speed: 1, termIds: ['term-04', 'term-02'], status: 'reviewed', locked: false },
    { id: 'cue-demo-03', start: 8.8, end: 13.5, source: '每个拉取请求背后，都有一段需要被理解的上下文。', target: '每个拉取请求背后，都有一段需要被理解的上下文。', actorId: 'actor-lin', speed: 0.96, termIds: ['term-03'], status: 'reviewed', locked: false },
    { id: 'cue-demo-04', start: 13.7, end: 18.8, source: '请您先介绍一次印象最深的代码评审。', target: '请您先介绍一次印象最深的代码评审。', actorId: 'actor-host', speed: 1.03, termIds: [], status: 'draft', locked: false },
    { id: 'cue-demo-05', start: 19, end: 25.1, source: '那次修改很小，却让新用户第一次能够顺利完成安装。', target: '那次修改很小，却让新用户第一次顺利完成安装。', actorId: 'actor-lin', speed: 0.98, termIds: [], status: 'issue', locked: false },
    { id: 'cue-demo-06', start: 25.4, end: 31.2, source: '所以我们决定把安装说明拆开，并为每个平台补上验证步骤。', target: '因此，我们拆分安装说明，并为每个平台补上验证步骤。', actorId: 'actor-chen', speed: 1.05, termIds: [], status: 'draft', locked: false },
  ],
  snapshots: [],
})

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict'

export const useEditorStore = defineStore('subtitle-editor', {
  state: () => ({
    document: createDefaultDocument(),
    selectedCueId: 'cue-demo-03' as string | null,
    actorFilter: 'all',
    timelineZoom: 1,
    saveState: 'saved' as SaveState,
    saving: false,
    initialized: false,
    conflict: false,
    online: navigator.onLine,
    tabId: makeId('tab'),
    lastSeenRevision: 0,
    mutationSerial: 0,
    past: [] as { label: string; cues: Cue[]; selectedCueId: string | null }[],
    future: [] as { label: string; cues: Cue[]; selectedCueId: string | null }[],
  }),
  getters: {
    t: (state) => (key: MessageKey, values?: Record<string, string | number>) => translate(state.document.language, key, values),
    selectedCue(state): Cue | undefined {
      return state.document.cues.find((cue) => cue.id === state.selectedCueId)
    },
    visibleCues(state): Cue[] {
      return state.actorFilter === 'all'
        ? state.document.cues
        : state.document.cues.filter((cue) => cue.actorId === state.actorFilter)
    },
    totalDuration(state): number {
      return Math.max(10, ...state.document.cues.map((cue) => cue.end)) * 1.04
    },
  },
  actions: {
    async initialize() {
      if (this.initialized) return
      this.online = navigator.onLine
      const stored = await loadDocument(DOCUMENT_ID)
      if (stored) {
        this.document = stored
        this.lastSeenRevision = stored.revision
      } else {
        const saved = await saveDocument(plainDocument(this.document))
        this.document = saved
        this.lastSeenRevision = saved.revision
      }
      this.initialized = true
      if ('BroadcastChannel' in window) {
        channel = new BroadcastChannel('sologsb-1001-document')
        channel.onmessage = async (event) => {
          const message = event.data as { type: string; tabId: string; revision: number; documentId: string }
          if (message.type !== 'document-updated' || message.tabId === this.tabId || message.documentId !== DOCUMENT_ID) return
          if (message.revision <= this.lastSeenRevision) return
          if (this.saveState === 'dirty' || this.saveState === 'saving' || this.conflict) {
            this.conflict = true
            this.saveState = 'conflict'
            return
          }
          const latest = await loadDocument(DOCUMENT_ID)
          if (latest && latest.revision > this.lastSeenRevision) {
            this.document = latest
            this.lastSeenRevision = latest.revision
            this.saveState = 'saved'
          }
        }
      }
    },
    setOnline(value: boolean) {
      this.online = value
    },
    selectCue(id: string | null) {
      this.selectedCueId = id
    },
    setLocale(locale: Locale) {
      this.document.language = locale
      this.markChanged('language', true)
    },
    commit(label: string, mutate: (cues: Cue[]) => void, nextSelection?: string | null) {
      const before = cloneCues(this.document.cues)
      const working = cloneCues(this.document.cues)
      mutate(working)
      this.past.push({ label, cues: before, selectedCueId: this.selectedCueId })
      if (this.past.length > 60) this.past.shift()
      this.future = []
      this.document.cues = working
      if (nextSelection !== undefined) this.selectedCueId = nextSelection
      this.markChanged(label)
    },
    markChanged(label: string, persist = true) {
      this.document.updatedAt = Date.now()
      if (persist) {
        this.saveState = 'dirty'
        this.mutationSerial += 1
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => void this.persist(label), 500)
      }
    },
    async persist(label = 'autosave') {
      if (!this.initialized || this.conflict || this.saveState === 'saving') return
      const serial = this.mutationSerial
      this.saveState = 'saving'
      this.saving = true
      try {
        const next = await saveDocument({ ...plainDocument(this.document), lastWriter: this.tabId }, this.lastSeenRevision)
        this.document.revision = next.revision
        this.document.updatedAt = next.updatedAt
        this.lastSeenRevision = next.revision
        if (serial === this.mutationSerial) {
          this.saveState = 'saved'
        } else {
          this.saveState = 'dirty'
        }
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: DOCUMENT_ID })
      } catch (error) {
        if (error instanceof Error && error.message === 'REVISION_CONFLICT') {
          this.conflict = true
          this.saveState = 'conflict'
        } else {
          this.saveState = 'dirty'
          console.error(label, error)
        }
      } finally {
        this.saving = false
        if (this.saveState === 'dirty') {
          if (saveTimer) clearTimeout(saveTimer)
          saveTimer = setTimeout(() => void this.persist(label), 700)
        }
      }
    },
    async keepMine() {
      try {
        this.saving = true
        const latest = await loadDocument(DOCUMENT_ID)
        const expected = latest?.revision ?? this.lastSeenRevision
        const next = await saveDocument({ ...plainDocument(this.document), lastWriter: this.tabId }, expected)
        this.document.revision = next.revision
        this.lastSeenRevision = next.revision
        this.conflict = false
        this.saveState = 'saved'
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: DOCUMENT_ID })
      } finally {
        this.saving = false
      }
    },
    async loadLatest() {
      const latest = await loadDocument(DOCUMENT_ID)
      if (!latest) return
      this.document = latest
      this.lastSeenRevision = latest.revision
      this.conflict = false
      this.saveState = 'saved'
      this.selectedCueId = latest.cues[0]?.id ?? null
    },
    undo() {
      const entry = this.past.pop()
      if (!entry) return
      this.future.push({ label: entry.label, cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`undo:${entry.label}`)
    },
    redo() {
      const entry = this.future.pop()
      if (!entry) return
      this.past.push({ label: entry.label, cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`redo:${entry.label}`)
    },
    updateCue(id: string, patch: Partial<Cue>, historyLabel = 'update-cue') {
      this.commit(historyLabel, (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        Object.assign(cue, patch)
      })
    },
    markStatus(id: string, status: Cue['status']) {
      this.updateCue(id, { status }, `status:${status}`)
    },
    toggleLock(id: string) {
      this.updateCue(id, { locked: !this.document.cues.find((cue) => cue.id === id)?.locked }, 'toggle-lock')
    },
    splitCue(id: string): MessageKey | null {
      const source = this.document.cues.find((cue) => cue.id === id)
      if (!source) return null
      if (source.locked) return 'lockedSplit'
      const split = splitBilingual(source.source, source.target)
      // 两条都必须留下非空文本，否则没有可断开的内容
      if (!split.sourceBefore || !split.sourceAfter) return 'splitUnavailable'
      const middle = Number((source.start + (source.end - source.start) * split.ratio).toFixed(2))
      if (middle <= source.start + 0.2 || middle >= source.end - 0.2) return 'splitTooShort'
      const terms = this.document.terms
      const partTerms = (part: string, other: string, isFirst: boolean): string[] => source.termIds.filter((termId) => {
        const term = terms.find((item) => item.id === termId)
        if (!term) return false
        const hit = (text: string) => text.includes(term.target) || text.toLowerCase().includes(term.source.toLowerCase())
        const inPart = hit(part)
        const inOther = hit(other)
        if (inPart && !inOther) return true
        if (!inPart && inOther) return false
        // 两段都含（或都不含）时统一保留在前段，避免重复或丢失
        return isFirst
      })
      const firstText = `${split.sourceBefore}${split.targetBefore}`
      const secondText = `${split.sourceAfter}${split.targetAfter}`
      const firstTerms = partTerms(firstText, secondText, true)
      const secondTerms = partTerms(secondText, firstText, false)
      const secondEnd = source.end
      const secondId = makeId('cue')
      this.commit('split', (cues) => {
        const index = cues.findIndex((cue) => cue.id === id)
        const cue = cues[index]
        const second: Cue = {
          ...cue,
          id: secondId,
          start: middle,
          end: secondEnd,
          source: split.sourceAfter,
          target: split.targetAfter,
          termIds: secondTerms,
          status: 'draft',
          locked: false,
        }
        cue.end = middle
        cue.source = split.sourceBefore
        cue.target = split.targetBefore
        cue.termIds = firstTerms
        cue.status = 'draft'
        cues.splice(index + 1, 0, second)
      }, secondId)
      return null
    },
    mergeNext(id: string): MessageKey | null {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const current = this.document.cues[index]
      const next = this.document.cues[index + 1]
      if (!current || !next) return null
      if (current.locked) return 'lockedMergeCurrent'
      if (next.locked) return 'lockedMergeNext'
      this.commit('merge', (cues) => {
        const item = cues[index]
        const following = cues[index + 1]
        item.end = following.end
        item.source = joinCueText(item.source, following.source)
        item.target = joinCueText(item.target, following.target)
        // 合并两条的关联术语并去重，顺序以当前条为先
        item.termIds = [...new Set([...item.termIds, ...following.termIds])]
        item.status = 'draft'
        cues.splice(index + 1, 1)
      }, id)
      return null
    },
    moveCue(id: string, direction: -1 | 1): MessageKey | null {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const target = index + direction
      if (index < 0) return null
      if (this.document.cues[index].locked) return 'lockedMove'
      if (target < 0 || target >= this.document.cues.length) return 'moveBoundary'
      if (this.document.cues[target].locked) return 'lockedMoveNeighbor'
      this.commit('move', (cues) => {
        // 与相邻条互换时间段（各自时长不变），同时交换数组位置，
        // 保证列表、时间轴与 SRT 导出顺序一致
        const item = cues[index]
        const neighbor = cues[target]
        const itemStart = item.start
        const itemEnd = item.end
        item.start = neighbor.start
        item.end = neighbor.end
        neighbor.start = itemStart
        neighbor.end = itemEnd
        const [removed] = cues.splice(index, 1)
        cues.splice(target, 0, removed)
      }, id)
      return null
    },
    deleteCue(id: string): MessageKey | null {
      const cue = this.document.cues.find((item) => item.id === id)
      if (!cue) return null
      if (cue.locked) return 'lockedDelete'
      this.commit('delete', (cues) => {
        const index = cues.findIndex((item) => item.id === id)
        if (index >= 0) cues.splice(index, 1)
      }, this.document.cues[Math.max(0, this.document.cues.findIndex((item) => item.id === id) - 1)]?.id ?? null)
      return null
    },
    createSnapshot(name: string) {
      const snapshot: Snapshot = { id: makeId('snapshot'), name: name.trim() || `v${this.document.snapshots.length + 1}`, createdAt: Date.now(), cues: cloneCues(this.document.cues) }
      this.document.snapshots.unshift(snapshot)
      this.markChanged('snapshot', true)
    },
    restoreSnapshot(id: string) {
      const snapshot = this.document.snapshots.find((item) => item.id === id)
      if (!snapshot) return
      this.past.push({ label: 'restore-snapshot', cues: cloneCues(this.document.cues), selectedCueId: this.selectedCueId })
      this.future = []
      this.document.cues = cloneCues(snapshot.cues)
      this.selectedCueId = this.document.cues[0]?.id ?? null
      this.markChanged('restore-snapshot')
    },
    importText(text: string, filename: string) {
      const lower = filename.toLowerCase()
      const cues = lower.endsWith('.srt') ? parseSrt(text) : parseScript(text, this.document.actors)
      if (!cues.length) throw new Error('EMPTY_IMPORT')
      this.commit('import', (current) => {
        current.splice(0, current.length, ...cues)
      }, cues[0].id)
      return cues.length
    },
    exportSrt() {
      const blob = new Blob([toSrt(this.document.cues)], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${this.document.title || 'subtitle'}.srt`
      anchor.click()
      URL.revokeObjectURL(url)
    },
  },
})
