import type { AxisAffine, ExportCfg, MaterialPreset, Pt, Sheet } from './types'
import { IDENTITY_AFFINE } from './types'
import type { CutStep } from './order'
import { applyAffine } from './calibration'
import { boundsOf, dist } from './geometry'

export type SheetPlacement = {
  /** 纸面内边距（mm） */
  marginMm: number
  offsetX: number
  offsetY: number
  scale: number
  /** 导出补偿（指令空间，纸幅左下原点 y 向上） */
  comp: AxisAffine
  /** 换算到内部 / SVG 空间（左上原点 y 向下）后的补偿 */
  compDown: AxisAffine
  sheetHeightMm: number
  outOfSheet: boolean
  placedBounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** 补偿后、放边距后的指令坐标范围（纸幅左下原点，y 向上，mm） */
  commandBounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export const SHEET_MARGIN_MM = 10

/**
 * 校准补偿仿射定义在指令空间（纸幅左下原点，y 向上，HPGL 约定）；
 * 内部摆放与 SVG 导出用左上原点、y 向下。轴缩放与 y 翻转可交换，
 * 平移量需要换算：y_down = H − y_up，于是 t_down(y) = H − (ky·H + ty)。
 */
export function affineYUpToYDown(comp: AxisAffine, sheetH: number): AxisAffine {
  return { kx: comp.kx, ky: comp.ky, tx: comp.tx, ty: sheetH - (comp.ky * sheetH + comp.ty) }
}

/**
 * 计算摆放：先按校准档案做轴仿射补偿，再乘用户缩放并放进纸面边距。
 *
 * 机器物理模型 px = sx·qx + ox，设计点 x（原始、未补偿）希望切在
 * margin + scale·(x − min) 的物理位置。代入解得下发指令：
 *   qx = kx·scale·(x − b.minX) + kx·margin + tx，  kx = 1/sx，tx = −ox/sx
 * 纵向在 y 向下空间对称（ox→ty_down、min 取 max，边距落在下边）。
 * 即：摆放相对原始包围盒（不是补偿后包围盒），避免重新居中把原点补偿吃掉。
 */
export function computePlacement(
  steps: CutStep[],
  sheet: Sheet,
  scale: number,
  marginMm = SHEET_MARGIN_MM,
  comp: AxisAffine = IDENTITY_AFFINE,
): SheetPlacement {
  const pts: Pt[] = []
  for (const st of steps) pts.push(...st.points)
  const b = pts.length > 0 ? boundsOf(pts) : { minX: 0, minY: 0, maxX: 0, maxY: 0 }

  const dc = affineYUpToYDown(comp, sheet.heightMm)

  // 目标物理（y 向上）：Tx = margin + s·(px − b.minX)
  //                    Ty = H − margin − s·(py − b.minY)
  // 指令 Q = k·目标 + t；导出时 Qy 由内部 y 向下点经 qd.y = H − Qy 映射，复合得：
  //   qd.x = kx·s·px + kx·(margin − s·b.minX) + tx
  //   qd.y = ky·s·py + ky·(margin − s·b.minY) + H·(1−ky) − ty
  // 身份仿射时退化为旧公式：margin + s·(坐标 − 包围盒最小值)。
  const placeAffine: AxisAffine = {
    kx: dc.kx * scale,
    ky: dc.ky * scale,
    tx: dc.kx * (marginMm - scale * b.minX) + comp.tx,
    ty: dc.ky * (marginMm - scale * b.minY) + dc.ty,
  }

  // 补偿后实际下发指令（y 向下空间）的四角极值
  const corners = [
    applyAffine(b.minX, b.minY, placeAffine),
    applyAffine(b.minX, b.maxY, placeAffine),
    applyAffine(b.maxX, b.minY, placeAffine),
    applyAffine(b.maxX, b.maxY, placeAffine),
  ]
  const cb = boundsOf(corners)

  // placePoint 需要 (A, off=0) 形式，因此 offset 全并入仿射的 tx/ty
  const placed = cb
  const commandBounds = {
    minX: placed.minX,
    maxX: placed.maxX,
    minY: sheet.heightMm - placed.maxY,
    maxY: sheet.heightMm - placed.minY,
  }
  const outOfSheet =
    placed.minX < -0.01 || placed.minY < -0.01 || placed.maxX > sheet.widthMm + 0.01 || placed.maxY > sheet.heightMm + 0.01
  return {
    marginMm,
    offsetX: 0,
    offsetY: 0,
    scale,
    comp,
    compDown: placeAffine,
    sheetHeightMm: sheet.heightMm,
    outOfSheet,
    placedBounds: placed,
    commandBounds,
  }
}

/** 设计点 → 纸幅坐标（内部左上 y 向下）：先补偿、再缩放、再放边距 */
export function placePoint(p: Pt, pl: SheetPlacement): Pt {
  return applyAffine(p.x, p.y, pl.compDown)
}

export type ExportMeta = {
  projectName: string
  formName: string
  material: MaterialPreset
  bridgeWidthMm: number
  passes: number
  sheet: Sheet
  cutLengthMm: number
  travelMm: number
  /** 校准档案标注（机器 / 纸张 / 缩放系数），写进文件头便于上机核对 */
  calibrationLabel?: string | null
}

export type ExportStats = {
  text: string
  runCount: number
  pointCount: number
  minX: number
  minY: number
  maxX: number
  maxY: number
  outOfSheet: boolean
  sheetMaxX: number
  sheetMaxY: number
  unitLabel: string
  repeatPasses: number
  feedMmPerMin: number
}

/** 导出坐标：单位换算 + 原点翻到左下（y' = 纸幅高 − y） */
function toExportUnits(p: Pt, cfg: ExportCfg, sheet: Sheet, pl: SheetPlacement): { x: number; y: number } {
  const q = placePoint(p, pl)
  const y = cfg.origin === 'bottom_left' || cfg.yFlip ? sheet.heightMm - q.y : q.y
  if (cfg.unit === '0.025mm') {
    return { x: Math.round(q.x / 0.025), y: Math.round(y / 0.025) }
  }
  return { x: Math.round(q.x * 100) / 100, y: Math.round(y * 100) / 100 }
}

function num(v: number, unit: 'mm' | '0.025mm'): string {
  return unit === '0.025mm' ? String(Math.round(v)) : v.toFixed(2)
}

/** PLT（HPGL）：1 unit = 0.025mm，原点左下 */
export function exportPlt(steps: CutStep[], cfg: ExportCfg, sheet: Sheet, meta: ExportMeta, pl: SheetPlacement): ExportStats {
  const lines: string[] = []
  lines.push(`IN;SP1;`)
  lines.push(`CO"Paper-cut Plotter Studio / ${sanitize(meta.projectName)}";`)
  lines.push(
    `CO"paper=${meta.material.paper} force=${meta.material.force} speed=${meta.material.speedMmS}mm/s passes=${meta.passes} bridge=${meta.bridgeWidthMm}mm";`,
  )
  lines.push(`CO"sheet=${meta.sheet.widthMm}x${meta.sheet.heightMm}mm origin=bottom_left unit=${cfg.unit} scale=${cfg.scale}";`)
  if (meta.calibrationLabel) lines.push(`CO"calibration=${sanitize(meta.calibrationLabel)}";`)

  let runCount = 0
  let pointCount = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const track = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  for (const st of steps) {
    const first = toExportUnits(st.points[0], cfg, sheet, pl)
    const cmds: string[] = [`PU${num(first.x, cfg.unit)},${num(first.y, cfg.unit)};`]
    track(first.x, first.y)
    pointCount += 1
    for (let i = 1; i < st.points.length; i++) {
      const q = toExportUnits(st.points[i], cfg, sheet, pl)
      cmds.push(`PD${num(q.x, cfg.unit)},${num(q.y, cfg.unit)};`)
      track(q.x, q.y)
      pointCount += 1
    }
    if (st.closed) {
      const q = toExportUnits(st.points[0], cfg, sheet, pl)
      cmds.push(`PD${num(q.x, cfg.unit)},${num(q.y, cfg.unit)};`)
      pointCount += 1
    }
    cmds.push('PU;')
    lines.push(cmds.join(''))
    runCount += 1
  }
  lines.push('SP0;IN;')

  const sheetMaxX = cfg.unit === '0.025mm' ? Math.round(sheet.widthMm / 0.025) : sheet.widthMm
  const sheetMaxY = cfg.unit === '0.025mm' ? Math.round(sheet.heightMm / 0.025) : sheet.heightMm
  const outOfSheet = minX < -0.001 || minY < -0.001 || maxX > sheetMaxX + 0.001 || maxY > sheetMaxY + 0.001

  return {
    text: lines.join('\n') + '\n',
    runCount,
    pointCount,
    minX: Number.isFinite(minX) ? minX : 0,
    minY: Number.isFinite(minY) ? minY : 0,
    maxX: Number.isFinite(maxX) ? maxX : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
    outOfSheet,
    sheetMaxX,
    sheetMaxY,
    unitLabel: cfg.unit === '0.025mm' ? '0.025mm/unit' : 'mm',
    repeatPasses: meta.passes,
    feedMmPerMin: meta.material.speedMmS * 60,
  }
}

/** G-code（桌面机自组装）：单位 mm、绝对坐标、Z 抬刀、重复次数 */
export function exportGcode(steps: CutStep[], cfg: ExportCfg, sheet: Sheet, meta: ExportMeta, pl: SheetPlacement): ExportStats {
  const feed = Math.max(1, Math.round(meta.material.speedMmS * 60))
  const travelFeed = Math.max(feed, 3000)
  const passes = Math.max(1, Math.round(meta.passes))
  const lines: string[] = []
  lines.push('; Paper-cut Plotter Studio - G-code for desktop plotter')
  lines.push(`; project=${meta.projectName} form=${meta.formName}`)
  lines.push(`; paper=${meta.material.paper} force=${meta.material.force} speed=${meta.material.speedMmS}mm/s passes=${passes}`)
  lines.push(`; sheet=${meta.sheet.widthMm}x${meta.sheet.heightMm}mm origin=${cfg.origin} scale=${cfg.scale}`)
  if (meta.calibrationLabel) lines.push(`; calibration=${meta.calibrationLabel}`)
  lines.push('G21 ; mm')
  lines.push('G90 ; absolute')
  lines.push('G0 Z0 ; blade up')
  lines.push(`G0 F${travelFeed}`)

  let runCount = 0
  let pointCount = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const track = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const fmt = (v: number) => v.toFixed(3)

  for (let pass = 1; pass <= passes; pass++) {
    lines.push(`; ---- pass ${pass}/${passes} ----`)
    for (const st of steps) {
      const seq = st.points.map((p) => {
        const q = toExportUnits(p, { ...cfg, unit: 'mm' }, sheet, pl)
        return { x: q.x, y: q.y }
      })
      const first = seq[0]
      lines.push(`G0 X${fmt(first.x)} Y${fmt(first.y)} F${travelFeed}`)
      lines.push(`G1 Z-1.000 F${Math.max(1, Math.round(meta.material.force))}`)
      track(first.x, first.y)
      pointCount += 1
      for (let i = 1; i < seq.length; i++) {
        lines.push(`G1 X${fmt(seq[i].x)} Y${fmt(seq[i].y)} F${feed}`)
        track(seq[i].x, seq[i].y)
        pointCount += 1
      }
      if (st.closed) {
        lines.push(`G1 X${fmt(first.x)} Y${fmt(first.y)} F${feed}`)
        pointCount += 1
      }
      lines.push('G0 Z0')
      runCount += 1
    }
  }
  lines.push('G0 X0 Y0')
  lines.push('M2 ; end')

  const outOfSheet = minX < -0.001 || minY < -0.001 || maxX > sheet.widthMm + 0.001 || maxY > sheet.heightMm + 0.001
  return {
    text: lines.join('\n') + '\n',
    runCount,
    pointCount,
    minX: Number.isFinite(minX) ? minX : 0,
    minY: Number.isFinite(minY) ? minY : 0,
    maxX: Number.isFinite(maxX) ? maxX : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
    outOfSheet,
    sheetMaxX: sheet.widthMm,
    sheetMaxY: sheet.heightMm,
    unitLabel: 'mm',
    repeatPasses: passes,
    feedMmPerMin: feed,
  }
}

/** SVG：带连刀点的可切版本（保留内部左上原点，1 单位 = 1mm） */
export function exportSvg(steps: CutStep[], cfg: ExportCfg, sheet: Sheet, meta: ExportMeta, pl: SheetPlacement): ExportStats {
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString()
  const paths: string[] = []
  let pointCount = 0
  for (const st of steps) {
    const q = st.points.map((p) => placePoint(p, pl))
    let d = `M${f(q[0].x)} ${f(q[0].y)}`
    for (let i = 1; i < q.length; i++) d += `L${f(q[i].x)} ${f(q[i].y)}`
    if (st.closed) d += 'Z'
    paths.push(`    <path d="${d}" />`)
    pointCount += q.length
  }
  const text = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.widthMm}mm" height="${sheet.heightMm}mm" viewBox="0 0 ${sheet.widthMm} ${sheet.heightMm}">`,
    `  <title>${escapeXml(meta.projectName)} - 剪纸刀路（含连刀点）</title>`,
    `  <desc>bridge=${meta.bridgeWidthMm}mm sheet=${sheet.widthMm}x${sheet.heightMm}mm cut=${meta.cutLengthMm.toFixed(1)}mm origin=${cfg.origin} scale=${cfg.scale}${meta.calibrationLabel ? ` calibration=${escapeXml(meta.calibrationLabel)}` : ''}</desc>`,
    `  <rect x="0" y="0" width="${sheet.widthMm}" height="${sheet.heightMm}" fill="none" stroke="#cccccc" stroke-width="0.1"/>`,
    '  <g fill="none" stroke="#c0392b" stroke-width="0.25" stroke-linecap="round" stroke-linejoin="round">',
    ...paths,
    '  </g>',
    '</svg>',
    '',
  ].join('\n')

  const placed = pl.placedBounds
  return {
    text,
    runCount: steps.length,
    pointCount,
    minX: placed.minX,
    minY: placed.minY,
    maxX: placed.maxX,
    maxY: placed.maxY,
    outOfSheet: pl.outOfSheet,
    sheetMaxX: sheet.widthMm,
    sheetMaxY: sheet.heightMm,
    unitLabel: 'mm',
    repeatPasses: meta.passes,
    feedMmPerMin: meta.material.speedMmS * 60,
  }
}

/** A4 排版检查图（1:1，含 100mm 校验尺）；返回可打印的 SVG 字符串 */
export function buildA4Sheet(
  steps: CutStep[],
  sheet: Sheet,
  meta: ExportMeta,
  pl: SheetPlacement,
  opts: { showNumbers: boolean; showTravel: boolean; title: string },
): string {
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString()
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.widthMm}mm" height="${sheet.heightMm}mm" viewBox="0 0 ${sheet.widthMm} ${sheet.heightMm}">`,
  )
  parts.push(`<rect x="0" y="0" width="${sheet.widthMm}" height="${sheet.heightMm}" fill="#ffffff" stroke="#000000" stroke-width="0.2"/>`)

  // 纸幅内边距参考线
  parts.push(
    `<rect x="${pl.marginMm}" y="${pl.marginMm}" width="${sheet.widthMm - pl.marginMm * 2}" height="${sheet.heightMm - pl.marginMm * 2}" fill="none" stroke="#bbbbbb" stroke-width="0.1" stroke-dasharray="2 2"/>`,
  )

  // 切割路径
  const pathParts: string[] = []
  for (const st of steps) {
    const q = st.points.map((p) => placePoint(p, pl))
    let d = `M${f(q[0].x)} ${f(q[0].y)}`
    for (let i = 1; i < q.length; i++) d += `L${f(q[i].x)} ${f(q[i].y)}`
    if (st.closed) d += 'Z'
    pathParts.push(`<path d="${d}"/>`)
  }
  parts.push(`<g fill="none" stroke="#111111" stroke-width="0.15" stroke-linecap="round" stroke-linejoin="round">${pathParts.join('')}</g>`)

  if (opts.showTravel) {
    const travels: string[] = []
    for (let i = 1; i < steps.length; i++) {
      const a = placePoint(steps[i - 1].endPt, pl)
      const b = placePoint(steps[i].startPt, pl)
      travels.push(`<line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}"/>`)
    }
    parts.push(`<g stroke="#888888" stroke-width="0.08" stroke-dasharray="1 1">${travels.join('')}</g>`)
  }

  if (opts.showNumbers) {
    const labels: string[] = []
    steps.forEach((st, i) => {
      const p = placePoint(st.startPt, pl)
      labels.push(`<text x="${f(p.x + 0.6)}" y="${f(p.y - 0.6)}" font-size="2" fill="#c0392b">${i + 1}</text>`)
    })
    parts.push(`<g font-family="sans-serif">${labels.join('')}</g>`)
  }

  // 100mm 校验尺（1:1 打印后用直尺核对）
  const rx = pl.marginMm
  const ry = sheet.heightMm - 12
  const tick = (x: number, len: number) => `<line x1="${f(x)}" y1="${f(ry - len / 2)}" x2="${f(x)}" y2="${f(ry + len / 2)}" stroke="#000" stroke-width="0.2"/>`
  const ruler: string[] = []
  ruler.push(`<line x1="${f(rx)}" y1="${f(ry)}" x2="${f(rx + 100)}" y2="${f(ry)}" stroke="#000" stroke-width="0.3"/>`)
  for (let i = 0; i <= 10; i++) {
    ruler.push(tick(rx + i * 10, i % 5 === 0 ? 4 : 2))
    ruler.push(
      `<text x="${f(rx + i * 10)}" y="${f(ry + 6)}" font-size="2.4" text-anchor="middle" font-family="sans-serif" fill="#000">${i * 10}</text>`,
    )
  }
  // 50mm 竖向校验
  const vx = sheet.widthMm - 10
  ruler.push(`<line x1="${f(vx)}" y1="${f(ry)}" x2="${f(vx)}" y2="${f(ry - 50)}" stroke="#000" stroke-width="0.3"/>`)
  for (let i = 0; i <= 5; i++) {
    ruler.push(
      `<line x1="${f(vx - 2)}" y1="${f(ry - i * 10)}" x2="${f(vx + 2)}" y2="${f(ry - i * 10)}" stroke="#000" stroke-width="0.2"/>`,
    )
  }
  parts.push(`<g>${ruler.join('')}</g>`)

  const info = [
    `${opts.title || meta.projectName}`,
    `纹样：${meta.formName}`,
    `纸幅：${sheet.widthMm}×${sheet.heightMm}mm（1:1 打印，请勿缩放）`,
    `材料：${meta.material.name}｜刀压 ${meta.material.force}｜速度 ${meta.material.speedMmS}mm/s｜重复 ${meta.passes} 次`,
    `连刀点宽 ${meta.bridgeWidthMm}mm｜刀路总长 ${meta.cutLengthMm.toFixed(1)}mm｜跳刀 ${meta.travelMm.toFixed(1)}mm`,
    `切割段数 ${steps.length}｜原点 左下`,
  ]
  if (meta.calibrationLabel) info.push(`机器校准：${meta.calibrationLabel}（刀路已按档案预补偿）`)
  info.forEach((line, i) => {
    parts.push(
      `<text x="${f(pl.marginMm)}" y="${f(sheet.heightMm - 26 + i * 3.4)}" font-size="2.8" font-family="sans-serif" fill="#000">${escapeXml(line)}</text>`,
    )
  })
  parts.push('</svg>')
  return parts.join('\n')
}

function sanitize(s: string): string {
  return s.replace(/["\\]/g, '')
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 共边裁切：同一段路径只切一次（相邻复制件重叠的边） */
export function dedupeSharedEdges<T extends CutStep>(steps: T[], tol = 0.02): T[] {
  const seen = new Set<string>()
  const key = (a: Pt, b: Pt): string => {
    const f = (v: number) => Math.round(v / tol)
    const k1 = `${f(a.x)},${f(a.y)}`
    const k2 = `${f(b.x)},${f(b.y)}`
    return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`
  }
  const out: T[] = []
  let seq = 0
  for (const st of steps) {
    const pts = st.points
    const runs: Pt[][] = []
    let cur: Pt[] = [pts[0]]
    const n = pts.length
    const segCount = st.closed ? n : n - 1
    for (let i = 0; i < segCount; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      const k = key(a, b)
      if (seen.has(k)) {
        if (cur.length >= 2) runs.push(cur)
        cur = [b]
      } else {
        seen.add(k)
        cur.push(b)
      }
    }
    if (st.closed && cur.length >= 2 && dist(cur[cur.length - 1], cur[0]) <= tol) {
      runs.push(cur.slice(0, cur.length - 1))
    } else if (cur.length >= 2) {
      runs.push(cur)
    }
    for (const r of runs) {
      if (r.length < 2) continue
      seq += 1
      out.push({
        ...st,
        seq,
        points: r,
        closed: false,
        startPt: r[0],
        endPt: r[r.length - 1],
        travelFromPrevMm: 0,
        lengthMm: r.reduce((acc, p, i) => (i === 0 ? 0 : acc + dist(r[i - 1], p)), 0),
      })
    }
  }
  return out
}