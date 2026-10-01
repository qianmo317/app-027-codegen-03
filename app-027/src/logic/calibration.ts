import {
  CALIB_MARGIN_MM,
  CALIB_MIN_LEN_MM,
  DEFAULT_DRIFT_SCALE_PCT,
  DEFAULT_WARN_ORIGIN_MM,
  DEFAULT_WARN_SCALE_PCT,
  type CalibrationMeasurement,
  type CalibrationProfile,
  type Pt,
  type Sheet,
} from './types'
import { round3, uid } from './geometry'
import { PAPER_KINDS } from './types'
import type { CutStep } from './order'

export function paperText(paper: string, label?: string): string {
  if (label && label !== paper) return label
  return PAPER_KINDS.find((p) => p.paper === paper)?.label ?? paper
}

/** 取整到 10mm 的标准线长，尽量铺满纸幅（两端各留 margin），下限 50mm */
export function stdLength(sheetSpanMm: number, marginMm = CALIB_MARGIN_MM): number {
  const v = Math.floor((sheetSpanMm - marginMm * 2) / 10) * 10
  return Math.max(CALIB_MIN_LEN_MM, v)
}

export type CalibGeometry = {
  /** 设计坐标下的切割段（L 形横/竖两条标准线 + 端部刻度），配合 identity 摆放 */
  steps: CutStep[]
  stdXMm: number
  stdYMm: number
  marginMm: number
}

function mkStep(points: Pt[], id: string): CutStep {
  const closed = false
  let lengthMm = 0
  for (let i = 1; i < points.length; i++) lengthMm += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  return {
    seq: 0,
    contourId: id,
    runIndex: 0,
    runCount: 1,
    points,
    closed,
    startPt: points[0],
    endPt: points[points.length - 1],
    travelFromPrevMm: 0,
    level: 1,
    layer: 0,
    lengthMm,
  }
}

/**
 * 试切件：物理（机器左下原点）上左下角 (margin, margin) 起，一条横线 + 一条竖线，
 * 线端带 4mm 小刻度便于卡尺对齐。全部为开放段、无连刀点。
 *
 * 内部坐标沿用全应用的「左上原点、y 向下」约定，PLT 导出时经 y′ = H − y 翻到左下，
 * 切出来的角点距纸左缘、下缘均为 margin；SVG 检查图在 buildCalibSheet 内再翻回显示。
 * 坐标即摆放后坐标（identity placement：scale=1, offset=0）。
 */
export function buildCalibGeometry(sheet: Sheet, marginMm = CALIB_MARGIN_MM): CalibGeometry {
  const stdXMm = stdLength(sheet.widthMm, marginMm)
  const stdYMm = stdLength(sheet.heightMm, marginMm)
  const tick = 4
  const x0 = marginMm
  // 内部 y 向下：物理下角点 y=margin 对应内部 y = H − margin
  const yi0 = sheet.heightMm - marginMm
  const x1 = x0 + stdXMm
  const yi1 = yi0 - stdYMm

  const steps: CutStep[] = []
  // 横向标准线（物理上沿 x）
  steps.push(mkStep([{ x: x0, y: yi0 }, { x: x1, y: yi0 }], 'calib-h'))
  // 纵向标准线（物理上沿 y 向上；内部即 y 减小）
  steps.push(mkStep([{ x: x0, y: yi0 }, { x: x0, y: yi1 }], 'calib-v'))
  // 端部刻度：横线起止处上下各一小段
  for (const x of [x0, x1]) {
    steps.push(mkStep([{ x, y: yi0 - tick / 2 }, { x, y: yi0 + tick / 2 }], `calib-tx-${x}`))
  }
  // 竖线起止处左右各一小段
  for (const y of [yi0, yi1]) {
    steps.push(mkStep([{ x: x0 - tick / 2, y }, { x: x0 + tick / 2, y }], `calib-ty-${y}`))
  }
  steps.forEach((s, i) => (s.seq = i + 1))
  return { steps, stdXMm, stdYMm, marginMm }
}

export type CalibInput = {
  machine: string
  paper: string
  paperLabel: string
  sheet: Sheet
  measuredXMm: number
  measuredYMm: number
  originXMm: number
  originYMm: number
  stdXMm: number
  stdYMm: number
  marginMm: number
  note?: string
  warnScalePct?: number
  warnOriginMm?: number
  driftScalePct?: number
}

/**
 * 由实测长度反算机器×纸张补偿参数。
 * 机器物理模型：physical = commanded / s + e（s 为机器实际缩放，e 为机器原点相对纸缘的物理偏差）。
 *   标准线 commanded 长 std → 实测 std/s，故缩放补偿 s = 标准 / 实测；
 *   角点 commanded 在 testMargin → 实测原点 = testMargin/s + e，故 e = 实测原点 − testMargin/s；
 *   导出时需要的原点指令平移 ox = −s·e = testMargin − s·实测原点
 *   （把设计原点指令到 s·margin+ox 处，切出来正好落在物理 margin 上）。
 */
export function computeCalibration(
  input: CalibInput,
): { measurement: CalibrationMeasurement; scaleX: number; scaleY: number; offsetXMm: number; offsetYMm: number; error: string | null } {
  const error = validateMeasurement(input)
  const sx = input.stdXMm / input.measuredXMm
  const sy = input.stdYMm / input.measuredYMm
  const ox = input.marginMm - sx * input.originXMm
  const oy = input.marginMm - sy * input.originYMm
  const measurement: CalibrationMeasurement = {
    id: uid('calm'),
    measuredXMm: round3(input.measuredXMm),
    measuredYMm: round3(input.measuredYMm),
    originXMm: round3(input.originXMm),
    originYMm: round3(input.originYMm),
    createdAt: Date.now(),
    scaleX: round3(sx),
    scaleY: round3(sy),
    offsetXMm: round3(ox),
    offsetYMm: round3(oy),
  }
  return {
    measurement,
    scaleX: round3(sx),
    scaleY: round3(sy),
    offsetXMm: round3(ox),
    offsetYMm: round3(oy),
    error,
  }
}

export function validateMeasurement(input: CalibInput): string | null {
  if (!input.machine.trim()) return '请填写机器名'
  if (!(input.measuredXMm > 0) || !(input.measuredYMm > 0)) return '实测长度必须大于 0'
  if (input.measuredXMm > input.stdXMm * 1.5 || input.measuredXMm < input.stdXMm * 0.5)
    return `横向实测 ${input.measuredXMm}mm 与标准 ${input.stdXMm}mm 相差过大，请确认量的是横线全长`
  if (input.measuredYMm > input.stdYMm * 1.5 || input.measuredYMm < input.stdYMm * 0.5)
    return `纵向实测 ${input.measuredYMm}mm 与标准 ${input.stdYMm}mm 相差过大，请确认量的是竖线全长`
  if (input.originXMm < -5 || input.originXMm > input.marginMm + 15)
    return `横向原点距离 ${input.originXMm}mm 异常（应在 0 ~ ${input.marginMm + 15}mm 附近）`
  if (input.originYMm < -5 || input.originYMm > input.marginMm + 15)
    return `纵向原点距离 ${input.originYMm}mm 异常（应在 0 ~ ${input.marginMm + 15}mm 附近）`
  return null
}

/** 新建或追加一条校准档案（同机同纸追加测量记录，取最新一次为生效参数） */
export function upsertCalibration(
  profiles: CalibrationProfile[],
  input: CalibInput,
): { profiles: CalibrationProfile[]; profile: CalibrationProfile; created: boolean } {
  const calc = computeCalibration(input)
  if (calc.error) throw new Error(calc.error)
  const now = Date.now()
  const key = (p: CalibrationProfile) => profileKey(p.machine, p.paper)
  const idx = profiles.findIndex((p) => key(p) === profileKey(input.machine, input.paper))
  const created = idx < 0
  const prev = idx >= 0 ? profiles[idx] : null
  const profile: CalibrationProfile = prev
    ? {
        ...prev,
        sheet: { ...input.sheet },
        stdXMm: input.stdXMm,
        stdYMm: input.stdYMm,
        marginMm: input.marginMm,
        scaleX: calc.scaleX,
        scaleY: calc.scaleY,
        offsetXMm: calc.offsetXMm,
        offsetYMm: calc.offsetYMm,
        updatedAt: now,
        paperLabel: input.paperLabel,
        note: input.note ?? prev.note,
        warnScalePct: input.warnScalePct ?? prev.warnScalePct,
        warnOriginMm: input.warnOriginMm ?? prev.warnOriginMm,
        driftScalePct: input.driftScalePct ?? prev.driftScalePct,
        history: [...prev.history, calc.measurement],
      }
    : {
        id: uid('calp'),
        machine: input.machine.trim(),
        paper: input.paper,
        paperLabel: input.paperLabel,
        sheet: { ...input.sheet },
        stdXMm: input.stdXMm,
        stdYMm: input.stdYMm,
        marginMm: input.marginMm,
        scaleX: calc.scaleX,
        scaleY: calc.scaleY,
        offsetXMm: calc.offsetXMm,
        offsetYMm: calc.offsetYMm,
        warnScalePct: input.warnScalePct ?? DEFAULT_WARN_SCALE_PCT,
        warnOriginMm: input.warnOriginMm ?? DEFAULT_WARN_ORIGIN_MM,
        driftScalePct: input.driftScalePct ?? DEFAULT_DRIFT_SCALE_PCT,
        createdAt: now,
        updatedAt: now,
        history: [calc.measurement],
        note: input.note ?? '',
      }
  const next = idx >= 0 ? profiles.map((p, i) => (i === idx ? profile : p)) : [...profiles, profile]
  return { profiles: next, profile, created }
}

export function profileKey(machine: string, paper: string): string {
  return `${machine.trim().toLowerCase()}｜${paper}`
}

export function profileLabel(p: CalibrationProfile): string {
  return `${p.machine} · ${paperText(p.paper, p.paperLabel)}`
}

export type CalibWarning = {
  level: 'ok' | 'warn' | 'err'
  messages: string[]
}

/** 档案本身是否已偏到不可静默套用（缩放偏差超阈值 / 原点修正过大） */
export function profileStatus(p: CalibrationProfile): CalibWarning {
  const messages: string[] = []
  const devX = (p.scaleX - 1) * 100
  const devY = (p.scaleY - 1) * 100
  if (Math.abs(devX) > p.warnScalePct) messages.push(`横向缩放补偿 ${(p.scaleX * 100).toFixed(3)}%（偏差 ${devX.toFixed(2)}%，超过 ${p.warnScalePct}%）`)
  if (Math.abs(devY) > p.warnScalePct) messages.push(`纵向缩放补偿 ${(p.scaleY * 100).toFixed(3)}%（偏差 ${devY.toFixed(2)}%，超过 ${p.warnScalePct}%）`)
  if (Math.abs(p.offsetXMm) > p.warnOriginMm) messages.push(`横向原点修正 ${p.offsetXMm.toFixed(2)}mm（超过 ${p.warnOriginMm}mm）`)
  if (Math.abs(p.offsetYMm) > p.warnOriginMm) messages.push(`纵向原点修正 ${p.offsetYMm.toFixed(2)}mm（超过 ${p.warnOriginMm}mm）`)
  if (messages.length > 0) return { level: 'err', messages }
  return { level: 'ok', messages: ['补偿在阈值内，可正常套用'] }
}

/** 与上一次校准相比，机器/纸张状态漂移（不静默套用旧档案的依据之一） */
export function profileDrift(p: CalibrationProfile): { dxPct: number; dyPct: number; drifted: boolean; messages: string[] } {
  const h = p.history
  if (h.length < 2) return { dxPct: 0, dyPct: 0, drifted: false, messages: [] }
  const a = h[h.length - 2]
  const b = h[h.length - 1]
  const dxPct = ((b.scaleX - a.scaleX) / a.scaleX) * 100
  const dyPct = ((b.scaleY - a.scaleY) / a.scaleY) * 100
  const drifted = Math.abs(dxPct) > p.driftScalePct || Math.abs(dyPct) > p.driftScalePct
  const messages: string[] = []
  if (Math.abs(dxPct) > p.driftScalePct) messages.push(`横向缩放两次校准相差 ${dxPct.toFixed(2)}%`)
  if (Math.abs(dyPct) > p.driftScalePct) messages.push(`纵向缩放两次校准相差 ${dyPct.toFixed(2)}%`)
  return { dxPct, dyPct, drifted, messages }
}

/** 同机换纸对比（任意两条档案） */
export function compareProfiles(a: CalibrationProfile, b: CalibrationProfile): {
  dScaleXPct: number
  dScaleYPct: number
  dOffsetXMm: number
  dOffsetYMm: number
} {
  return {
    dScaleXPct: ((b.scaleX - a.scaleX) / a.scaleX) * 100,
    dScaleYPct: ((b.scaleY - a.scaleY) / a.scaleY) * 100,
    dOffsetXMm: b.offsetXMm - a.offsetXMm,
    dOffsetYMm: b.offsetYMm - a.offsetYMm,
  }
}

/**
 * 编辑页补偿预览：把设计点变换到「不补偿直接切，实际得到的成品」所在的设计坐标。
 * 补偿导出：commanded_min = s·margin + ox（ox = −s·e），切出 physical = margin。
 * 不补偿时 commanded_min = margin，切出 physical = margin/s + e = margin/s − ox/s。
 * 相对设计（物理 margin）整体平移 −(margin − ox)/s，缩放 1/s：
 *   x_unc = x_design / s − (margin − ox) / s
 * 取纸边距为 0 的设计预览时，红线即「同机不补偿会切出的样子」，与绿线（=设计）并摆可见缩放与位置差。
 */
export function uncompensatedPoint(p: Pt, profile: CalibrationProfile): Pt {
  const m = SHEET_MARGIN_PREVIEW
  return {
    x: (p.x - (m - profile.offsetXMm)) / profile.scaleX,
    y: (p.y - (m - profile.offsetYMm)) / profile.scaleY,
  }
}

/** 预览参考边距（与导出 computePlacement 默认边距一致） */
export const SHEET_MARGIN_PREVIEW = 10

/** 未补偿件的包围盒（供预览自适应） */
export function uncompensatedBounds(
  b: { minX: number; minY: number; maxX: number; maxY: number },
  profile: CalibrationProfile,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const tr = (x: number, y: number) => uncompensatedPoint({ x, y }, profile)
  const a = tr(b.minX, b.minY)
  const c = tr(b.maxX, b.maxY)
  return { minX: a.x, minY: a.y, maxX: c.x, maxY: c.y }
}
