<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { store, state } from '@/logic/store'
import { PAPER_KINDS, SHEET_PRESETS, type Sheet } from '@/logic/types'
import {
  assessCalibration,
  buildCalibrationArtifact,
  computeCalibration,
  defaultNominal,
  diffHistory,
  formatDate,
  paperKeyOf,
  validateNominal,
  SCALE_HARD_MIN,
  SCALE_HARD_MAX,
  type CalibrationArtifact,
  type CalibrationHistoryEntry,
  type CalibrationMeasured,
  type CalibrationNominal,
  type CalibrationProfile,
} from '@/logic/calibration'
import { uid } from '@/logic/geometry'
import { downloadText, sanitizeFilename } from '@/logic/download'

const route = useRoute()
const router = useRouter()

const projectId = computed(() => (route.params.id ? String(route.params.id) : null))
const project = computed(() => (projectId.value ? store.getProject(projectId.value) : null))
const material = computed(() => (project.value ? store.materialOf(project.value) : null))

const profiles = computed(() => state.calibrations)
const active = computed(() => profiles.value.filter((p) => !p.archived))
const archived = computed(() => profiles.value.filter((p) => p.archived))

function paperLabel(code: string): string {
  return PAPER_KINDS.find((p) => p.paper === code)?.label ?? code
}

/** 按机器分组的档案（留档对比用） */
const grouped = computed(() => {
  const map = new Map<string, { machine: string; items: CalibrationProfile[] }>()
  for (const p of [...active.value, ...archived.value]) {
    const g = map.get(p.machine) ?? { machine: p.machine, items: [] }
    g.items.push(p)
    map.set(p.machine, g)
  }
  for (const g of map.values()) g.items.sort((a, b) => b.updatedAt - a.updatedAt)
  return Array.from(map.values())
})

// ---------------- 新建 / 再校准表单 ----------------

type Mode = { kind: 'new' } | { kind: 'recal'; id: string }
const mode = ref<Mode>({ kind: 'new' })
const expandedId = ref<string | null>(null)

const machine = ref('一号刻字机')
const paperCode = ref('cardstock')
const customPaper = ref('')
const sheet = ref<Sheet>(project.value ? { ...project.value.sheet } : { ...SHEET_PRESETS[0] })
const lenX = ref(150)
const lenY = ref(150)
const originX = ref(30)
const originY = ref(30)
const mLenX = ref(150)
const mLenY = ref(150)
const mOriginX = ref(30)
const mOriginY = ref(30)
const warnPct = ref(2)
const note = ref('')
const saveMsg = ref('')
const acknowledged = ref(false)

/** 从项目上下文带入纸张 / 纸幅 */
function initFromProject(): void {
  const p = project.value
  if (!p) return
  sheet.value = { ...p.sheet }
  const m = material.value
  if (m) {
    paperCode.value = PAPER_KINDS.some((k) => k.paper === m.paper) ? m.paper : 'cardstock'
    const exist = active.value.find((c) => c.id === p.calibrationId)
    if (exist) machine.value = exist.machine
  }
  const n = defaultNominal(p.sheet)
  lenX.value = n.lenX
  lenY.value = n.lenY
  originX.value = n.originX
  originY.value = n.originY
  mLenX.value = n.lenX
  mLenY.value = n.lenY
  mOriginX.value = n.originX
  mOriginY.value = n.originY
}
initFromProject()

const paperName = computed(() => (paperCode.value === 'custom' ? customPaper.value.trim() || '自定义纸' : paperLabel(paperCode.value)))
const pKey = computed(() => paperKeyOf(paperCode.value === 'custom' ? customPaper.value.trim() || 'custom' : paperCode.value, sheet.value))

const nominal = computed<CalibrationNominal>(() => ({
  sheet: { ...sheet.value },
  lenX: Number(lenX.value) || 0,
  lenY: Number(lenY.value) || 0,
  originX: Number(originX.value) || 0,
  originY: Number(originY.value) || 0,
}))

const measured = computed<CalibrationMeasured>(() => ({
  lenX: Number(mLenX.value) || 0,
  lenY: Number(mLenY.value) || 0,
  originX: Number(mOriginX.value) || 0,
  originY: Number(mOriginY.value) || 0,
}))

const nominalError = computed(() => validateNominal(nominal.value))

const measuredError = computed(() => {
  const m = measured.value
  if (m.lenX <= 0 || m.lenY <= 0) return '实测长度必须大于 0'
  if (m.originX < 0 || m.originY < 0) return '原点实测距离不能为负'
  if (m.lenX < nominal.value.lenX * SCALE_HARD_MIN || m.lenX > nominal.value.lenX * SCALE_HARD_MAX) {
    return `横向实测 ${m.lenX}mm 偏离名义值超过 ±20%，请确认测量的是两条端刻度之间、数值单位为 mm`
  }
  if (m.lenY < nominal.value.lenY * SCALE_HARD_MIN || m.lenY > nominal.value.lenY * SCALE_HARD_MAX) {
    return `纵向实测 ${m.lenY}mm 偏离名义值超过 ±20%，请确认测量的是两条端刻度之间、数值单位为 mm`
  }
  return null
})

const result = computed(() => computeCalibration(nominal.value, measured.value))
const assess = computed(() => assessCalibration(result.value, sheet.value, warnPct.value))

/** 同机器 + 同纸是否已有生效档案（不允许重复建档，应走再校准） */
const duplicateActive = computed(() => {
  if (mode.value.kind !== 'new') return null
  return active.value.find((c) => c.machine.trim() === machine.value.trim() && c.paperKey === pKey.value) ?? null
})

const artifact = computed<CalibrationArtifact | null>(() => {
  if (nominalError.value) return null
  return buildCalibrationArtifact(nominal.value, machine.value.trim() || '机器', paperName.value)
})

// ---------------- 模式切换 ----------------

function startNew(): void {
  mode.value = { kind: 'new' }
  saveMsg.value = ''
  acknowledged.value = false
}

function startRecal(p: CalibrationProfile): void {
  mode.value = { kind: 'recal', id: p.id }
  machine.value = p.machine
  if (PAPER_KINDS.some((k) => k.paper === p.paperKey.split('@')[0])) paperCode.value = p.paperKey.split('@')[0]
  else {
    paperCode.value = 'custom'
    customPaper.value = p.paperLabel
  }
  sheet.value = { ...p.sheet }
  warnPct.value = p.warnPct
  const n = defaultNominal(p.sheet)
  lenX.value = p.current.nominal.lenX || n.lenX
  lenY.value = p.current.nominal.lenY || n.lenY
  originX.value = p.current.nominal.originX
  originY.value = p.current.nominal.originY
  mLenX.value = lenX.value
  mLenY.value = lenY.value
  mOriginX.value = originX.value
  mOriginY.value = originY.value
  note.value = ''
  acknowledged.value = false
  saveMsg.value = ''
}

function onSheetPreset(name: string): void {
  const s = SHEET_PRESETS.find((x) => x.name === name)
  if (s) sheet.value = { ...s }
}

// ---------------- 下载试切件 ----------------

function downloadPlt(): void {
  const a = artifact.value
  if (!a) return
  downloadText(`${sanitizeFilename(`${machine.value}_${paperName.value}`)}_校准试切.plt`, a.plt, 'text/plain;charset=utf-8')
}

function downloadGuide(): void {
  const a = artifact.value
  if (!a) return
  downloadText(`${sanitizeFilename(`${machine.value}_${paperName.value}`)}_校准说明.svg`, a.guideSvg, 'image/svg+xml;charset=utf-8')
}

// ---------------- 保存档案 ----------------

function buildEntry(): CalibrationHistoryEntry {
  const r = result.value
  return {
    at: Date.now(),
    note: note.value.trim(),
    nominal: JSON.parse(JSON.stringify(nominal.value)),
    measured: { ...measured.value },
    sx: r.sx,
    sy: r.sy,
    ox: r.ox,
    oy: r.oy,
    comp: { ...r.comp },
  }
}

const canSave = computed(() => !nominalError.value && !measuredError.value && machine.value.trim().length > 0)

function save(): void {
  saveMsg.value = ''
  if (!canSave.value) return
  if (assess.value.level !== 'ok' && !acknowledged.value) {
    saveMsg.value = '偏差超过阈值：已阻止直接保存。请先重新试切核对；确认数值无误后勾选「我已核对，确认存档」再保存。'
    return
  }
  const entry = buildEntry()
  if (mode.value.kind === 'recal') {
    const c = store.recalibrate(mode.value.id, entry)
    if (c) saveMsg.value = `已更新档案「${c.machine} · ${c.paperLabel}」，上一次校准已转入历史留档。`
  } else {
    if (duplicateActive.value) {
      saveMsg.value = `「${machine.value}」用这种纸已有生效档案，请用「再校准」更新，而不是新建重复档案。`
      return
    }
    const profile: CalibrationProfile = {
      id: uid('cal'),
      machine: machine.value.trim(),
      paperLabel: paperName.value,
      paperKey: pKey.value,
      sheet: { ...sheet.value },
      createdAt: entry.at,
      updatedAt: entry.at,
      current: entry,
      history: [],
      archived: false,
      note: note.value.trim(),
      warnPct: warnPct.value,
    }
    store.createCalibration(profile)
    if (project.value) store.setProjectCalibration(project.value, profile.id)
    saveMsg.value = `已建档「${profile.machine} · ${profile.paperLabel}」，并已应用到当前项目。`
    mode.value = { kind: 'recal', id: profile.id }
  }
  acknowledged.value = false
}

function applyToProject(p: CalibrationProfile): void {
  if (!project.value) {
    router.push('/')
    return
  }
  store.setProjectCalibration(project.value, p.id)
  saveMsg.value = `已把「${p.machine} · ${p.paperLabel}」应用到项目「${project.value.name}」。`
}

function removeArchive(p: CalibrationProfile): void {
  if (!confirm(`删除校准档案「${p.machine} · ${p.paperLabel}」及其全部历史记录？此操作不可恢复。`)) return
  store.deleteCalibration(p.id)
  if (mode.value.kind === 'recal' && mode.value.id === p.id) startNew()
}

function archive(p: CalibrationProfile): void {
  store.archiveCalibration(p.id)
}

function restore(p: CalibrationProfile): void {
  store.restoreCalibration(p.id)
}

function toggleExpand(id: string): void {
  expandedId.value = expandedId.value === id ? null : id
}

const pct = (v: number) => `${(v * 100).toFixed(3)}%`

type DiffView = { sxPct: string; syPct: string; ox: string; oy: string }

function diffOf(p: CalibrationProfile): DiffView | null {
  const d = diffHistory(p.current, p.history[0])
  if (!d) return null
  return {
    sxPct: (d.sxDelta * 100).toFixed(3),
    syPct: (d.syDelta * 100).toFixed(3),
    ox: d.oxDelta.toFixed(2),
    oy: d.oyDelta.toFixed(2),
  }
}
</script>

<template>
  <div class="page">
    <div class="page wide">
      <h1>机器校准（机器 × 纸张）</h1>
      <p class="hint">
        同一台机器切出来总比设计小一点、换一种纸又不一样：缩放与原点偏差随机器和纸张变化。
        按当前纸张导出一张带横、竖两条标准长度的试切件，切完把实测长度与起点位置填回来，
        系统算出横向 / 纵向缩放系数与原点偏移；一台机器 + 一种纸存成一条档案，导出刀路时先按档案补偿整张图再输出。
      </p>

      <div v-if="project" class="banner info">
        当前项目：<strong>{{ project.name }}</strong>｜当前纸幅 {{ project.sheet.widthMm }}×{{ project.sheet.heightMm }}mm
        <template v-if="material">｜材料 {{ material.name }}（{{ material.paper }}）</template>
        <span class="spacer"></span>
        <RouterLink :to="`/export/${project.id}`">返回导出</RouterLink>
      </div>
      <div v-if="saveMsg" class="banner ok">{{ saveMsg }}</div>

      <div class="cal-layout">
        <!-- 左：校准流程 -->
        <div>
          <div class="card">
            <div class="mode-switch">
              <button :class="{ active: mode.kind === 'new' }" @click="startNew">新机器 / 新纸建档</button>
              <button v-if="active.length" :class="{ active: mode.kind === 'recal' }" @click="startRecal(active[0])">再校准现有档案</button>
            </div>

            <h3>1. 机器与纸张</h3>
            <div class="edit-grid">
              <div class="field">
                <label>机器名</label>
                <input type="text" v-model="machine" :disabled="mode.kind === 'recal'" placeholder="如：一号刻字机" />
              </div>
              <div class="field">
                <label>纸张</label>
                <select v-model="paperCode" :disabled="mode.kind === 'recal'">
                  <option v-for="k in PAPER_KINDS" :key="k.paper" :value="k.paper">{{ k.label }}</option>
                  <option value="custom">自定义…</option>
                </select>
              </div>
              <div class="field" v-if="paperCode === 'custom'">
                <label>自定义纸张名</label>
                <input type="text" v-model="customPaper" :disabled="mode.kind === 'recal'" placeholder="如：180g 洒金红宣纸" />
              </div>
              <div class="field">
                <label>纸幅预设</label>
                <select :value="sheet.name" @change="onSheetPreset(($event.target as HTMLSelectElement).value)">
                  <option v-for="s in SHEET_PRESETS" :key="s.name" :value="s.name">{{ s.name }}（{{ s.widthMm }}×{{ s.heightMm }}）</option>
                  <option :value="sheet.name">当前纸幅</option>
                </select>
              </div>
              <div class="field">
                <label>纸宽（mm）</label>
                <input type="number" min="40" v-model.number="sheet.widthMm" />
              </div>
              <div class="field">
                <label>纸高（mm）</label>
                <input type="number" min="40" v-model.number="sheet.heightMm" />
              </div>
            </div>
            <div class="hint" v-if="mode.kind === 'recal'">
              再校准不改变机器与纸张；换了纸种请新建档案，旧档案会保留用于对比。
            </div>
            <div class="banner warn" v-if="duplicateActive">
              「{{ machine }}」+「{{ paperName }}」已有生效档案（{{ formatDate(duplicateActive.updatedAt) }}）。
              重新试切后应使用「再校准」更新该档案，避免一台机器一种纸出现多条互相冲突的档案。
            </div>

            <h3>2. 试切件尺寸（名义标准长度）</h3>
            <div class="edit-grid">
              <div class="field"><label>横线长度（mm）</label><input type="number" min="20" step="5" v-model.number="lenX" /></div>
              <div class="field"><label>竖线长度（mm）</label><input type="number" min="20" step="5" v-model.number="lenY" /></div>
              <div class="field"><label>起点距纸左边（mm）</label><input type="number" min="0" step="1" v-model.number="originX" /></div>
              <div class="field"><label>起点距纸下边（mm）</label><input type="number" min="0" step="1" v-model.number="originY" /></div>
            </div>
            <div class="banner err" v-if="nominalError">{{ nominalError }}</div>
            <div class="artifact-preview" v-if="artifact" v-html="artifact.guideSvg"></div>
            <div class="btn-row">
              <button class="primary" :disabled="!!nominalError" @click="downloadPlt">下载试切刀路 PLT</button>
              <button :disabled="!artifact" @click="downloadGuide">下载 1:1 说明书 SVG</button>
            </div>
            <div class="hint">试切 PLT 不做任何补偿（量的是机器真实误差）。用当前纸张、正常刀压速度切一遍，别缩放打印说明书。</div>

            <h3>3. 填回实测值（切完用直尺 / 卡尺量）</h3>
            <div class="edit-grid">
              <div class="field"><label>横线实测长度（mm）</label><input type="number" step="0.01" v-model.number="mLenX" /></div>
              <div class="field"><label>竖线实测长度（mm）</label><input type="number" step="0.01" v-model.number="mLenY" /></div>
              <div class="field"><label>起点实测距左边（mm）</label><input type="number" step="0.01" v-model.number="mOriginX" /></div>
              <div class="field"><label>起点实测距下边（mm）</label><input type="number" step="0.01" v-model.number="mOriginY" /></div>
              <div class="field"><label>偏差提醒阈值（%）</label><input type="number" min="0.5" step="0.5" v-model.number="warnPct" /></div>
              <div class="field grow2"><label>备注（可选）</label><input type="text" v-model="note" placeholder="如：换了新垫板 / 压纸轮调紧一格" /></div>
            </div>
            <div class="banner err" v-if="measuredError">{{ measuredError }}</div>

            <h3>4. 计算结果</h3>
            <div class="stat-grid">
              <div class="stat"><div class="k">横向缩放 sₓ</div><div class="v">{{ result.sx.toFixed(4) }}<small>{{ pct(result.sx) }}</small></div></div>
              <div class="stat"><div class="k">纵向缩放 s_y</div><div class="v">{{ result.sy.toFixed(4) }}<small>{{ pct(result.sy) }}</small></div></div>
              <div class="stat"><div class="k">纸角原点偏差 oₓ</div><div class="v">{{ result.ox.toFixed(2) }}<small>mm</small></div></div>
              <div class="stat"><div class="k">纸角原点偏差 o_y</div><div class="v">{{ result.oy.toFixed(2) }}<small>mm</small></div></div>
              <div class="stat"><div class="k">补偿 kₓ = 1/sₓ</div><div class="v">{{ result.comp.kx.toFixed(4) }}</div></div>
              <div class="stat"><div class="k">补偿 k_y = 1/s_y</div><div class="v">{{ result.comp.ky.toFixed(4) }}</div></div>
              <div class="stat"><div class="k">指令原点 tₓ = −oₓ/sₓ</div><div class="v">{{ result.comp.tx.toFixed(3) }}<small>mm</small></div></div>
              <div class="stat"><div class="k">指令原点 t_y = −o_y/s_y</div><div class="v">{{ result.comp.ty.toFixed(3) }}<small>mm</small></div></div>
            </div>

            <div v-for="(m, i) in assess.messages" :key="i" class="banner" :class="assess.level === 'bad' ? 'err' : 'warn'">{{ m }}</div>
            <div v-if="assess.level === 'ok'" class="banner ok">
              最大缩放偏差 {{ assess.maxScaleDevPct.toFixed(2) }}%，在阈值 {{ warnPct }}% 以内，可以存档使用。
            </div>

            <label class="check" v-if="assess.level !== 'ok'">
              <input type="checkbox" v-model="acknowledged" />
              我已重新核对试切件与实测数值，确认偏差真实存在，仍要保存此档案（导出时将继续强制提醒）
            </label>

            <div class="btn-row">
              <button class="primary" :disabled="!canSave" @click="save">
                {{ mode.kind === 'recal' ? '保存再校准（旧记录留档）' : '建立校准档案' }}
              </button>
              <button @click="startNew">清空重填</button>
            </div>
          </div>
        </div>

        <!-- 右：档案 -->
        <div>
          <div class="card">
            <h3>校准档案（{{ active.length }} 条生效 / {{ archived.length }} 条已归档）</h3>
            <div v-if="active.length === 0" class="empty">还没有档案。先在左侧切一张试切件，完成第一次校准。</div>
            <div v-for="g in grouped" :key="g.machine" class="machine-group">
              <div class="machine-head">{{ g.machine }}</div>
              <div v-for="p in g.items" :key="p.id" class="profile-card" :class="{ archived: p.archived, activeSel: project && project.calibrationId === p.id }">
                <div class="profile-head" @click="toggleExpand(p.id)">
                  <strong>{{ p.paperLabel }}</strong>
                  <span class="tag mono">sₓ {{ p.current.sx.toFixed(4) }}</span>
                  <span class="tag mono">s_y {{ p.current.sy.toFixed(4) }}</span>
                  <span class="tag" :class="assessCalibration(p.current, p.sheet, p.warnPct).level === 'ok' ? 'ok' : 'err'">
                    偏差 {{ assessCalibration(p.current, p.sheet, p.warnPct).maxScaleDevPct.toFixed(2) }}%
                  </span>
                  <span v-if="p.archived" class="tag warn">已归档</span>
                  <span v-if="project && project.calibrationId === p.id" class="tag accent">本项目使用中</span>
                  <span class="spacer"></span>
                  <span class="hint">{{ p.sheet.widthMm }}×{{ p.sheet.heightMm }}mm｜{{ formatDate(p.updatedAt) }}｜{{ p.history.length }} 次历史</span>
                </div>

                <div class="profile-body" v-show="expandedId === p.id">
                  <div class="stat-grid">
                    <div class="stat"><div class="k">纸角原点 oₓ / o_y</div><div class="v">{{ p.current.ox.toFixed(2) }} / {{ p.current.oy.toFixed(2) }}<small>mm</small></div></div>
                    <div class="stat"><div class="k">名义 横 / 纵</div><div class="v">{{ p.current.nominal.lenX }} / {{ p.current.nominal.lenY }}<small>mm</small></div></div>
                    <div class="stat"><div class="k">实测 横 / 纵</div><div class="v">{{ p.current.measured.lenX }} / {{ p.current.measured.lenY }}<small>mm</small></div></div>
                    <div class="stat"><div class="k">提醒阈值</div><div class="v">{{ p.warnPct }}<small>%</small></div></div>
                  </div>

                  <!-- 与上一次校准的差异（同一台机器换纸 / 重切前后差多少） -->
                  <div v-if="diffOf(p)" class="diff-box">
                    <div class="diff-title">与上一次校准的差异（{{ formatDate(p.history[0].at) }}，{{ p.paperLabel }}）</div>
                    <div class="diff-row">
                      <span>Δsₓ {{ diffOf(p)!.sxPct }}%</span>
                      <span>Δs_y {{ diffOf(p)!.syPct }}%</span>
                      <span>Δoₓ {{ diffOf(p)!.ox }}mm</span>
                      <span>Δo_y {{ diffOf(p)!.oy }}mm</span>
                    </div>
                  </div>

                  <details v-if="p.history.length">
                    <summary>全部历史（{{ p.history.length }}）</summary>
                    <table class="history-table">
                      <thead>
                        <tr><th>时间</th><th>sₓ</th><th>s_y</th><th>oₓ</th><th>o_y</th><th>实测横/纵</th><th>备注</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="(h, i) in p.history" :key="i">
                          <td>{{ formatDate(h.at) }}</td>
                          <td class="mono">{{ h.sx.toFixed(4) }}</td>
                          <td class="mono">{{ h.sy.toFixed(4) }}</td>
                          <td class="mono">{{ h.ox.toFixed(2) }}</td>
                          <td class="mono">{{ h.oy.toFixed(2) }}</td>
                          <td class="mono">{{ h.measured.lenX }}/{{ h.measured.lenY }}</td>
                          <td>{{ h.note }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </details>

                  <div class="btn-row wrap">
                    <button class="tiny primary" v-if="project && !p.archived" @click="applyToProject(p)">应用到当前项目</button>
                    <button class="tiny" @click="startRecal(p)">再校准</button>
                    <button class="tiny" v-if="!p.archived" @click="archive(p)">归档（换纸留档）</button>
                    <button class="tiny" v-else @click="restore(p)">恢复生效</button>
                    <button class="tiny danger" @click="removeArchive(p)">删除</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="hint">
              换一种纸时请新建档案：旧纸档案点「归档」保留，可以随时对比同一台机器换纸前后的缩放与原点差异。
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page.wide {
  max-width: 1280px;
}

.cal-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.edit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 8px;
  margin-bottom: 6px;
}

.field.grow2 {
  grid-column: span 2;
}

.artifact-preview {
  margin: 8px 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
  background: #fff;
}

.artifact-preview :deep(svg) {
  display: block;
  width: 100%;
  height: auto;
  max-height: 340px;
}

.banner.info {
  background: rgba(90, 169, 255, 0.12);
  border: 1px solid rgba(90, 169, 255, 0.35);
  color: #a9ccff;
  display: flex;
  align-items: center;
  gap: 8px;
}

.banner.ok {
  background: rgba(71, 192, 122, 0.12);
  border: 1px solid rgba(71, 192, 122, 0.35);
  color: #9fe0b8;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  margin: 6px 0;
}

.banner.warn {
  background: rgba(255, 200, 87, 0.12);
  border: 1px solid rgba(255, 200, 87, 0.4);
  color: #ffd98a;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  margin: 6px 0;
}

.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  margin: 6px 0;
}

.check {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
  margin: 6px 0;
}

.machine-group {
  margin-bottom: 10px;
}

.machine-head {
  font-size: 12px;
  color: var(--text-mute);
  letter-spacing: 0.06em;
  margin: 8px 0 4px;
  border-bottom: 1px dashed var(--line);
  padding-bottom: 3px;
}

.profile-card {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 7px 9px;
  margin-bottom: 6px;
  background: rgba(255, 255, 255, 0.02);
}

.profile-card.activeSel {
  border-color: var(--accent);
}

.profile-card.archived {
  opacity: 0.62;
}

.profile-head {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  flex-wrap: wrap;
}

.profile-body {
  margin-top: 8px;
}

.diff-box {
  margin: 8px 0;
  padding: 6px 8px;
  border-radius: 5px;
  background: rgba(90, 169, 255, 0.08);
  border: 1px solid rgba(90, 169, 255, 0.25);
}

.diff-title {
  font-size: 11.5px;
  color: var(--text-dim);
  margin-bottom: 3px;
}

.diff-row {
  display: flex;
  gap: 14px;
  font-family: var(--mono);
  font-size: 12px;
  color: #a9ccff;
}

.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  margin: 6px 0;
}

.history-table th,
.history-table td {
  border: 1px solid var(--line);
  padding: 2px 5px;
  text-align: left;
}

.history-table th {
  color: var(--text-dim);
}

.btn-row.wrap {
  flex-wrap: wrap;
}

h3 {
  margin: 14px 0 7px;
  font-size: 13.5px;
}
</style>
