<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { store, state } from '@/logic/store'
import {
  CALIB_MARGIN_MM,
  DEFAULT_DRIFT_SCALE_PCT,
  DEFAULT_WARN_ORIGIN_MM,
  DEFAULT_WARN_SCALE_PCT,
  PAPER_KINDS,
  SHEET_PRESETS,
  type CalibrationProfile,
  type Sheet,
} from '@/logic/types'
import {
  buildCalibGeometry,
  compareProfiles,
  computeCalibration,
  paperText,
  profileDrift,
  profileKey,
  profileLabel,
  profileStatus,
  stdLength,
} from '@/logic/calibration'
import { buildCalibSheet, exportPlt, identityPlacement, type ExportMeta } from '@/logic/exporters'
import { downloadText, sanitizeFilename } from '@/logic/download'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => (typeof route.query.project === 'string' ? route.query.project : ''))
const project = computed(() => (projectId.value ? store.getProject(projectId.value) ?? null : null))

/** 从导出页带过来的纸张（项目材料预设） */
const projectPaper = computed(() => (project.value ? store.materialOf(project.value)?.paper ?? '' : ''))

// ---------------- 试切件参数 ----------------
const form = reactive({
  machine: (typeof route.query.machine === 'string' ? route.query.machine : '') || '',
  paper:
    (typeof route.query.paper === 'string' ? route.query.paper : '') ||
    projectPaper.value ||
    'red-paper',
  customPaper: '',
  sheetW: project.value?.sheet.widthMm ?? 297,
  sheetH: project.value?.sheet.heightMm ?? 210,
  sheetName: project.value?.sheet.name ?? 'A4 横向',
  measuredX: '',
  measuredY: '',
  originX: '',
  originY: '',
  note: '',
  warnScalePct: DEFAULT_WARN_SCALE_PCT,
  warnOriginMm: DEFAULT_WARN_ORIGIN_MM,
  driftScalePct: DEFAULT_DRIFT_SCALE_PCT,
})

const paperOptions = computed(() => [...PAPER_KINDS.map((p) => ({ value: p.paper, label: p.label })), { value: '__custom', label: '自定义纸张…' }])

function isCustomPaper(): boolean {
  return form.paper === '__custom'
}
function paperKey(): string {
  return isCustomPaper() ? form.customPaper.trim() || '自定义纸' : form.paper
}
function paperLabelText(): string {
  if (isCustomPaper()) return form.customPaper.trim() || '自定义纸'
  return PAPER_KINDS.find((p) => p.paper === form.paper)?.label ?? form.paper
}

const sheet = computed<Sheet>(() => ({ widthMm: Number(form.sheetW) || 0, heightMm: Number(form.sheetH) || 0, name: form.sheetName }))
const marginMm = CALIB_MARGIN_MM
const stdX = computed(() => stdLength(sheet.value.widthMm, marginMm))
const stdY = computed(() => stdLength(sheet.value.heightMm, marginMm))
const geom = computed(() => buildCalibGeometry(sheet.value, marginMm))

function onSheetPreset(name: string): void {
  const s = SHEET_PRESETS.find((x) => x.name === name)
  if (!s) return
  form.sheetW = s.widthMm
  form.sheetH = s.heightMm
  form.sheetName = s.name
}

// ---------------- 实测结果 ----------------
const result = computed(() => {
  const mx = Number(form.measuredX)
  const my = Number(form.measuredY)
  const ox = form.originX === '' ? NaN : Number(form.originX)
  const oy = form.originY === '' ? NaN : Number(form.originY)
  if (!(mx > 0) || !(my > 0) || !Number.isFinite(ox) || !Number.isFinite(oy)) return null
  return computeCalibration({
    machine: form.machine,
    paper: paperKey(),
    paperLabel: paperLabelText(),
    sheet: sheet.value,
    measuredXMm: mx,
    measuredYMm: my,
    originXMm: ox,
    originYMm: oy,
    stdXMm: stdX.value,
    stdYMm: stdY.value,
    marginMm,
  })
})

const saveError = ref('')
const saveOk = ref('')
const justSavedId = ref('')

function doSave(): void {
  saveError.value = ''
  saveOk.value = ''
  if (!form.machine.trim()) {
    saveError.value = '请先填写机器名（同一台机器的不同纸张共用一个机器名）'
    return
  }
  if (!result.value || result.value.error) {
    saveError.value = result.value?.error ?? '请把两个实测长度与两个原点距离填完整'
    return
  }
  const existed = state.calibrations.some((c) => profileKey(c.machine, c.paper) === profileKey(form.machine, paperKey()))
  try {
    const { profile, created } = store.saveCalibration({
      machine: form.machine,
      paper: paperKey(),
      paperLabel: paperLabelText(),
      sheet: sheet.value,
      measuredXMm: Number(form.measuredX),
      measuredYMm: Number(form.measuredY),
      originXMm: Number(form.originX),
      originYMm: Number(form.originY),
      stdXMm: stdX.value,
      stdYMm: stdY.value,
      marginMm,
      note: form.note,
      warnScalePct: form.warnScalePct,
      warnOriginMm: form.warnOriginMm,
      driftScalePct: form.driftScalePct,
    })
    justSavedId.value = profile.id
    saveOk.value = created
      ? `已新建档案「${profileLabel(profile)}」（第 1 次校准）`
      : `已追加到档案「${profileLabel(profile)}」（第 ${profile.history.length} 次校准）${existed ? '' : ''}`
    form.measuredX = ''
    form.measuredY = ''
    form.originX = ''
    form.originY = ''
  } catch (e) {
    saveError.value = (e as Error).message
  }
}

function applyLatest(): void {
  if (!project.value || !justSavedId.value) return
  store.setCalibration(project.value, justSavedId.value)
  router.push(`/export/${project.value.id}`)
}

function prefill(p: CalibrationProfile): void {
  form.machine = p.machine
  const builtin = PAPER_KINDS.find((k) => k.paper === p.paper)
  if (builtin) form.paper = p.paper
  else {
    form.paper = '__custom'
    form.customPaper = p.paperLabel && p.paperLabel !== p.paper ? p.paperLabel : p.paper
  }
  form.sheetW = p.sheet.widthMm
  form.sheetH = p.sheet.heightMm
  form.sheetName = p.sheet.name
  form.note = p.note
  form.warnScalePct = p.warnScalePct
  form.warnOriginMm = p.warnOriginMm
  form.driftScalePct = p.driftScalePct
  justSavedId.value = p.id
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// 切项目后清掉一键应用目标
watch(projectId, () => {
  justSavedId.value = ''
})

// ---------------- 试切件导出 ----------------
function metaFor(): ExportMeta {
  const mat = state.materials[0]
  return {
    projectName: `校准试切件 ${form.machine || '机器'}`,
    formName: paperLabelText(),
    material: mat,
    bridgeWidthMm: 0,
    passes: 1,
    sheet: sheet.value,
    cutLengthMm: geom.value.steps.reduce((a, s) => a + s.lengthMm, 0),
    travelMm: 0,
  }
}

function calibSvg(): string {
  return buildCalibSheet(geom.value.steps, sheet.value, {
    machine: form.machine || '机器',
    paper: paperLabelText(),
    stdXMm: stdX.value,
    stdYMm: stdY.value,
    marginMm,
  })
}

function downloadPlt(): void {
  const stats = exportPlt(
    geom.value.steps,
    { format: 'plt', unit: '0.025mm', origin: 'bottom_left', yFlip: true, scale: 1 },
    sheet.value,
    metaFor(),
    identityPlacement(sheet.value),
  )
  downloadText(`${sanitizeFilename(`calib_${form.machine || 'machine'}_${paperKey()}`)}.plt`, stats.text)
}

function downloadSvg(): void {
  downloadText(`${sanitizeFilename(`calib_${form.machine || 'machine'}_${paperKey()}`)}.svg`, calibSvg(), 'image/svg+xml;charset=utf-8')
}

// ---------------- 档案列表 ----------------
const profiles = computed(() => [...state.calibrations].sort((a, b) => a.machine.localeCompare(b.machine, 'zh') || b.updatedAt - a.updatedAt))
const machines = computed(() => Array.from(new Set(state.calibrations.map((c) => c.machine))).sort((a, b) => a.localeCompare(b, 'zh')))
const expanded = ref<Record<string, boolean>>({})
function toggle(id: string): void {
  expanded.value[id] = !expanded.value[id]
}
function removeProfile(p: CalibrationProfile): void {
  if (!confirm(`删除档案「${profileLabel(p)}」？其全部 ${p.history.length} 次校准记录会一并删除，且使用该档案的项目会取消选中。`)) return
  store.deleteCalibration(p.id)
}
function applyToProject(p: CalibrationProfile): void {
  if (!project.value) return
  store.setCalibration(project.value, p.id)
  router.push(`/export/${project.value.id}`)
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---------------- 同机换纸对比 ----------------
const cmpMachine = ref('')
const cmpA = ref('')
const cmpB = ref('')
const cmpProfilesA = computed<CalibrationProfile[]>(() => state.calibrations.filter((c) => c.machine === cmpMachine.value))
function onCmpMachine(): void {
  const list = state.calibrations.filter((c) => c.machine === cmpMachine.value)
  cmpA.value = list[0]?.id ?? ''
  cmpB.value = list[1]?.id ?? ''
}
const cmpResult = computed(() => {
  const a = state.calibrations.find((c) => c.id === cmpA.value)
  const b = state.calibrations.find((c) => c.id === cmpB.value)
  if (!a || !b || a.id === b.id) return null
  return { a, b, diff: compareProfiles(a, b) }
})
function pct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(3)}%`
}
</script>

<template>
  <div class="page">
    <div class="page narrow calib-page">
      <div class="calib-head">
        <div>
          <h1>机器 × 纸张校准档案</h1>
          <p class="hint">
            同一纹样在不同机器、不同纸张上切出来尺寸会有差异。导出试切件 → 实切 → 量回横竖两条标准线与到纸边的距离 →
            反算横向/纵向缩放与原点偏移。一台机器 + 一种纸 = 一条档案，后续导出刀路先按档案补偿整张图。
          </p>
        </div>
        <button v-if="project" class="tiny" @click="router.push(`/export/${project.id}`)">← 返回导出（{{ project.name }}）</button>
      </div>

      <div v-if="project" class="banner info">当前来自项目「{{ project.name }}」，保存档案后可直接应用到该项目并返回导出页。</div>

      <div class="calib-grid">
        <!-- 左：试切与测量 -->
        <div class="card">
          <h2>① 试切与测量</h2>

          <div class="field">
            <label>机器名 <span class="hint">（换刀/换压纸轮后沿用同一机器名，可对比状态漂移）</span></label>
            <input type="text" v-model="form.machine" placeholder="例如：工作室 1 号刻字机" list="machine-list" />
            <datalist id="machine-list">
              <option v-for="m in machines" :key="m" :value="m" />
            </datalist>
          </div>

          <div class="field-row">
            <label>纸张</label>
            <select v-model="form.paper">
              <option v-for="o in paperOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </div>
          <div class="field" v-if="isCustomPaper()">
            <label>自定义纸名</label>
            <input type="text" v-model="form.customPaper" placeholder="例如：180g 洒金红宣" />
          </div>

          <div class="field-row">
            <label>纸幅预设</label>
            <select :value="form.sheetName" @change="onSheetPreset(($event.target as HTMLSelectElement).value)">
              <option v-for="s in SHEET_PRESETS" :key="s.name" :value="s.name">{{ s.name }}（{{ s.widthMm }}×{{ s.heightMm }}）</option>
              <option value="__current">当前尺寸</option>
            </select>
          </div>
          <div class="field-row">
            <label>纸宽 × 高</label>
            <input type="number" min="40" v-model.number="form.sheetW" @change="form.sheetName = '自定义'" />
            <input type="number" min="40" v-model.number="form.sheetH" @change="form.sheetName = '自定义'" />
            <span class="hint">mm</span>
          </div>

          <div class="std-box">
            <div class="std-line">
              <span class="dir h">横</span>
              <span>标准线长 <b>{{ stdX }}</b> mm</span>
            </div>
            <div class="std-line">
              <span class="dir v">纵</span>
              <span>标准线长 <b>{{ stdY }}</b> mm</span>
            </div>
            <div class="hint">角点指令坐标 ({{ marginMm }}, {{ marginMm }})mm；线端带 4mm 刻度，量两刻度内侧全长。</div>
          </div>

          <div class="preview-frame">
            <div class="pv-scroll" v-html="calibSvg()"></div>
          </div>

          <div class="btn-row" style="margin: 8px 0">
            <button class="primary" @click="downloadPlt">导出试切件 PLT</button>
            <button @click="downloadSvg">导出试切件 SVG（1:1 打印）</button>
          </div>
          <div class="hint">试切件本身不做任何补偿（s=1、无原点平移），量出来的偏差才是机器+纸张的真实偏差。PLT 原点在左下，按当前纸幅实切。</div>

          <div class="section">
            <div class="section-title">② 填实测长度（mm）</div>
            <div class="measure-grid">
              <div>
                <label>横向线实测长</label>
                <input type="number" step="0.01" v-model="form.measuredX" :placeholder="String(stdX)" />
              </div>
              <div>
                <label>纵向线实测长</label>
                <input type="number" step="0.01" v-model="form.measuredY" :placeholder="String(stdY)" />
              </div>
              <div>
                <label>横线到纸左缘</label>
                <input type="number" step="0.01" v-model="form.originX" :placeholder="String(marginMm)" />
              </div>
              <div>
                <label>竖线到纸下缘</label>
                <input type="number" step="0.01" v-model="form.originY" :placeholder="String(marginMm)" />
              </div>
            </div>
            <div class="hint">横线/竖线端点小刻度用于卡尺对齐；到纸缘距离从刻度中心量起。理想值分别为 {{ stdX }} / {{ stdY }} / {{ marginMm }} / {{ marginMm }}mm。</div>
          </div>

          <div v-if="result && !result.error" class="result-box">
            <div class="stat-grid">
              <div class="stat"><div class="k">横向缩放 sX</div><div class="v">{{ result.scaleX.toFixed(5) }}</div></div>
              <div class="stat"><div class="k">纵向缩放 sY</div><div class="v">{{ result.scaleY.toFixed(5) }}</div></div>
              <div class="stat"><div class="k">横向原点 oX</div><div class="v">{{ result.offsetXMm.toFixed(3) }}<small>mm</small></div></div>
              <div class="stat"><div class="k">纵向原点 oY</div><div class="v">{{ result.offsetYMm.toFixed(3) }}<small>mm</small></div></div>
            </div>
            <div class="hint">
              缩放偏差 横 {{ ((result.scaleX - 1) * 100).toFixed(2) }}%｜纵 {{ ((result.scaleY - 1) * 100).toFixed(2) }}%。
              导出时整张图先乘 sX/sY，再整体平移抵消原点误差。
            </div>
          </div>
          <div v-if="result?.error" class="banner err">{{ result.error }}</div>

          <div class="field" style="margin-top: 8px">
            <label>备注（可选）</label>
            <input type="text" v-model="form.note" placeholder="例如：新换刻刀、温湿度、垫板编号" />
          </div>
          <details class="thresh">
            <summary class="hint">重校准提醒阈值（高级）</summary>
            <div class="measure-grid" style="margin-top: 6px">
              <div>
                <label>缩放偏差阈值 %</label>
                <input type="number" step="0.5" v-model.number="form.warnScalePct" />
              </div>
              <div>
                <label>原点修正阈值 mm</label>
                <input type="number" step="0.5" v-model.number="form.warnOriginMm" />
              </div>
              <div>
                <label>两次校准漂移 %</label>
                <input type="number" step="0.5" v-model.number="form.driftScalePct" />
              </div>
            </div>
          </details>

          <div v-if="saveError" class="banner err">{{ saveError }}</div>
          <div v-if="saveOk" class="banner ok">{{ saveOk }}</div>
          <div class="btn-row" style="margin-top: 8px">
            <button class="primary" @click="doSave">保存 / 追加校准记录</button>
            <button v-if="project" :disabled="!justSavedId" @click="applyLatest">保存并应用到本项目</button>
          </div>
        </div>

        <!-- 右：档案 -->
        <div class="card">
          <h2>校准档案（{{ profiles.length }}）</h2>
          <div v-if="profiles.length === 0" class="empty">还没有档案，先在左侧做一次试切校准。</div>
          <div v-for="p in profiles" :key="p.id" class="prof-item">
            <div class="prof-head" @click="toggle(p.id)">
              <strong>{{ p.machine }}</strong>
              <span class="tag accent">{{ paperText(p.paper, p.paperLabel) }}</span>
              <span class="tag" :class="profileStatus(p).level === 'err' ? 'err' : 'ok'">
                {{ profileStatus(p).level === 'err' ? '偏差超阈值' : '正常' }}
              </span>
              <span v-if="profileDrift(p).drifted" class="tag warn">状态漂移</span>
              <span class="spacer"></span>
              <span class="hint">{{ fmtDate(p.updatedAt) }} · {{ p.history.length }} 次</span>
            </div>
            <div class="prof-params">
              <span>sX <b :class="{ bad: Math.abs(p.scaleX - 1) * 100 > p.warnScalePct }">{{ p.scaleX.toFixed(4) }}</b></span>
              <span>sY <b :class="{ bad: Math.abs(p.scaleY - 1) * 100 > p.warnScalePct }">{{ p.scaleY.toFixed(4) }}</b></span>
              <span>oX <b :class="{ bad: Math.abs(p.offsetXMm) > p.warnOriginMm }">{{ p.offsetXMm.toFixed(2) }}</b>mm</span>
              <span>oY <b :class="{ bad: Math.abs(p.offsetYMm) > p.warnOriginMm }">{{ p.offsetYMm.toFixed(2) }}</b>mm</span>
              <span class="hint">{{ p.sheet.widthMm }}×{{ p.sheet.heightMm }}mm</span>
            </div>
            <div v-if="profileStatus(p).level === 'err'" class="banner err tight">
              {{ profileStatus(p).messages.join('；') }}，导出时会被拦下提醒重新校准，不会静默套用。
            </div>
            <div v-if="profileDrift(p).drifted" class="banner warn tight">{{ profileDrift(p).messages.join('；') }}，建议重新试切确认。</div>
            <div v-if="p.note" class="hint">备注：{{ p.note }}</div>
            <div class="btn-row">
              <button v-if="project" class="tiny primary" @click="applyToProject(p)">应用到本项目</button>
              <button class="tiny" @click="prefill(p)">用同样参数再校一次</button>
              <button class="tiny danger" @click="removeProfile(p)">删除档案</button>
            </div>
            <div v-if="expanded[p.id]" class="history">
              <table class="grid">
                <thead>
                  <tr><th>时间</th><th>横测</th><th>纵测</th><th>原点X/Y</th><th>sX</th><th>sY</th></tr>
                </thead>
                <tbody>
                  <tr v-for="(h, i) in [...p.history].reverse()" :key="h.id">
                    <td>{{ fmtDate(h.createdAt) }}<span v-if="i === 0" class="tag ok" style="margin-left: 4px">生效中</span></td>
                    <td class="num">{{ h.measuredXMm }}</td>
                    <td class="num">{{ h.measuredYMm }}</td>
                    <td class="num">{{ h.originXMm }} / {{ h.originYMm }}</td>
                    <td class="num">{{ h.scaleX.toFixed(4) }}</td>
                    <td class="num">{{ h.scaleY.toFixed(4) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="section">
            <div class="section-title">同一台机器换纸前后差多少</div>
            <div class="field-row">
              <label>机器</label>
              <select v-model="cmpMachine" @change="onCmpMachine">
                <option value="" disabled>选择机器…</option>
                <option v-for="m in machines" :key="m" :value="m">{{ m }}</option>
              </select>
            </div>
            <template v-if="cmpProfilesA.length >= 1">
              <div class="field-row">
                <label>纸张 A</label>
                <select v-model="cmpA">
                  <option v-for="c in cmpProfilesA" :key="c.id" :value="c.id">{{ paperText(c.paper, c.paperLabel) }}</option>
                </select>
              </div>
              <div class="field-row">
                <label>纸张 B</label>
                <select v-model="cmpB">
                  <option value="" disabled>选择对比纸…</option>
                  <option v-for="c in cmpProfilesA" :key="c.id" :value="c.id">{{ paperText(c.paper, c.paperLabel) }}</option>
                </select>
              </div>
              <div v-if="cmpResult" class="cmp-box">
                <div class="hint">{{ paperText(cmpResult.a.paper, cmpResult.a.paperLabel) }} → {{ paperText(cmpResult.b.paper, cmpResult.b.paperLabel) }}</div>
                <table class="grid">
                  <tbody>
                    <tr><th>横向缩放差</th><td class="num" :class="{ bad: Math.abs(cmpResult.diff.dScaleXPct) > cmpResult.b.driftScalePct }">{{ pct(cmpResult.diff.dScaleXPct) }}</td></tr>
                    <tr><th>纵向缩放差</th><td class="num" :class="{ bad: Math.abs(cmpResult.diff.dScaleYPct) > cmpResult.b.driftScalePct }">{{ pct(cmpResult.diff.dScaleYPct) }}</td></tr>
                    <tr><th>横向原点差</th><td class="num">{{ cmpResult.diff.dOffsetXMm.toFixed(2) }} mm</td></tr>
                    <tr><th>纵向原点差</th><td class="num">{{ cmpResult.diff.dOffsetYMm.toFixed(2) }} mm</td></tr>
                  </tbody>
                </table>
              </div>
              <div v-else-if="cmpProfilesA.length < 2" class="hint">该机器目前只有一种纸的档案，再校一种纸即可对比。</div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.calib-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.calib-grid {
  display: grid;
  grid-template-columns: minmax(380px, 1fr) minmax(360px, 1fr);
  gap: 12px;
  margin-top: 10px;
}

.std-box {
  background: var(--panel-2);
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  padding: 7px 9px;
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.std-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.std-line b {
  font-family: var(--mono);
  color: var(--accent-2);
}

.dir {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
}

.dir.h {
  background: rgba(90, 169, 255, 0.18);
  color: var(--info);
}

.dir.v {
  background: rgba(71, 192, 122, 0.18);
  color: var(--ok);
}

.preview-frame {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fdf6ee;
  padding: 8px;
  max-height: 300px;
  overflow: auto;
}

.pv-scroll svg {
  width: 100%;
  height: auto;
  display: block;
}

.measure-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}

.measure-grid label {
  display: block;
  font-size: 11px;
  color: var(--text-dim);
  margin-bottom: 2px;
}

.result-box {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid rgba(71, 192, 122, 0.35);
  border-radius: 6px;
  background: rgba(71, 192, 122, 0.07);
}

.prof-item {
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  padding: 8px;
  margin-bottom: 8px;
  background: var(--panel-2);
}

.prof-head {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  flex-wrap: wrap;
}

.prof-head .spacer {
  flex: 1;
}

.prof-params {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin: 6px 0;
  font-size: 12px;
  color: var(--text-dim);
}

.prof-params b {
  font-family: var(--mono);
  color: var(--text);
}

.prof-params b.bad {
  color: var(--err);
}

.banner.tight {
  padding: 4px 7px;
  font-size: 11.5px;
  margin: 4px 0;
}

.history {
  margin-top: 7px;
  max-height: 220px;
  overflow: auto;
}

.cmp-box {
  margin-top: 6px;
}

.bad {
  color: var(--err);
}

.thresh summary {
  cursor: pointer;
  margin: 6px 0;
}

@media (max-width: 1000px) {
  .calib-grid {
    grid-template-columns: 1fr;
  }
}
</style>
