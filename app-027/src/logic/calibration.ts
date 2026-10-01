import type { AxisAffine, Sheet } from './types'
import { round3 } from './geometry'

/**
 * 机器 × 纸张校准档案。
 *
 * 试切原理：
 *   在「指令坐标（纸幅左下原点，y 向上，单位 mm）」空间画一条横线与一条竖线，
 *   切完后量出两条线的实测长度，以及起点标记相对纸左下角的实测位置。
 *
 *   机器的实际物理输出满足仿射关系：
 *     physical = M · command + d，即
 *     px = sx·qx + ox    py = sy·qy + oy
 *
 *   其中 sx = measuredLenX / nominalLenX（横向缩放，正常切小了时 < 1），
 *        sy = measuredLenY / nominalLenY（纵向缩放），
 *        ox = measuredOriginX − sx·nominalOriginX（纸角原点横向偏差），
 *        oy = measuredOriginY − sy·nominalOriginY。
 *
 *   要让「实际物理结果 = 设计」，导出时先做逆仿射补偿：
 *     qx = kx·x + tx，kx = 1/sx，tx = −ox/sx
 *     qy = ky·y + ty，ky = 1/sy，ty = −oy/sy
 *
 *   补偿只在输出环节做（导出与预览），不改动纹样设计数据。
 */

/** 试切件名义参数（按当前纸张尺寸给出） */
export type CalibrationNominal = {
  sheet: Sheet
  /** 横线标准长度（mm） */
  lenX: number
  /** 竖线标准长度（mm） */
  lenY: number
  /** 十字起点标记在指令空间（左下原点）的位置（mm） */
  originX: number
  originY: number
}

/** 切完量回来的实测值（mm） */
export type CalibrationMeasured = {
  lenX: number
  lenY: number
  originX: number
  originY: number
}

export type CalibrationResult = {
  sx: number
  sy: number
  ox: number
  oy: number
  /** 导出补偿（指令空间逆仿射） */
  comp: AxisAffine
  /** 缩放偏差绝对值（相对 1），用于超阈值提醒 */
  devXPct: number
  devYPct: number
  /** 原点偏差（mm） */
  originErrX: number
  originErrY: number
}

export type CalibrationStatus = {
  level: 'ok' | 'warn' | 'bad'
  messages: string[]
  /** 最大缩放偏差（%） */
  maxScaleDevPct: number
}

export type CalibrationHistoryEntry = {
  at: number
  note: string
  nominal: CalibrationNominal
  measured: CalibrationMeasured
  sx: number
  sy: number
  ox: number
  oy: number
  /** 导出补偿（指令空间逆仿射），由本次校准计算后直接存档 */
  comp: AxisAffine
}

/** 一条档案 = 一台机器 + 一种纸 */
export type CalibrationProfile = {
  id: string
  machine: string
  paperLabel: string
  /** 纸张 key（材料 paper code 或自定义文字） */
  paperKey: string
  /** 校准时的纸幅 */
  sheet: Sheet
  createdAt: number
  updatedAt: number
  /** 当前生效的一次校准 */
  current: CalibrationHistoryEntry
  /** 历次校准留档（含换纸前后对比），按时间倒序，current 不重复存放 */
  history: CalibrationHistoryEntry[]
  archived?: boolean
  note?: string
  /** 校准时提醒阈值（缩放偏差 %），默认取 DEFAULT_WARN_PCT */
  warnPct: number
}

export const DEFAULT_WARN_PCT = 2
/** 缩放系数被认为不合理（填错或没切好）的硬上下限 */
export const SCALE_HARD_MIN = 0.8
export const SCALE_HARD_MAX = 1.2

const HPGL = 0.025

export type CalibrationArtifact = {
  /** 试切名义参数 */
  nominal: CalibrationNominal
  /** 不做任何补偿的原始 PLT（HPGL，0.025mm，原点左下） */
  plt: string
  /** 1:1 说明书 SVG（标注名义长度、方向、测量方法） */
  guideSvg: string
  /** 预览用线段（指令空间，左下原点）：横线 / 竖线 */
  segments: Array<{ kind: 'h' | 'v'; x1: number; y1: number; x2: number; y2: number }>
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 按纸幅给默认试切长度与起点：长度取纸幅约 60%（夹在 100~200mm），起点距左边/下边各留 30mm */
export function defaultNominal(sheet: Sheet): CalibrationNominal {
  const lenX = Math.round(Math.min(200, Math.max(100, Math.min(sheet.widthMm, sheet.heightMm) * 0.6)))
  const lenY = lenX
  const margin = 30
  const originX = margin
  const originY = margin
  return { sheet: { ...sheet }, lenX, lenY, originX, originY }
}

/** 校验试切名义参数是否放得下纸幅 */
export function validateNominal(n: CalibrationNominal): string | null {
  const m = 5
  if (n.lenX <= 10 || n.lenY <= 10) return '标准长度太短（至少 10mm），量不准'
  if (n.originX < m || n.originY < m) return '起点离纸边至少 5mm，防止切到纸外'
  if (n.originX + n.lenX > n.sheet.widthMm - m) return `横线超出纸幅：${n.originX + n.lenX} > ${n.sheet.widthMm - m}mm`
  if (n.originY + n.lenY > n.sheet.heightMm - m) return `竖线超出纸幅：${n.originY + n.lenY} > ${n.sheet.heightMm - m}mm`
  return null
}

/** 由实测长度与原点位置计算机器缩放、原点偏差与导出补偿系数 */
export function computeCalibration(nominal: CalibrationNominal, measured: CalibrationMeasured): CalibrationResult {
  const sx = measured.lenX / nominal.lenX
  const sy = measured.lenY / nominal.lenY
  // 纸角（指令 0 点）的物理落点偏差：measured = S·nominal + o
  const ox = round3(measured.originX - sx * nominal.originX)
  const oy = round3(measured.originY - sy * nominal.originY)
  const kx = 1 / sx
  const ky = 1 / sy
  const comp: AxisAffine = {
    kx: round4(kx),
    ky: round4(ky),
    tx: round4(-ox / sx),
    ty: round4(-oy / sy),
  }
  return {
    sx: round4(sx),
    sy: round4(sy),
    ox,
    oy,
    comp,
    devXPct: Math.abs(sx - 1) * 100,
    devYPct: Math.abs(sy - 1) * 100,
    originErrX: Math.abs(ox),
    originErrY: Math.abs(oy),
  }
}

function round4(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

/** 把一条校准结果套到设计坐标上（导出 / 预览统一入口） */
export function applyAffine(x: number, y: number, a: AxisAffine): { x: number; y: number } {
  return { x: x * a.kx + a.tx, y: y * a.ky + a.ty }
}

export function isIdentityAffine(a: AxisAffine): boolean {
  return a.kx === 1 && a.ky === 1 && a.tx === 0 && a.ty === 0
}

/**
 * 评估一条档案（或一次试算结果）是否偏差过大，需要重新校准而不是悄悄套用。
 * warnPct 为提醒阈值（%）；硬上下限之外直接判 bad（数值明显不合理）。
 */
export function assessCalibration(r: Pick<CalibrationResult, 'sx' | 'sy' | 'ox' | 'oy'>, sheet: Sheet, warnPct = DEFAULT_WARN_PCT): CalibrationStatus {
  const messages: string[] = []
  const dx = Math.abs(r.sx - 1) * 100
  const dy = Math.abs(r.sy - 1) * 100
  const maxDev = Math.max(dx, dy)
  const hardBad = r.sx < SCALE_HARD_MIN || r.sx > SCALE_HARD_MAX || r.sy < SCALE_HARD_MIN || r.sy > SCALE_HARD_MAX
  if (hardBad) {
    messages.push(`缩放系数 ${r.sx.toFixed(4)} / ${r.sy.toFixed(4)} 超出合理范围（${SCALE_HARD_MIN}~${SCALE_HARD_MAX}），请检查实测数值是否填错、试切件是否切全。`)
  } else if (maxDev > warnPct) {
    messages.push(`缩放偏差 ${maxDev.toFixed(2)}% 超过提醒阈值 ${warnPct}%（横向 ${dx.toFixed(2)}%、纵向 ${dy.toFixed(2)}%），建议重新校准，不要直接套用。`)
  }
  const maxOriginErr = Math.max(Math.abs(r.ox), Math.abs(r.oy))
  if (maxOriginErr > Math.min(sheet.widthMm, sheet.heightMm) * 0.05) {
    messages.push(`原点偏差 ${maxOriginErr.toFixed(1)}mm 偏大（超过纸幅短边的 5%），请检查装纸与机器原点设置。`)
  }
  return {
    level: hardBad ? 'bad' : messages.length > 0 ? 'warn' : 'ok',
    messages,
    maxScaleDevPct: maxDev,
  }
}

/** 评估档案与当前使用条件（纸幅、纸张）是否匹配 */
export function assessProfileUse(profile: CalibrationProfile, sheet: Sheet, paperKey?: string): CalibrationStatus {
  const r = { sx: profile.current.sx, sy: profile.current.sy, ox: profile.current.ox, oy: profile.current.oy }
  const st = assessCalibration(r, profile.sheet, profile.warnPct)
  const messages = [...st.messages]
  const dw = Math.abs(profile.sheet.widthMm - sheet.widthMm)
  const dh = Math.abs(profile.sheet.heightMm - sheet.heightMm)
  if (dw > 1 || dh > 1) {
    messages.unshift(`档案纸幅为 ${profile.sheet.widthMm}×${profile.sheet.heightMm}mm，当前纸张为 ${sheet.widthMm}×${sheet.heightMm}mm，纸幅不一致，不能直接套用，请用当前纸重新校准。`)
  }
  if (paperKey && profile.paperKey !== paperKey) {
    messages.unshift(`档案纸张为「${profile.paperLabel}」，当前材料不是这种纸。换一种纸伸缩不同，请为当前纸另做校准。`)
  }
  return { ...st, messages, level: messages.some((m) => m.includes('不能直接套用') || m.includes('不是这种纸')) ? 'bad' : st.level }
}

/** 同一台机器换纸前后差多少：与上一条档案对比 */
export function diffHistory(cur: CalibrationHistoryEntry, prev?: CalibrationHistoryEntry | null): { sxDelta: number; syDelta: number; oxDelta: number; oyDelta: number } | null {
  if (!prev) return null
  return {
    sxDelta: round4(cur.sx - prev.sx),
    syDelta: round4(cur.sy - prev.sy),
    oxDelta: round3(cur.ox - prev.ox),
    oyDelta: round3(cur.oy - prev.oy),
  }
}

export function paperKeyOf(paperCode: string, sheet: Sheet): string {
  return `${paperCode}@${Math.round(sheet.widthMm)}x${Math.round(sheet.heightMm)}`
}

// ---------------- 试切件生成（无补偿） ----------------

function hpgl(v: number): number {
  return Math.round(v / HPGL)
}

/** 生成试切刀路 PLT（原始坐标，不加补偿、不放边距） */
function buildPlt(n: CalibrationNominal, machine: string, paper: string): string {
  const L: string[] = []
  L.push('IN;SP1;')
  L.push(`CO"Paper-cut Plotter Studio calibration artifact / machine=${machine.replace(/["\\]/g, '')} paper=${paper.replace(/["\\]/g, '')}";`)
  L.push(`CO"nominal H=${n.lenX}mm V=${n.lenY}mm origin=(${n.originX},${n.originY}) unit=0.025mm origin=bottom_left";`)
  // 起点十字标记（轻切小叉，帮助量原点）
  const c = 2
  const ox = n.originX
  const oy = n.originY
  L.push(`PU${hpgl(ox - c)},${hpgl(oy - c)};PD${hpgl(ox + c)},${hpgl(oy + c)};`)
  L.push(`PU${hpgl(ox + c)},${hpgl(oy - c)};PD${hpgl(ox - c)},${hpgl(oy + c)};PU;`)
  // 横向标准线（带端点刻度）
  const tick = 3
  L.push(`PU${hpgl(ox)},${hpgl(oy)};PD${hpgl(ox + n.lenX)},${hpgl(oy)};PU;`)
  L.push(`PU${hpgl(ox)},${hpgl(oy - tick)};PD${hpgl(ox)},${hpgl(oy + tick)};`)
  L.push(`PU${hpgl(ox + n.lenX)},${hpgl(oy - tick)};PD${hpgl(ox + n.lenX)},${hpgl(oy + tick)};PU;`)
  // 纵向标准线（带端点刻度）
  L.push(`PU${hpgl(ox)},${hpgl(oy)};PD${hpgl(ox)},${hpgl(oy + n.lenY)};PU;`)
  L.push(`PU${hpgl(ox - tick)},${hpgl(oy)};PD${hpgl(ox + tick)},${hpgl(oy)};`)
  L.push(`PU${hpgl(ox - tick)},${hpgl(oy + n.lenY)};PD${hpgl(ox + tick)},${hpgl(oy + n.lenY)};PU;`)
  L.push('SP0;IN;')
  return L.join('\n') + '\n'
}

/** 1:1 说明书 SVG（纸幅坐标，y 向下）：画线条、刻度、名义长度与测量说明 */
function buildGuideSvg(n: CalibrationNominal, machine: string, paper: string): string {
  const { widthMm: W, heightMm: H } = n.sheet
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString()
  // SVG y 向下：指令 y（向上）→ svgY = H − y
  const Y = (y: number) => H - y
  const ox = n.originX
  const oy = Y(n.originY)
  const tick = 3
  const parts: string[] = []
  parts.push(
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" stroke="#000" stroke-width="0.2"/>`,
  )
  parts.push(`<g fill="none" stroke="#c0392b" stroke-width="0.3" stroke-linecap="round">`)
  // 十字起点
  parts.push(`<line x1="${f(ox - 2)}" y1="${f(oy - 2)}" x2="${f(ox + 2)}" y2="${f(oy + 2)}"/>`)
  parts.push(`<line x1="${f(ox + 2)}" y1="${f(oy - 2)}" x2="${f(ox - 2)}" y2="${f(oy + 2)}"/>`)
  // 横线 + 端点刻度
  parts.push(`<line x1="${f(ox)}" y1="${f(oy)}" x2="${f(ox + n.lenX)}" y2="${f(oy)}"/>`)
  parts.push(`<line x1="${f(ox)}" y1="${f(oy - tick)}" x2="${f(ox)}" y2="${f(oy + tick)}"/>`)
  parts.push(`<line x1="${f(ox + n.lenX)}" y1="${f(oy - tick)}" x2="${f(ox + n.lenX)}" y2="${f(oy + tick)}"/>`)
  // 竖线（SVG 中向上 = y 减小）+ 端点刻度
  parts.push(`<line x1="${f(ox)}" y1="${f(oy)}" x2="${f(ox)}" y2="${f(Y(n.originY + n.lenY))}"/>`)
  parts.push(`<line x1="${f(ox - tick)}" y1="${f(oy)}" x2="${f(ox + tick)}" y2="${f(oy)}"/>`)
  parts.push(
    `<line x1="${f(ox - tick)}" y1="${f(Y(n.originY + n.lenY))}" x2="${f(ox + tick)}" y2="${f(Y(n.originY + n.lenY))}"/>`,
  )
  parts.push(`</g>`)

  // 标注
  parts.push(
    `<g font-family="sans-serif" fill="#111">`,
    `<text x="${f(ox + n.lenX / 2)}" y="${f(oy + 5)}" font-size="3.2" text-anchor="middle">横向标准长度 ${n.lenX} mm（量两端刻度之间）</text>`,
    `<text x="${f(ox - 4)}" y="${f(Y(n.originY + n.lenY / 2))}" font-size="3.2" text-anchor="middle" transform="rotate(-90 ${f(ox - 4)} ${f(Y(n.originY + n.lenY / 2))})">纵向标准长度 ${n.lenY} mm</text>`,
    `<text x="${f(ox + 3)}" y="${f(oy - 3)}" font-size="2.8">起点十字（量它到纸左边、下边的距离）</text>`,
    `</g>`,
  )
  const info = [
    `机器校准试切件｜${machine}｜${paper}`,
    `纸幅 ${W}×${H}mm｜名义 横 ${n.lenX}mm / 纵 ${n.lenY}mm｜起点设计位置 距左 ${n.originX}mm 距下 ${n.originY}mm`,
    '用法：1) 用当前纸张切 PLT；2) 量横线实测长度、竖线实测长度；3) 量起点十字到纸左边与下边的距离；4) 把四个实测值填回校准页。',
  ]
  info.forEach((t, i) => parts.push(`<text x="6" y="${H - 24 + i * 4}" font-size="3" font-family="sans-serif" fill="#333">${esc(t)}</text>`))
  parts.push('</svg>', '')
  return parts.join('\n')
}

/** 按当前纸张与试切尺寸生成试切件（PLT + 说明书 SVG） */
export function buildCalibrationArtifact(nominal: CalibrationNominal, machine: string, paper: string): CalibrationArtifact {
  const n: CalibrationNominal = {
    ...nominal,
    lenX: Math.round(nominal.lenX * 10) / 10,
    lenY: Math.round(nominal.lenY * 10) / 10,
    originX: Math.round(nominal.originX * 10) / 10,
    originY: Math.round(nominal.originY * 10) / 10,
    sheet: { ...nominal.sheet },
  }
  return {
    nominal: n,
    plt: buildPlt(n, machine, paper),
    guideSvg: buildGuideSvg(n, machine, paper),
    segments: [
      { kind: 'h', x1: n.originX, y1: n.originY, x2: n.originX + n.lenX, y2: n.originY },
      { kind: 'v', x1: n.originX, y1: n.originY, x2: n.originX, y2: n.originY + n.lenY },
    ],
  }
}

export function formatDate(ts: number): string {
  const d = new Date(ts)
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
