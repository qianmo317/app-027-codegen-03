import type { CalibrationProfile, ExportCfg, MaterialPreset, Pt, Sheet } from './types'
import type { CutStep } from './order'
import { boundsOf, dist } from './geometry'

export type SheetPlacement = {
  /** 纸面内边距（mm） */
  marginMm: number
  offsetX: number
  offsetY: number
  /** 用户缩放（不含机器补偿） */
  scale: number
  /** 实际生效缩放 = 用户缩放 × 校准补偿 */
  scaleX: number
  scaleY: number
  /** 生效的校准档案（无则为 null） */
  profile: CalibrationProfile | null
  outOfSheet: boolean
  placedBounds: { minX: number; minY: number; maxX: number; maxY: number }
}

export const SHEET_MARGIN_MM = 10

/** 摆放：先按校准档案做缩放/原点补偿，再整体平移，使补偿后包围盒左下落到纸边距 */
export function computePlacement(
  steps: CutStep[],
  sheet: Sheet,
  scale: number,
  marginMm: number = SHEET_MARGIN_MM,
  profile: CalibrationProfile | null = null,
): SheetPlacement {
  const pts: Pt[] = []
  for (const st of steps) pts.push(...st.points)
  const b = pts.length > 0 ? boundsOf(pts) : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  const calSx = profile?.scaleX ?? 1
  const calSy = profile?.scaleY ?? 1
  const calOx = profile?.offsetXMm ?? 0
  const calOy = profile?.offsetYMm ?? 0
  const scaleX = scale * calSx
  const scaleY = scale * calSy
  // 补偿后的指令坐标（未加摆放平移）：comp = s·design + o（o = −s·e）
  const compMinX = b.minX * calSx + calOx
  const compMinY = b.minY * calSy + calOy
  const compMaxX = b.maxX * calSx + calOx
  const compMaxY = b.maxY * calSy + calOy
  // 纸面指令 = u·comp + offset；机器还原 physical = commanded/s + e。
  // 要求左下角物理位置 = margin：
  //   (u·compMin + offset)/s + e = margin  →  offset = s·margin − s·e − u·compMin = s·margin + o − u·compMin
  const offsetX = calSx * marginMm + calOx - compMinX * scale
  const offsetY = calSy * marginMm + calOy - compMinY * scale
  const placed = {
    minX: compMinX * scale + offsetX,
    minY: compMinY * scale + offsetY,
    maxX: compMaxX * scale + offsetX,
    maxY: compMaxY * scale + offsetY,
  }
  // placed.min = s·margin + o = s·(margin − e)（指令空间）；机器还原后 physical.min = margin
  const outOfSheet =
    placed.minX < -0.01 || placed.minY < -0.01 || placed.maxX > sheet.widthMm + 0.01 || placed.maxY > sheet.heightMm + 0.01
  return { marginMm, offsetX, offsetY, scale, scaleX, scaleY, profile, outOfSheet, placedBounds: placed }
}

/** 试切件专用：几何已按纸幅坐标直接生成，不再平移/缩放/补偿 */
export function identityPlacement(sheet: Sheet): SheetPlacement {
  return {
    marginMm: 0,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    scaleX: 1,
    scaleY: 1,
    profile: null,
    outOfSheet: false,
    placedBounds: { minX: 0, minY: 0, maxX: sheet.widthMm, maxY: sheet.heightMm },
  }
}

export function placePoint(p: Pt, pl: SheetPlacement): Pt {
  return { x: p.x * pl.scaleX + pl.offsetX, y: p.y * pl.scaleY + pl.offsetY }
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
  if (pl.profile) {
    lines.push(
      `CO"calib=${sanitize(pl.profile.machine)}/${sanitize(pl.profile.paper)} sx=${pl.profile.scaleX} sy=${pl.profile.scaleY} ox=${pl.profile.offsetXMm} oy=${pl.profile.offsetYMm}mm";`,
    )
  }

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
  if (pl.profile) {
    lines.push(`; calib=${pl.profile.machine}/${pl.profile.paper} sx=${pl.profile.scaleX} sy=${pl.profile.scaleY} ox=${pl.profile.offsetXMm} oy=${pl.profile.offsetYMm}mm`)
  }
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
    `  <desc>bridge=${meta.bridgeWidthMm}mm sheet=${sheet.widthMm}x${sheet.heightMm}mm cut=${meta.cutLengthMm.toFixed(1)}mm origin=${cfg.origin} scale=${cfg.scale}${pl.profile ? ` calib=${pl.profile.machine}/${pl.profile.paper} sx=${pl.profile.scaleX} sy=${pl.profile.scaleY}` : ''}</desc>`,
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

/**
 * 校准试切件 SVG（1:1）。入参 steps 为内部坐标（左上原点、y 向下），
 * 图中按物理摆放（机器左下原点）绘制，整体做 y′ = H − y 翻转。
 */
export function buildCalibSheet(
  steps: CutStep[],
  sheet: Sheet,
  info: { machine: string; paper: string; stdXMm: number; stdYMm: number; marginMm: number },
): string {
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString()
  const H = sheet.heightMm
  // 内部（y 向下）→ 物理显示（左下原点）：y′ = H − y
  const Y = (y: number) => H - y
  const paths: string[] = []
  for (const st of steps) {
    const q = st.points.map((p) => ({ x: p.x, y: Y(p.y) }))
    let d = `M${f(q[0].x)} ${f(q[0].y)}`
    for (let i = 1; i < q.length; i++) d += `L${f(q[i].x)} ${f(q[i].y)}`
    paths.push(`    <path d="${d}" />`)
  }
  const x0 = info.marginMm
  const y0 = info.marginMm
  const label = (x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end' = 'start', size = 3) =>
    `<text x="${f(x)}" y="${f(y)}" font-size="${size}" text-anchor="${anchor}" font-family="sans-serif" fill="#c0392b">${escapeXml(text)}</text>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.widthMm}mm" height="${sheet.heightMm}mm" viewBox="0 0 ${sheet.widthMm} ${sheet.heightMm}">`,
    `  <title>校准试切件 ${escapeXml(info.machine)} / ${escapeXml(info.paper)}</title>`,
    `  <desc>stdX=${info.stdXMm}mm stdY=${info.stdYMm}mm margin=${info.marginMm}mm origin=bottom_left（1:1 打印或直接切割，请勿缩放）</desc>`,
    `  <rect x="0" y="0" width="${sheet.widthMm}" height="${sheet.heightMm}" fill="none" stroke="#cccccc" stroke-width="0.1"/>`,
    `  <circle cx="${f(x0)}" cy="${f(y0)}" r="0.8" fill="#c0392b"/>`,
    '  <g fill="none" stroke="#c0392b" stroke-width="0.25" stroke-linecap="round">',
    ...paths,
    '  </g>',
    `  <g>${label(x0 + info.stdXMm / 2, y0 - 5, `横向标准线 ${info.stdXMm}mm（量两刻度内侧全长）`, 'middle')}`,
    `    ${label(x0 + 4, y0 + info.stdYMm / 2, `纵向标准线 ${info.stdYMm}mm`, 'start')}</g>`,
    `  ${label(x0, y0 + 4, `角点指令坐标 (${x0}, ${y0})mm｜量横线到纸左缘、竖线到纸下缘`, 'start', 2.6)}`,
    '</svg>',
    '',
  ].join('\n')
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
    pl.profile
      ? `校准：${pl.profile.machine}/${pl.profile.paper} sX=${pl.profile.scaleX} sY=${pl.profile.scaleY} 原点=${pl.profile.offsetXMm},${pl.profile.offsetYMm}mm（已按档案补偿）`
      : '校准：未使用档案（按设计原样）',
    `切割段数 ${steps.length}｜原点 左下`,
  ]
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