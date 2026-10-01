import { PATTERN_LIBRARY, fetchPatternText } from '@/data/patterns'
import { defaultMaterials } from '@/data/materials'
import { DEFAULT_CUT_SETTINGS, type CutSettings, type MaterialPreset, type Pt, type Shape } from './types'
import type { CutStep } from './order'
import { cleanupContours } from './cleanup'
import { importSvgText } from './importer'
import { computeShape } from './pipeline'
import { buildJob } from './job'
import { buildA4Sheet, buildCalibSheet, computePlacement, exportGcode, exportPlt, identityPlacement, SHEET_MARGIN_MM, type ExportMeta } from './exporters'
import { buildCalibGeometry, computeCalibration, profileStatus, upsertCalibration } from './calibration'
import { polygonArea, polylineLength } from './geometry'

export type CheckResult = {
  id: string
  title: string
  pass: boolean
  detail: string
}

export type ImportedSummary = {
  file: string
  name: string
  kept: number
  notClosed: number
  selfIntersect: number
  duplicates: number
  maxDepth: number
  bridges: number
  fragments: number
  ms: number
}

export type SelfTestReport = {
  checks: CheckResult[]
  summaries: ImportedSummary[]
  totalMs: number
}

type Item = {
  file: string
  name: string
  shape: Shape
  contours: number
  notClosed: number
  si: number
  dup: number
  maxDepth: number
  bridges: number
  fragments: number
  ms: number
}

function ok(id: string, title: string, pass: boolean, detail: string): CheckResult {
  return { id, title, pass, detail }
}

/** 造一个 5000 点的波浪圆轮廓 */
function wavyCircle(cx: number, cy: number, r: number, n: number, amp: number, lobes: number): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const rr = r + amp * Math.sin(lobes * a)
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) })
  }
  return pts
}

export async function runSelfTest(settings: CutSettings = DEFAULT_CUT_SETTINGS, material?: MaterialPreset): Promise<SelfTestReport> {
  const t0 = performance.now()
  const checks: CheckResult[] = []
  const summaries: ImportedSummary[] = []
  const mat = material ?? defaultMaterials()[0]

  // ---------- 1. 导入 10 个真实窗花 SVG ----------
  const imported: Item[] = []
  for (const p of PATTERN_LIBRARY) {
    try {
      const text = await fetchPatternText(p.file)
      const t1 = performance.now()
      const res = importSvgText(text, { toleranceMm: settings.toleranceMm, closeToleranceMm: settings.closeToleranceMm })
      const shape: Shape = { id: `st_${p.slug}`, name: p.name, contours: res.contours, layer: 0 }
      const comp = computeShape(shape, settings, mat)
      const ms = performance.now() - t1
      imported.push({
        file: p.file,
        name: p.name,
        shape,
        contours: res.contours.length,
        notClosed: res.cleanup.notClosed,
        si: res.cleanup.selfIntersect,
        dup: res.cleanup.duplicates,
        maxDepth: comp.stats.maxDepth,
        bridges: comp.stats.bridgeCount,
        fragments: comp.stats.fragmentCount,
        ms,
      })
      summaries.push({
        file: p.file,
        name: p.name,
        kept: res.contours.length,
        notClosed: res.cleanup.notClosed,
        selfIntersect: res.cleanup.selfIntersect,
        duplicates: res.cleanup.duplicates,
        maxDepth: comp.stats.maxDepth,
        bridges: comp.stats.bridgeCount,
        fragments: comp.stats.fragmentCount,
        ms,
      })
    } catch (e) {
      checks.push(ok(`import-${p.file}`, `导入 ${p.name}`, false, (e as Error).message))
    }
  }

  checks.push(
    ok(
      'import-10',
      '导入 10 个真实窗花 SVG（本地纹样库，含嵌套 3 层 / 自交 / 未闭合 / 重复用例）',
      imported.length === 10 && imported.every((x) => x.contours > 0),
      imported.map((x) => `${x.file.replace('.svg', '')}:${x.contours}轮廓`).join('｜'),
    ),
  )

  const byFile = new Map(imported.map((x) => [x.file, x]))

  const conc = byFile.get('concentric-three.svg')
  checks.push(
    ok(
      'nesting-3',
      '包含关系树嵌套 3 层正确（同心三层窗花）',
      !!conc && conc.maxDepth >= 3,
      conc ? `同心三层窗花 maxDepth = ${conc.maxDepth}（外圆 depth1 → 内圆 depth2 → 花瓣 depth3）` : '未导入',
    ),
  )

  const selfCross = byFile.get('self-cross-flower.svg')
  checks.push(
    ok(
      'self-intersect',
      '自交检测：缠枝自交花标出全部自交路径',
      !!selfCross && selfCross.si >= 2,
      selfCross ? `自交轮廓 ${selfCross.si} 条（八角星 {8/3} 星形 + 蝴蝶结对角线交叉）` : '未导入',
    ),
  )

  const openSpiral = byFile.get('open-spiral.svg')
  checks.push(
    ok(
      'not-closed',
      '闭合检查：盘长未闭合纹标出未闭合路径',
      !!openSpiral && openSpiral.notClosed >= 1,
      openSpiral ? `未闭合 ${openSpiral.notClosed} 条（首尾距离 > 容差 ${settings.closeToleranceMm}mm，可一键闭合）` : '未导入',
    ),
  )

  const scatter = byFile.get('petal-scatter.svg')
  checks.push(
    ok(
      'duplicate',
      '重复路径合并：雪花散点中完全重叠 / 反向重叠的路径被合并',
      !!scatter && scatter.dup >= 2,
      scatter ? `合并重复路径 ${scatter.dup} 条（同一图形画了 2 遍，其中一条点序反向）` : '未导入',
    ),
  )

  const clean = byFile.get('window-flower-classic.svg')
  checks.push(
    ok(
      'clean-file',
      '干净文件不误报：经典八角窗花 0 未闭合 / 0 自交 / 0 重复',
      !!clean && clean.notClosed === 0 && clean.si === 0 && clean.dup === 0,
      clean ? `未闭合 ${clean.notClosed}｜自交 ${clean.si}｜重复 ${clean.dup}` : '未导入',
    ),
  )

  // ---------- 2. 连刀点：宽度 / 偏差 / 碎片 / 长度规则 ----------
  let widthMaxErr = 0
  let devLarge = 0
  let devAll = 0
  let maxAreaDelta = 0
  let maxLengthDelta = 0
  let fragTotal = 0
  let fragWithBridges = 0
  let bridgeTotal = 0
  let degraded = 0
  for (const item of imported) {
    const comp = computeShape(item.shape, { ...settings, bridgeRule: 'by_area' }, mat)
    for (const c of item.shape.contours) {
      const m = comp.byId.get(c.id)
      if (!m) continue
      bridgeTotal += m.bridgeMetrics.count
      if (m.bridgeMetrics.degraded) degraded += 1
      if (c.closed && c.area < settings.areaThresholdMm2) {
        fragTotal += 1
        if (m.bridgeMetrics.count >= 2) fragWithBridges += 1
      }
      if (!m.bridgeMetrics.degraded) {
        for (const w of m.bridgeMetrics.widths) widthMaxErr = Math.max(widthMaxErr, Math.abs(w - settings.bridgeWidthMm))
      }
      devAll = Math.max(devAll, m.bridgeMetrics.geometryDeviationMm)
      if (c.length >= 20) devLarge = Math.max(devLarge, m.bridgeMetrics.geometryDeviationMm)
      maxAreaDelta = Math.max(maxAreaDelta, Math.abs(m.bridgeMetrics.areaBefore - m.bridgeMetrics.areaAfter))
      maxLengthDelta = Math.max(maxLengthDelta, Math.abs(m.bridgeMetrics.lengthBefore - m.bridgeMetrics.lengthAfter))
    }
  }

  checks.push(
    ok(
      'bridge-width',
      `连刀点缺口宽度与设定一致（${settings.bridgeWidthMm}mm ± 0.05mm）`,
      widthMaxErr <= 0.05,
      `共 ${bridgeTotal} 个连刀点，最大偏差 ${widthMaxErr.toFixed(4)}mm${degraded ? `（${degraded} 个碎片因过短被削窄，单独计为降级告警）` : ''}`,
    ),
  )

  checks.push(
    ok(
      'bridge-deviation',
      '轮廓几何偏差 ≤ 0.1mm（挖缺口后重算面积/周长并记录偏差）',
      devLarge <= 0.1,
      `缺口吸附在单条直线段内（不跨折角）：最大几何偏差 ${devAll.toFixed(5)}mm（长度 ≥20mm 轮廓 ${devLarge.toFixed(5)}mm）｜` +
        `被挖掉的最大面积 ${maxAreaDelta.toFixed(4)}mm²、最大周长 ${maxLengthDelta.toFixed(3)}mm（已重算并记录）`,
    ),
  )

  checks.push(
    ok(
      'bridge-fragment',
      `小碎片（面积 < ${settings.areaThresholdMm2}mm²）100% 生成连刀点（每片 ≥ 2 个）`,
      fragTotal === 0 || fragWithBridges === fragTotal,
      `碎片 ${fragTotal} 个，已连刀 ${fragWithBridges} 个，覆盖 ${fragTotal ? ((fragWithBridges / fragTotal) * 100).toFixed(0) : 100}%`,
    ),
  )

  let lengthRuleOk = true
  const lengthRuleDetail: string[] = []
  let lengthRuleCount = 0
  for (const item of imported) {
    const comp = computeShape(item.shape, { ...settings, bridgeRule: 'by_length' }, mat)
    for (const c of item.shape.contours) {
      const m = comp.byId.get(c.id)
      if (!m || !c.closed) continue
      if (c.area < settings.areaThresholdMm2) continue
      const expect = Math.floor(c.length / settings.bridgeEveryMm)
      if (expect !== m.bridgeMetrics.count) {
        lengthRuleOk = false
        if (lengthRuleDetail.length < 5) lengthRuleDetail.push(`${item.file}: 周长 ${c.length.toFixed(1)}mm 期望 ${expect} 实得 ${m.bridgeMetrics.count}`)
      }
      lengthRuleCount += 1
    }
  }
  checks.push(
    ok(
      'bridge-by-length',
      '大轮廓按长度规则数量正确（n = ⌊周长 / 每段长度⌋）',
      lengthRuleOk,
      lengthRuleOk ? `每 ${settings.bridgeEveryMm}mm 一个连刀点，校验 ${lengthRuleCount} 条大轮廓全部吻合` : lengthRuleDetail.join('；'),
    ),
  )

  // ---------- 3. 切割顺序：先内后外 ----------
  let orderOk = true
  const orderDetail: string[] = []
  let orderPairs = 0
  for (const item of imported) {
    const comp = computeShape(item.shape, settings, mat)
    const idx = new Map<string, number>()
    comp.order.steps.forEach((s, i) => {
      if (!idx.has(s.contourId)) idx.set(s.contourId, i)
    })
    for (const c of item.shape.contours) {
      const pi = idx.get(c.id)
      if (pi === undefined) continue
      for (const hid of c.holes) {
        const ci = idx.get(hid)
        if (ci === undefined) continue
        orderPairs += 1
        if (ci > pi) {
          orderOk = false
          if (orderDetail.length < 3) orderDetail.push(`${item.file}: 内层排在外层之后`)
        }
      }
    }
  }
  checks.push(
    ok(
      'order-inner-first',
      '切割顺序为先内后外（后序遍历包含关系树）',
      orderOk && orderPairs > 0,
      orderOk ? `校验 ${orderPairs} 组父子关系，内层轮廓全部排在外层之前` : orderDetail.join('；'),
    ),
  )

  // ---------- 4. 跳刀优化 ≥ 15% ----------
  let improvement = 0
  let nnImprovement = 0
  let travelDetail = '未导入'
  if (scatter) {
    const comp2 = computeShape(scatter.shape, { ...settings, travelOptimize: 'nearest_2opt' }, mat)
    const compNn = computeShape(scatter.shape, { ...settings, travelOptimize: 'nearest' }, mat)
    improvement = comp2.stats.improvementPct
    nnImprovement = compNn.stats.improvementPct
    travelDetail =
      `雪花散点（24 个碎片）：朴素顺序 ${comp2.stats.naiveTravelMm.toFixed(1)}mm → 仅最近邻 ${compNn.stats.travelMm.toFixed(1)}mm（−${nnImprovement.toFixed(1)}%）→ ` +
      `最近邻+2-opt ${comp2.stats.travelMm.toFixed(1)}mm（−${comp2.stats.improvementPct.toFixed(1)}%）`
  }
  checks.push(ok('travel-2opt', '跳刀优化：2-opt 后总跳刀长度比朴素顺序短 ≥ 15%', improvement >= 15, travelDetail))

  // ---------- 5. 导出 PLT / G-code ----------
  const exportShape = clean?.shape ?? imported[0]?.shape
  if (exportShape) {
    const comp = computeShape(exportShape, settings, mat)
    const sheet = { widthMm: 210, heightMm: 297, name: 'A4 纵向' }
    const job = buildJob([exportShape], new Map([[exportShape.id, comp]]), [0], { sharedEdge: false, start: { x: 0, y: 0 } })
    const pl = computePlacement(job.steps, sheet, 1)
    const meta: ExportMeta = {
      projectName: '自检',
      formName: exportShape.name,
      material: mat,
      bridgeWidthMm: settings.bridgeWidthMm,
      passes: mat.passes,
      sheet,
      cutLengthMm: job.cutLengthMm,
      travelMm: job.travelMm,
    }
    const plt = exportPlt(
      job.steps,
      { format: 'plt', unit: '0.025mm', origin: 'bottom_left', yFlip: true, scale: 1 },
      sheet,
      meta,
      pl,
    )

    let maxInternalY = -Infinity
    let exportYOfMax = 0
    for (const st of job.steps) {
      for (const p of st.points) {
        const y = p.y + pl.offsetY
        if (y > maxInternalY) {
          maxInternalY = y
          exportYOfMax = Math.round((sheet.heightMm - y) / 0.025)
        }
      }
    }
    const inSheet = plt.minX >= 0 && plt.minY >= 0 && plt.maxX <= plt.sheetMaxX && plt.maxY <= plt.sheetMaxY
    const flipOk = Math.abs(plt.minY - exportYOfMax) <= 1
    checks.push(
      ok(
        'export-plt',
        '导出 PLT：坐标全部落在纸幅内、原点在左下（y′ = 纸幅高 − y）',
        inSheet && flipOk,
        `X ${plt.minX}~${plt.maxX}｜Y ${plt.minY}~${plt.maxY}（0.025mm/单位，纸幅上限 ${plt.sheetMaxX}×${plt.sheetMaxY}）｜` +
          `内部最大 y = ${maxInternalY.toFixed(2)}mm → 导出最小 y = ${exportYOfMax}（左下原点）`,
      ),
    )

    const gcode = exportGcode(job.steps, { format: 'gcode', unit: 'mm', origin: 'bottom_left', yFlip: true, scale: 1 }, sheet, meta, pl)
    const hasG21 = gcode.text.includes('G21')
    const feed = Math.round(mat.speedMmS * 60)
    const hasFeed = gcode.text.includes(`F${feed}`)
    const passSegments = (gcode.text.match(/; ---- pass \d+\/\d+/g) ?? []).length
    checks.push(
      ok(
        'export-gcode',
        '导出 G-code：单位 mm、进给与重复次数正确',
        hasG21 && hasFeed && passSegments === mat.passes,
        `G21(mm)=${hasG21}｜F${feed}（${mat.speedMmS}mm/s × 60）=${hasFeed}｜pass 段 ${passSegments}/${mat.passes}`,
      ),
    )

    // ---------- 6. A4 检查图 1:1 ----------
    const a4 = buildA4Sheet(job.steps, sheet, meta, pl, { showNumbers: true, showTravel: true, title: '自检' })
    const rulerMatch = /<line x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)" y2="[\d.]+" stroke="#000" stroke-width="0.3"\/>/.exec(a4)
    const rulerLen = rulerMatch ? Math.abs(Number(rulerMatch[2]) - Number(rulerMatch[1])) : 0
    const isMm1to1 =
      a4.includes(`width="${sheet.widthMm}mm"`) &&
      a4.includes(`height="${sheet.heightMm}mm"`) &&
      a4.includes(`viewBox="0 0 ${sheet.widthMm} ${sheet.heightMm}"`)
    checks.push(
      ok(
        'a4-ruler',
        'A4 检查图 1:1：100mm 校验尺几何长度误差 ≤ 1mm',
        Math.abs(rulerLen - 100) <= 1 && isMm1to1,
        `校验尺 ${rulerLen.toFixed(3)}mm（误差 ${Math.abs(rulerLen - 100).toFixed(3)}mm）｜SVG 物理尺寸 ${sheet.widthMm}mm×${sheet.heightMm}mm，浏览器 CSS mm 打印为 1:1`,
      ),
    )
  } else {
    checks.push(ok('export-plt', '导出 PLT 用例', false, '没有可用的纹样'))
  }

  // ---------- 7. 性能 ----------
  const bigPts = wavyCircle(80, 80, 62, 5000, 2.5, 11)
  const rawBig: Array<{ points: Pt[]; closed: boolean }> = [{ points: bigPts, closed: true }]
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2
    rawBig.push({ points: wavyCircle(80 + 50 * Math.cos(a), 80 + 50 * Math.sin(a), 1.1, 20, 0, 3), closed: true })
  }
  const t2 = performance.now()
  const cleaned = cleanupContours(rawBig, { toleranceMm: settings.toleranceMm, closeToleranceMm: settings.closeToleranceMm })
  const bigShape: Shape = { id: 'st_perf', name: '性能用例', contours: cleaned.contours, layer: 0 }
  const bigComp = computeShape(bigShape, settings, mat)
  const perfMs = performance.now() - t2
  checks.push(
    ok(
      'perf-5000',
      '5000 点轮廓全流程（清理 + 连刀 + 排序）< 300ms',
      perfMs < 300,
      `主轮廓 ${bigPts.length} 点 + 40 个碎片｜清理保留 ${cleaned.contours.length} 条｜连刀 ${bigComp.stats.bridgeCount} 个｜耗时 ${perfMs.toFixed(1)}ms`,
    ),
  )

  // ---------- 8. 缓存签名（参数变化才失效） ----------
  const sigA = computeShape(bigShape, settings, mat).signature
  const sigB = computeShape(bigShape, { ...settings, bridgeWidthMm: settings.bridgeWidthMm + 0.1 }, mat).signature
  checks.push(
    ok('cache-signature', '参数变化使缓存签名失效（避免每次渲染都重算）', sigA !== sigB, `签名一致 = ${sigA === sigB}（应为 false，参数已变化）`),
  )

  // ---------- 9. 刀补：凹角自交裁剪 + 明确告警 ----------
  const starShape: Shape = {
    id: 'st_offset',
    name: '刀补用例',
    layer: 0,
    contours: [makeStar(80, 80, 40, 20, 5, 0.3)],
  }
  const noOffset = computeShape(starShape, { ...settings, useBladeOffset: false }, mat)
  const withOffset = computeShape(starShape, { ...settings, useBladeOffset: true }, mat)
  const starId = starShape.contours[0].id
  const offEntry = withOffset.byId.get(starId)
  const noEntry = noOffset.byId.get(starId)
  const offsetMsg = offEntry?.offsetMessage ?? ''
  const geometryChanged = JSON.stringify(offEntry?.runs) !== JSON.stringify(noEntry?.runs)
  checks.push(
    ok(
      'blade-offset',
      '刀补：闭合轮廓按 bladeOffset 偏置，凹角自交自动裁剪',
      geometryChanged && (offEntry?.offsetOk ?? false),
      `五角星（外 R40 / 内 R20，10 个凹角）刀补 ${mat.bladeOffsetMm}mm：${offsetMsg}｜几何已改变 = ${geometryChanged}`,
    ),
  )
  // 刀补失败用例：外层大方框内的细长条（depth=2 → 向内偏置），0.25mm 偏置必然让 0.3mm 细条塌陷
  const thinInner = rectContour('st_thin', 30, 39.85, 20, 0.3)
  const outerSquare = rectContour('st_outer', 0, 0, 80, 80)
  const tinyShape: Shape = { id: 'st_offset_tiny', name: '刀补失败用例', layer: 0, contours: [outerSquare, thinInner] }
  const tinyOffset = computeShape(tinyShape, { ...settings, useBladeOffset: true }, mat)
  const tinyEntry = tinyOffset.byId.get(thinInner.id)
  const tinyOk = tinyEntry?.offsetOk ?? true
  const tinyMsg = tinyEntry?.offsetMessage ?? ''
  const tinyRuns = tinyEntry?.runs.length ?? 0
  checks.push(
    ok(
      'blade-offset-fail',
      '刀补超出轮廓尺度时明确警告并保留原路径（不输出坏路径）',
      !tinyOk && tinyMsg.includes('原路径') && tinyRuns > 0,
      `0.3mm 细长条（内层，向内侧偏置 ${mat.bladeOffsetMm}mm）：${tinyMsg}｜仍输出 ${tinyRuns} 段原路径`,
    ),
  )

  // ---------- 10. 机器 × 纸张校准：试切件 / 反算 / 补偿摆放 / 档案留档 ----------
  const calibSheet = { widthMm: 297, heightMm: 210, name: 'A4 横向' }
  const cg = buildCalibGeometry(calibSheet)
  // 试切线长度与几何断言
  const hLine = cg.steps[0]
  const vLine = cg.steps[1]
  const hLen = Math.hypot(hLine.points[1].x - hLine.points[0].x, hLine.points[1].y - hLine.points[0].y)
  const vLen = Math.hypot(vLine.points[1].x - vLine.points[0].x, vLine.points[1].y - vLine.points[0].y)
  const corner = hLine.points[0]
  // 内部坐标（左上原点）：角点 (margin, H−margin)；PLT 翻转后物理角点 (margin, margin)
  const geomOk =
    Math.abs(hLen - cg.stdXMm) < 1e-9 &&
    Math.abs(vLen - cg.stdYMm) < 1e-9 &&
    Math.abs(corner.x - cg.marginMm) < 1e-9 &&
    Math.abs(corner.y - (calibSheet.heightMm - cg.marginMm)) < 1e-9 &&
    hLine.points[1].x <= calibSheet.widthMm &&
    vLine.points[1].y >= 0
  checks.push(
    ok(
      'calib-geometry',
      '校准试切件：横/竖标准线长度与角点坐标正确（内部左上原点，导出翻到左下），且不超出纸幅',
      geomOk,
      `横线 ${hLen}mm（标准 ${cg.stdXMm}）｜竖线 ${vLen}mm（标准 ${cg.stdYMm}）｜内部角点 (${corner.x}, ${corner.y})mm｜共 ${cg.steps.length} 段（含端部刻度）`,
    ),
  )

  // 模拟机器（physical = commanded/s + e）：横向切小（sX=1.01）、纵向切大（sY=0.995），
  // 原点物理偏差 eX=1.2mm（偏进纸内）、eY=-0.8mm
  const simStdX = cg.stdXMm
  const simStdY = cg.stdYMm
  const trueSx = 1.01
  const trueSy = 0.995
  const trueEX = 1.2
  const trueEY = -0.8
  const measX = simStdX / trueSx
  const measY = simStdY / trueSy
  // 角点指令在 testMargin → 实测原点 = testMargin/s + e
  const measOriginX = cg.marginMm / trueSx + trueEX
  const measOriginY = cg.marginMm / trueSy + trueEY

  const calc = computeCalibration({
    machine: '自检机',
    paper: 'red-paper',
    paperLabel: '红纸',
    sheet: calibSheet,
    measuredXMm: measX,
    measuredYMm: measY,
    originXMm: measOriginX,
    originYMm: measOriginY,
    stdXMm: simStdX,
    stdYMm: simStdY,
    marginMm: cg.marginMm,
  })
  // 反算回真实缩放；原点指令平移 ox = testMargin − s·实测原点 = −s·e
  const expectOx = cg.marginMm - trueSx * measOriginX
  const expectOy = cg.marginMm - trueSy * measOriginY
  const recoverOk =
    Math.abs(calc.scaleX - trueSx) < 1e-9 &&
    Math.abs(calc.scaleY - trueSy) < 1e-9 &&
    Math.abs(calc.offsetXMm - expectOx) < 1e-9 &&
    Math.abs(calc.offsetYMm - expectOy) < 1e-9
  checks.push(
    ok(
      'calib-solve',
      '由横竖实测长度反算缩放系数与原点偏移（s = 标准/实测，o = 试切边距 − s·实测原点）',
      recoverOk && !calc.error,
      `真值 sX=${trueSx} sY=${trueSy} eX=${trueEX} eY=${trueEY} → 反算 sX=${calc.scaleX.toFixed(6)} sY=${calc.scaleY.toFixed(6)} oX=${calc.offsetXMm.toFixed(6)}（−s·e=${(-trueSx * trueEX).toFixed(6)}）oY=${calc.offsetYMm.toFixed(6)}`,
    ),
  )

  // 同机同纸二次校准 → 追加历史；换纸 → 新档案
  const baseInput = {
    machine: '自检机',
    paperLabel: '红纸',
    sheet: calibSheet,
    measuredXMm: measX,
    measuredYMm: measY,
    originXMm: measOriginX,
    originYMm: measOriginY,
    stdXMm: simStdX,
    stdYMm: simStdY,
    marginMm: cg.marginMm,
  }
  const r1 = upsertCalibration([], { ...baseInput, paper: 'red-paper' })
  const r2 = upsertCalibration(r1.profiles, { ...baseInput, paper: 'red-paper' })
  const r3 = upsertCalibration(r2.profiles, { ...baseInput, paper: 'xuan', paperLabel: '宣纸', measuredXMm: simStdX / 1.02 })
  const archiveOk =
    r1.created &&
    !r2.created &&
    r2.profile.history.length === 2 &&
    r3.created &&
    r3.profiles.length === 2 &&
    Math.abs(r3.profile.scaleX - 1.02) < 1e-6
  checks.push(
    ok(
      'calib-archive',
      '一台机器+一种纸一条档案：同机同纸追加留档，同机换纸新建档案',
      archiveOk,
      `红纸档案 ${r2.profile.history.length} 次校准（留档可对比漂移）｜换宣纸后档案数 ${r3.profiles.length}，sX=${r3.profile.scaleX.toFixed(4)}`,
    ),
  )

  // 补偿后摆放：用 100×80 设计矩形（原点 0,0），补偿后机器切回设计尺寸且落到纸边距
  const rectPts: Pt[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 80 },
    { x: 0, y: 80 },
  ]
  const rectSteps: CutStep[] = [
    {
      seq: 1,
      contourId: 'calrect',
      runIndex: 0,
      runCount: 1,
      points: rectPts,
      closed: true,
      startPt: rectPts[0],
      endPt: rectPts[0],
      travelFromPrevMm: 0,
      level: 1,
      layer: 0,
      lengthMm: 360,
    },
  ]
  const calibPL = computePlacement(rectSteps, calibSheet, 1, SHEET_MARGIN_MM, r2.profile)
  // 导出指令（摆放到纸面后）的包围盒
  const cmdMinX = calibPL.placedBounds.minX
  const cmdMinY = calibPL.placedBounds.minY
  const cmdW = calibPL.placedBounds.maxX - cmdMinX
  const cmdH = calibPL.placedBounds.maxY - cmdMinY
  // 机器实际切出的物理尺寸/位置
  const physMinX = cmdMinX / trueSx + trueEX
  const physMinY = cmdMinY / trueSy + trueEY
  const physW = cmdW / trueSx
  const physH = cmdH / trueSy
  const compensateOk =
    Math.abs(physW - 100) < 1e-6 &&
    Math.abs(physH - 80) < 1e-6 &&
    Math.abs(physMinX - SHEET_MARGIN_MM) < 1e-6 &&
    Math.abs(physMinY - SHEET_MARGIN_MM) < 1e-6
  checks.push(
    ok(
      'calib-placement',
      '导出按档案先补偿整张图：机器切回设计尺寸，原点偏移被抵消到纸边距',
      compensateOk,
      `设计 100×80mm → 指令 ${cmdW.toFixed(3)}×${cmdH.toFixed(3)}mm → 实切 ${physW.toFixed(4)}×${physH.toFixed(4)}mm｜起点物理 (${physMinX.toFixed(4)}, ${physMinY.toFixed(4)})mm（边距 ${SHEET_MARGIN_MM}）`,
    ),
  )

  // 偏差超阈值必须被标记（不静默套用）
  const bigDev = upsertCalibration([], {
    ...baseInput,
    machine: '超差机',
    paper: 'flock',
    paperLabel: '植绒',
    measuredXMm: simStdX / 1.05, // 5% 偏差
    measuredYMm: simStdY / 1.05,
    warnScalePct: 2,
  }).profile
  const status = profileStatus(bigDev)
  checks.push(
    ok(
      'calib-warning',
      '偏差超过阈值时标记重新校准，而不是静默套用旧档案',
      status.level === 'err' && status.messages.some((m) => m.includes('横向')),
      `5% 偏差档案状态=${status.level}：${status.messages.join('；') || '（无提示）'}`,
    ),
  )

  // 试切件 PLT/SVG 不做补偿（identity），落在纸幅内，起刀点为试切角点
  const calibMeta: ExportMeta = {
    projectName: '校准自检',
    formName: '校准试切件',
    material: mat,
    bridgeWidthMm: 0,
    passes: 1,
    sheet: calibSheet,
    cutLengthMm: cg.steps.reduce((a, s) => a + s.lengthMm, 0),
    travelMm: 0,
  }
  const calibPlt = exportPlt(
    cg.steps,
    { format: 'plt', unit: '0.025mm', origin: 'bottom_left', yFlip: true, scale: 1 },
    calibSheet,
    calibMeta,
    identityPlacement(calibSheet),
  )
  const calibSvg = buildCalibSheet(cg.steps, calibSheet, { machine: '自检机', paper: '红纸', stdXMm: cg.stdXMm, stdYMm: cg.stdYMm, marginMm: cg.marginMm })
  const startUnits = Math.round(cg.marginMm / 0.025)
  const testcutRawOk =
    calibPlt.outOfSheet === false &&
    calibPlt.text.includes(`PU${startUnits},${startUnits};`) &&
    calibSvg.includes(`横向标准线 ${cg.stdXMm}mm`) &&
    calibPlt.minX >= 0 &&
    calibPlt.minY >= 0
  checks.push(
    ok(
      'calib-testcut-export',
      '试切件刀路不做补偿：坐标即纸面坐标、落在纸幅内，起刀点为标准角点',
      testcutRawOk,
      `PLT X ${calibPlt.minX}~${calibPlt.maxX} / Y ${calibPlt.minY}~${calibPlt.maxY}（纸幅 ${calibPlt.sheetMaxX}×${calibPlt.sheetMaxY}），起刀指令 PU${startUnits},${startUnits}`,
    ),
  )

  const totalMs = performance.now() - t0
  return { checks, summaries, totalMs }
}

/** 矩形轮廓 */
function rectContour(id: string, x: number, y: number, w: number, h: number): Shape['contours'][number] {
  const pts: Pt[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
  return { id, points: pts, closed: true, area: w * h, length: 2 * (w + h), holes: [], bridges: [], warnings: [] }
}

/** 星形多边形（含凹角，用于刀补自交裁剪测试） */
function makeStar(cx: number, cy: number, rOuter: number, rInner: number, points: number, wobble: number): Shape['contours'][number] {
  const pts: Pt[] = []
  const n = points * 2
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    const r = (i % 2 === 0 ? rOuter : rInner) * (1 + (i % 3 === 0 ? wobble : 0))
    pts.push({ x: Math.round((cx + r * Math.cos(a)) * 1000) / 1000, y: Math.round((cy + r * Math.sin(a)) * 1000) / 1000 })
  }
  return {
    id: 'st_star',
    points: pts,
    closed: true,
    area: polygonArea(pts),
    length: polylineLength(pts, true),
    holes: [],
    bridges: [],
    warnings: [],
  }
}