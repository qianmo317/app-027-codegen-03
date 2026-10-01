<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PreviewCanvas from '@/components/PreviewCanvas.vue'
import { store, state } from '@/logic/store'
import { SHEET_PRESETS, IDENTITY_AFFINE, type ExportCfg, type Sheet } from '@/logic/types'
import type { ComputedShape } from '@/logic/pipeline'
import {
  buildA4Sheet,
  computePlacement,
  exportGcode,
  exportPlt,
  exportSvg,
  SHEET_MARGIN_MM,
  type ExportMeta,
  type ExportStats,
} from '@/logic/exporters'
import { assessProfileUse, formatDate, paperKeyOf } from '@/logic/calibration'
import type { CalibrationProfile } from '@/logic/calibration'
import { downloadText, sanitizeFilename } from '@/logic/download'
import { boundsOf } from '@/logic/geometry'

const route = useRoute()
const router = useRouter()
const canvas = ref<InstanceType<typeof PreviewCanvas> | null>(null)

const projectId = computed(() => String(route.params.id))
const project = computed(() => store.getProject(projectId.value) ?? null)
const jobData = computed(() => (project.value ? store.jobOf(project.value) : null))
const job = computed(() => jobData.value?.job ?? null)
const material = computed(() => (project.value ? store.materialOf(project.value) : null))

const shapesForCanvas = computed(() => {
  const p = project.value
  if (!p) return []
  const d = jobData.value
  if (d?.isBatch && d.shape) return [d.shape]
  return p.shapes
})

const computedMap = computed(() => {
  const m = new Map<string, ComputedShape>()
  const d = jobData.value
  if (d) for (const [k, v] of d.computed) m.set(k, v)
  return m
})

const cfg = computed<ExportCfg>(() => project.value?.export ?? { format: 'plt', unit: '0.025mm', origin: 'bottom_left', yFlip: true, scale: 1 })

// ---------------- 机器校准档案 ----------------

const activeCalibrations = computed(() => state.calibrations.filter((c) => !c.archived))
const selectedCalibration = computed<CalibrationProfile | null>(() => {
  const p = project.value
  if (!p || !p.calibrationId) return null
  return store.getCalibration(p.calibrationId)
})
const comp = computed(() => selectedCalibration.value?.current.comp ?? IDENTITY_AFFINE)

const currentPaperKey = computed(() => {
  const m = material.value
  const p = project.value
  if (!m || !p) return ''
  return paperKeyOf(m.paper, p.sheet)
})

const calAssess = computed(() => {
  const p = project.value
  const c = selectedCalibration.value
  if (!p || !c) return null
  return assessProfileUse(c, p.sheet, currentPaperKey.value)
})

const calBlocked = computed(() => calAssess.value?.level === 'bad')
const acknowledgedCal = ref(false)

function onCalibrationChange(id: string): void {
  const p = project.value
  if (!p) return
  store.setProjectCalibration(p, id || null)
  acknowledgedCal.value = false
}

const placement = computed(() => {
  const p = project.value
  if (!p || !job.value) return null
  return computePlacement(job.value.steps, p.sheet, p.export.scale, SHEET_MARGIN_MM, comp.value)
})

const calibrationLabel = computed(() => {
  const c = selectedCalibration.value
  if (!c) return null
  return `${c.machine}/${c.paperLabel} sx=${c.current.sx} sy=${c.current.sy} @${formatDate(c.updatedAt)}`
})

const meta = computed<ExportMeta | null>(() => {
  const p = project.value
  if (!p || !material.value || !job.value) return null
  return {
    projectName: p.name,
    formName: shapesForCanvas.value.map((s) => s.name).join('、'),
    material: material.value,
    bridgeWidthMm: p.settings.bridgeWidthMm,
    passes: material.value.passes,
    sheet: p.sheet,
    cutLengthMm: job.value.cutLengthMm,
    travelMm: job.value.travelMm,
    calibrationLabel: calibrationLabel.value,
  }
})

const stats = computed<ExportStats | null>(() => {
  const p = project.value
  if (!p || !job.value || !meta.value || !placement.value) return null
  const m = meta.value
  const pl = placement.value
  if (cfg.value.format === 'plt') return exportPlt(job.value.steps, cfg.value, p.sheet, m, pl)
  if (cfg.value.format === 'gcode') return exportGcode(job.value.steps, cfg.value, p.sheet, m, pl)
  return exportSvg(job.value.steps, cfg.value, p.sheet, m, pl)
})

const previewLines = computed(() => {
  if (!stats.value) return []
  return stats.value.text.split('\n').slice(0, 60)
})

const lineCount = computed(() => (stats.value ? stats.value.text.split('\n').length : 0))

const sizeInfo = computed(() => {
  const p = project.value
  if (!p || !job.value || !placement.value) return null
  const pts = job.value.steps.flatMap((s) => s.points)
  if (pts.length === 0) return null
  const b = boundsOf(pts)
  // 设计物理尺寸（未补偿）
  const w = (b.maxX - b.minX) * p.export.scale
  const h = (b.maxY - b.minY) * p.export.scale
  const availW = p.sheet.widthMm - SHEET_MARGIN_MM * 2
  const availH = p.sheet.heightMm - SHEET_MARGIN_MM * 2
  // 补偿后实际下发的刀路包围盒（机器再按 sx/sy 切回设计尺寸）
  const cb = placement.value.commandBounds
  const compW = cb.maxX - cb.minX
  const compH = cb.maxY - cb.minY
  return {
    w,
    h,
    compW,
    compH,
    availW,
    availH,
    fits: w <= availW + 0.01 && h <= availH + 0.01,
    /** 补偿后是否仍在纸幅内（这是真正决定会不会切到纸外的判据） */
    compFits: !placement.value.outOfSheet,
    // 补偿后范围与缩放近似成正比，按比例反推自动适配缩放
    suggestScale: p.export.scale * Math.min(availW / Math.max(compW, 1e-6), availH / Math.max(compH, 1e-6)),
  }
})

function setExport(patch: Partial<ExportCfg>): void {
  const p = project.value
  if (!p) return
  store.updateExport(p, patch)
}

function setSheet(s: Sheet): void {
  const p = project.value
  if (!p) return
  store.updateSheet(p, s)
}

function onSheetPreset(name: string): void {
  const s = SHEET_PRESETS.find((x) => x.name === name)
  if (s) setSheet({ ...s })
}

function autoFit(): void {
  const info = sizeInfo.value
  if (!info || !project.value) return
  setExport({ scale: Math.max(0.05, Math.round(info.suggestScale * 1000) / 1000) })
}

function ext(): string {
  const f = cfg.value.format
  return f === 'plt' ? 'plt' : f === 'gcode' ? 'nc' : 'svg'
}

function mime(): string {
  return cfg.value.format === 'svg' ? 'image/svg+xml;charset=utf-8' : 'text/plain;charset=utf-8'
}

function doDownload(): void {
  const p = project.value
  if (!p || !stats.value) return
  // 偏差超阈值 / 纸张不匹配：不允许悄悄套用旧档案，必须显式确认
  if (calBlocked.value && !acknowledgedCal.value) {
    window.alert('当前校准档案与纸张不匹配或缩放偏差超过阈值，已阻止导出。\n请重新校准，或明确勾选确认后再导出。')
    return
  }
  const name = `${sanitizeFilename(p.name)}_${cfg.value.format}.${ext()}`
  downloadText(name, stats.value.text, mime())
}

// ---------------- A4 检查图 ----------------
const a4 = ref({ showNumbers: true, showTravel: false, title: '' })

const a4Svg = computed(() => {
  const p = project.value
  if (!p || !job.value || !meta.value || !placement.value) return ''
  return buildA4Sheet(job.value.steps, p.sheet, meta.value, placement.value, {
    showNumbers: a4.value.showNumbers,
    showTravel: a4.value.showTravel,
    title: a4.value.title || p.name,
  })
})

function printA4(): void {
  window.print()
}

/** 100mm 校验尺几何自检：量出的长度必须是 100mm */
const rulerCheck = computed(() => {
  const re = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke="#000" stroke-width="0.3"\/>/
  const m = re.exec(a4Svg.value)
  if (!m) return null
  const len = Math.abs(Number(m[3]) - Number(m[1]))
  return { length: len, ok: Math.abs(len - 100) <= 0.01 }
})

function downloadA4(): void {
  const p = project.value
  if (!p || !a4Svg.value) return
  downloadText(`${sanitizeFilename(p.name)}_A4检查图.svg`, a4Svg.value, 'image/svg+xml;charset=utf-8')
}
</script>

<template>
  <div v-if="!project" class="splash">项目不存在，请返回纹样库 <RouterLink to="/">返回</RouterLink></div>
  <div v-else class="workbench-export">
    <div class="panel canvas-panel">
      <div class="panel-head">
        导出预览
        <span class="spacer"></span>
        <span class="tag mono">{{ project.sheet.widthMm }}×{{ project.sheet.heightMm }}mm</span>
        <span class="tag mono">缩放 {{ (project.export.scale * 100).toFixed(0) }}%</span>
        <span v-if="selectedCalibration" class="tag accent">已按校准补偿</span>
        <span v-else class="tag">未校准</span>
      </div>
      <PreviewCanvas
        ref="canvas"
        :shapes="shapesForCanvas"
        :computed="computedMap"
        mode="toolpath"
        tool="select"
        :sheet="project.sheet"
        :show-numbers="false"
        :show-travel="false"
        :placement="placement"
        :status-text="selectedCalibration
          ? `已按「${selectedCalibration.machine} · ${selectedCalibration.paperLabel}」预补偿（kₓ ${comp.kx} / k_y ${comp.ky}）后放入纸幅`
          : `${job?.runCount ?? 0} 段刀路已放入纸幅（左边距 ${SHEET_MARGIN_MM}mm）`"
      />
      <div class="panel-foot">
        <div class="btn-row">
          <button class="tiny" @click="router.push(`/layout/${project.id}`)">返回排版</button>
          <button class="tiny" @click="router.push(`/design/${project.id}`)">返回编辑</button>
          <span class="hint" style="margin-left: auto">预览为补偿后的刀路，虚线框为纸幅</span>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        导出设置
        <span class="spacer"></span>
        <button class="tiny primary" @click="doDownload">下载 {{ cfg.format.toUpperCase() }}</button>
      </div>
      <div class="panel-body">
        <!-- 机器校准档案选择 -->
        <div class="section calibration-section">
          <div class="section-title">
            机器校准（机器 × 纸张）
            <span class="spacer"></span>
            <RouterLink class="tiny-link" :to="`/calibration/${project.id}`">新建 / 管理校准</RouterLink>
          </div>
          <div class="field-row">
            <label>校准档案</label>
            <select :value="project.calibrationId ?? ''" @change="onCalibrationChange(($event.target as HTMLSelectElement).value)">
              <option value="">不补偿（直接按设计尺寸输出）</option>
              <option v-for="c in activeCalibrations" :key="c.id" :value="c.id">
                {{ c.machine }} · {{ c.paperLabel }}（sₓ {{ c.current.sx.toFixed(4) }} / s_y {{ c.current.sy.toFixed(4) }}，{{ formatDate(c.updatedAt) }}）
              </option>
            </select>
          </div>
          <div v-if="!selectedCalibration" class="hint">
            未选档案：这台机器切出来若比设计小、或换过纸种，切出的成品会带固定误差。建议先做一次校准（约 2 分钟）。
          </div>
          <template v-else>
            <div class="cal-facts">
              <span class="tag mono">横向 sₓ {{ selectedCalibration.current.sx.toFixed(4) }}</span>
              <span class="tag mono">纵向 s_y {{ selectedCalibration.current.sy.toFixed(4) }}</span>
              <span class="tag mono">原点 oₓ {{ selectedCalibration.current.ox.toFixed(2) }}mm</span>
              <span class="tag mono">o_y {{ selectedCalibration.current.oy.toFixed(2) }}mm</span>
              <span class="tag mono">补偿 kₓ {{ comp.kx }} / k_y {{ comp.ky }}</span>
              <span class="tag mono">指令原点 tₓ {{ comp.tx }} / t_y {{ comp.ty }}mm</span>
              <span class="tag">档案纸幅 {{ selectedCalibration.sheet.widthMm }}×{{ selectedCalibration.sheet.heightMm }}mm</span>
            </div>
            <div v-for="(m, i) in calAssess?.messages ?? []" :key="i" class="banner" :class="calAssess!.level === 'bad' ? 'err' : 'warn'">
              {{ m }}
            </div>
            <label v-if="calAssess && calAssess.level !== 'ok'" class="check">
              <input type="checkbox" v-model="acknowledgedCal" :disabled="calBlocked" />
              <span v-if="calBlocked">纸张 / 纸幅不匹配时不能套用该档案，请改用匹配档案或重新校准（此项不可勾选）</span>
              <span v-else>我确认偏差属实，仍要按该旧档案补偿导出</span>
            </label>
          </template>
        </div>

        <div class="section">
          <div class="section-title">格式与单位</div>
          <div class="field-row">
            <label>格式</label>
            <select :value="cfg.format" @change="setExport({ format: ($event.target as HTMLSelectElement).value as ExportCfg['format'] })">
              <option value="plt">PLT（HPGL，刻字机）</option>
              <option value="gcode">G-code（桌面自组装机）</option>
              <option value="svg">SVG（含连刀点的可切版本）</option>
            </select>
          </div>
          <div class="field-row">
            <label>单位</label>
            <select
              :value="cfg.unit"
              :disabled="cfg.format !== 'plt'"
              @change="setExport({ unit: ($event.target as HTMLSelectElement).value as ExportCfg['unit'] })"
            >
              <option value="0.025mm">0.025mm / unit（HPGL 标准）</option>
              <option value="mm">毫米 mm</option>
            </select>
          </div>
          <div class="field-row">
            <label>原点</label>
            <select
              :value="cfg.origin"
              :disabled="cfg.format === 'svg'"
              @change="setExport({ origin: ($event.target as HTMLSelectElement).value as ExportCfg['origin'] })"
            >
              <option value="bottom_left">左下（刻字机）</option>
              <option value="top_left">左上</option>
            </select>
          </div>
          <label class="check">
            <input
              type="checkbox"
              :checked="cfg.yFlip"
              :disabled="cfg.format === 'svg'"
              @change="setExport({ yFlip: ($event.target as HTMLInputElement).checked })"
            />
            y 轴翻转：y′ = 纸幅高 − y
          </label>
          <div class="hint" v-if="cfg.format === 'svg'">SVG 保留 1:1 原始坐标（1 单位 = 1mm，y 轴向下），不参与原点翻转。</div>
        </div>

        <div class="section">
          <div class="section-title">纸幅与缩放</div>
          <div class="field-row">
            <label>纸幅预设</label>
            <select :value="project.sheet.name" @change="onSheetPreset(($event.target as HTMLSelectElement).value)">
              <option v-for="s in SHEET_PRESETS" :key="s.name" :value="s.name">{{ s.name }}（{{ s.widthMm }}×{{ s.heightMm }}）</option>
              <option :value="project.sheet.name">当前纸幅</option>
            </select>
          </div>
          <div class="field-row">
            <label>宽 × 高</label>
            <input type="number" min="20" :value="project.sheet.widthMm" @change="setSheet({ ...project.sheet, name: '自定义', widthMm: Number(($event.target as HTMLInputElement).value) })" />
            <input type="number" min="20" :value="project.sheet.heightMm" @change="setSheet({ ...project.sheet, name: '自定义', heightMm: Number(($event.target as HTMLInputElement).value) })" />
          </div>
          <div class="field-row">
            <label>缩放</label>
            <input type="number" min="0.05" step="0.01" :value="project.export.scale" @change="setExport({ scale: Number(($event.target as HTMLInputElement).value) })" />
            <button class="tiny" :disabled="!sizeInfo" @click="autoFit">自动适配</button>
          </div>
          <div v-if="sizeInfo" class="hint">
            设计尺寸 {{ sizeInfo.w.toFixed(1) }}×{{ sizeInfo.h.toFixed(1) }}mm｜可用 {{ sizeInfo.availW.toFixed(0) }}×{{ sizeInfo.availH.toFixed(0) }}mm
            <template v-if="selectedCalibration">
              ｜补偿后下发 {{ sizeInfo.compW.toFixed(1) }}×{{ sizeInfo.compH.toFixed(1) }}mm（机器按 sₓ/s_y 切回设计尺寸）
            </template>
            <span v-if="sizeInfo.compFits" class="tag ok">补偿后坐标仍在纸幅内</span>
            <span v-else class="tag err">补偿后超出纸幅，请缩小或换大纸</span>
          </div>
        </div>

        <div class="section" v-if="stats">
          <div class="section-title">导出坐标校验<span class="spacer"></span><span class="tag" :class="stats.outOfSheet ? 'err' : 'ok'">{{ stats.outOfSheet ? '超出纸幅' : '纸幅内' }}</span></div>
          <div class="stat-grid">
            <div class="stat"><div class="k">X 范围</div><div class="v">{{ stats.minX.toFixed(1) }} ~ {{ stats.maxX.toFixed(1) }}<small>{{ stats.unitLabel }}</small></div></div>
            <div class="stat"><div class="k">Y 范围</div><div class="v">{{ stats.minY.toFixed(1) }} ~ {{ stats.maxY.toFixed(1) }}<small>{{ stats.unitLabel }}</small></div></div>
            <div class="stat"><div class="k">纸幅上限</div><div class="v">{{ stats.sheetMaxX.toFixed(0) }} × {{ stats.sheetMaxY.toFixed(0) }}<small>{{ stats.unitLabel }}</small></div></div>
            <div class="stat"><div class="k">切割段数</div><div class="v">{{ stats.runCount }}</div></div>
            <div class="stat"><div class="k">坐标点</div><div class="v">{{ stats.pointCount }}</div></div>
            <div class="stat"><div class="k">重复次数</div><div class="v">{{ stats.repeatPasses }}</div></div>
          </div>
          <div class="hint">
            坐标最小值 {{ stats.minY.toFixed(2) }}（应 ≥ 0，原点在左下）｜进给 {{ stats.feedMmPerMin }} mm/min
            <span v-if="!stats.outOfSheet && stats.minX >= -0.001 && stats.minY >= -0.001" class="tag ok">全部落在纸幅内</span>
            <span v-else class="tag err">有坐标超出纸幅</span>
          </div>
        </div>

        <div class="section">
          <div class="section-title">
            文件预览（前 60 行 / 共 {{ lineCount }} 行）
            <span class="spacer"></span>
            <button class="tiny" @click="doDownload">下载</button>
          </div>
          <pre class="code-preview">{{ previewLines.join('\n') }}</pre>
        </div>

        <div class="section">
          <div class="section-title">A4 排版检查图（1:1 打印）</div>
          <label class="check"><input type="checkbox" v-model="a4.showNumbers" /> 打印顺序编号</label>
          <label class="check"><input type="checkbox" v-model="a4.showTravel" /> 打印跳刀虚线</label>
          <div class="field">
            <label>标题</label>
            <input type="text" v-model="a4.title" :placeholder="project.name" />
          </div>
          <div class="hint" v-if="rulerCheck">
            校验尺几何长度 {{ rulerCheck.length.toFixed(2) }}mm
            <span class="tag ok">图纸误差 {{ Math.abs(rulerCheck.length - 100).toFixed(3) }}mm</span>
          </div>
          <div class="btn-row" style="margin-top: 6px">
            <button class="tiny primary" @click="printA4">打印 1:1</button>
            <button class="tiny" @click="downloadA4">下载检查图 SVG</button>
          </div>
          <div class="hint">打印时务必选择「实际大小 / 100%」，打印后用直尺量图下方 100mm 校验尺，误差应 ≤ 1mm。</div>
        </div>
      </div>
    </div>

    <!-- 打印区：A4 1:1 检查图 -->
    <div class="print-area">
      <div class="sheet" v-html="a4Svg"></div>
    </div>
  </div>
</template>

<style scoped>
.code-preview {
  background: #0e1216;
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 8px;
  margin: 0;
  max-height: 220px;
  overflow: auto;
  font-family: var(--mono);
  font-size: 11px;
  color: #b9c7d6;
  white-space: pre;
}

.check {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
  margin: 6px 0;
}

.cal-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 6px 0;
}

.tiny-link {
  font-size: 11.5px;
  color: var(--accent);
}

.banner.warn {
  background: rgba(255, 200, 87, 0.12);
  border: 1px solid rgba(255, 200, 87, 0.4);
  color: #ffd98a;
  padding: 6px 8px;
  border-radius: 5px;
  font-size: 12px;
  margin: 5px 0;
}

.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
  padding: 6px 8px;
  border-radius: 5px;
  font-size: 12px;
  margin: 5px 0;
}

.print-area .sheet :deep(svg) {
  display: block;
  margin: 0 auto;
}
</style>