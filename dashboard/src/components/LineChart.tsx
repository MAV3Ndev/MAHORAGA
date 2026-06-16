import { motion } from 'motion/react'
import { memo, useEffect, useRef, useState } from 'react'

type ChartVariant = 'cyan' | 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'primary'
type ChartUpdateEffect = 'pulse' | 'trace' | 'none'
const CHART_VIEWBOX_WIDTH = 720

interface LineChartSeries {
  label: string
  data: number[]
  variant?: ChartVariant
}

interface ChartMarker {
  index: number
  label: string
  color?: string
}

interface TimelinePoint {
  timestamp: number
  value: number
  label?: string
}

interface MarketHoursZone {
  openIndex: number
  closeIndex: number
}

interface PositionTimelineSeries {
  label: string
  points: TimelinePoint[]
  variant?: ChartVariant
}

interface LineChartProps {
  series: LineChartSeries[]
  labels?: string[]
  variant?: ChartVariant
  height?: number | string
  viewBoxHeight?: number
  showDots?: boolean
  showGrid?: boolean
  showArea?: boolean
  animated?: boolean
  formatValue?: (value: number) => string
  markers?: ChartMarker[]
  marketHours?: MarketHoursZone
  updateToken?: number
  updateEffect?: ChartUpdateEffect
}

const variantColors: Record<ChartVariant, { stroke: string; fill: string }> = {
  cyan: { stroke: 'var(--color-hud-cyan)', fill: 'var(--color-hud-cyan)' },
  blue: { stroke: 'var(--color-hud-blue)', fill: 'var(--color-hud-blue)' },
  green: { stroke: 'var(--color-hud-green)', fill: 'var(--color-hud-green)' },
  yellow: { stroke: 'var(--color-hud-yellow)', fill: 'var(--color-hud-yellow)' },
  red: { stroke: 'var(--color-hud-red)', fill: 'var(--color-hud-red)' },
  purple: { stroke: 'var(--color-hud-purple)', fill: 'var(--color-hud-purple)' },
  primary: { stroke: 'var(--color-hud-primary)', fill: 'var(--color-hud-primary)' },
}

function toPercentX(x: number, width: number): string {
  return `${(x / width) * 100}%`
}

function toPercentY(y: number, height: number): string {
  return `${(y / height) * 100}%`
}

interface LineTraceEffectProps {
  pathD: string
  color: string
  animationKey: number
}

function LineTraceEffect({ pathD, color, animationKey }: LineTraceEffectProps) {
  const pathRef = useRef<SVGPathElement>(null)
  const frameRef = useRef<number | null>(null)
  const [point, setPoint] = useState<{ x: number; y: number; opacity: number } | null>(null)

  useEffect(() => {
    if (!animationKey || !pathRef.current) {
      setPoint(null)
      return
    }

    const path = pathRef.current
    const totalLength = path.getTotalLength()
    const durationMs = 760
    const startTime = performance.now()

    const tick = (now: number) => {
      const progress = Math.min(1, (now - startTime) / durationMs)
      const easedProgress = 1 - Math.pow(1 - progress, 1.75)
      const currentPoint = path.getPointAtLength(totalLength * easedProgress)
      const opacity =
        progress < 0.1
          ? progress / 0.1
          : progress > 0.88
            ? Math.max(0, (1 - progress) / 0.12)
            : 1

      setPoint({
        x: currentPoint.x,
        y: currentPoint.y,
        opacity,
      })

      if (progress < 1) {
        frameRef.current = window.requestAnimationFrame(tick)
      } else {
        setPoint(null)
      }
    }

    frameRef.current = window.requestAnimationFrame(tick)

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
      }
      setPoint(null)
    }
  }, [animationKey, pathD])

  return (
    <g pointerEvents="none">
      <path ref={pathRef} d={pathD} fill="none" stroke="transparent" strokeWidth={1} />
      {point && (
        <>
          <circle
            cx={point.x}
            cy={point.y}
            r={16}
            fill={color}
            opacity={0.1 * point.opacity}
          />
          <circle
            cx={point.x}
            cy={point.y}
            r={9}
            fill={color}
            opacity={0.16 * point.opacity}
          />
          <circle
            cx={point.x}
            cy={point.y}
            r={3}
            fill={color}
            opacity={0.98 * point.opacity}
          />
        </>
      )}
    </g>
  )
}

export function LineChart({
  series,
  labels,
  variant = 'cyan',
  height,
  viewBoxHeight,
  showDots = false,
  showGrid = true,
  showArea = true,
  animated = true,
  formatValue,
  markers,
  marketHours,
  updateToken,
  updateEffect = 'pulse',
}: LineChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [isPulsing, setIsPulsing] = useState(false)
  const [animationVersion, setAnimationVersion] = useState(0)
  const svgRef = useRef<SVGSVGElement>(null)
  const hasMountedRef = useRef(false)

  const resolvedHeight = height ?? 200
  const viewBoxWidth = CHART_VIEWBOX_WIDTH
  const resolvedViewBoxHeight = viewBoxHeight ?? (typeof resolvedHeight === 'number' ? resolvedHeight : 320)
  const viewBoxHeightValue = resolvedViewBoxHeight
  const padding = { top: 18, right: 8, bottom: 34, left: 78 }
  const chartWidth = viewBoxWidth - padding.left - padding.right
  const chartHeight = viewBoxHeightValue - padding.top - padding.bottom

  const allValues = series.flatMap((s) => s.data)
  const dataMin = Math.min(...allValues)
  const dataMax = Math.max(...allValues)
  const range = dataMax - dataMin || 1
  const minValue = dataMin - range * 0.05
  const maxValue = dataMax + range * 0.05
  const valueRange = maxValue - minValue || 1

  const maxPoints = Math.max(...series.map((s) => s.data.length), 1)

  const getX = (index: number) => padding.left + (index / (maxPoints - 1 || 1)) * chartWidth
  const getY = (value: number) => padding.top + chartHeight - ((value - minValue) / valueRange) * chartHeight
  const getIndexFromX = (x: number) => Math.round(((x - padding.left) / chartWidth) * (maxPoints - 1))

  const gridLines = 4
  const gridValues = Array.from({ length: gridLines }, (_, i) => minValue + (valueRange / (gridLines - 1)) * i)

  const formatLabel = formatValue || ((v: number) => {
    if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`
    return v.toFixed(0)
  })

  useEffect(() => {
    if (updateToken === undefined) return

    if (!hasMountedRef.current) {
      hasMountedRef.current = true
      return
    }

    if (updateEffect === 'trace') {
      setAnimationVersion((current) => current + 1)
      return
    }

    if (updateEffect !== 'pulse') return

    setIsPulsing(true)
    const timeoutId = window.setTimeout(() => setIsPulsing(false), 950)
    return () => window.clearTimeout(timeoutId)
  }, [updateEffect, updateToken])

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const scaleX = viewBoxWidth / rect.width
    const x = (e.clientX - rect.left) * scaleX
    const index = getIndexFromX(x)
    if (index >= 0 && index < maxPoints) {
      setHoverIndex(index)
    } else {
      setHoverIndex(null)
    }
  }

  const handleMouseLeave = () => setHoverIndex(null)

  const hoverValue = hoverIndex !== null ? series[0]?.data[hoverIndex] : null
  const hoverLabel = hoverIndex !== null && labels ? labels[hoverIndex] : null
  const labelStep = labels ? Math.max(1, Math.ceil(labels.length / 6)) : 1
  const tooltipWidth = 164
  const tooltipHeight = 68
  const hoverX = hoverIndex !== null ? getX(hoverIndex) : null
  const hoverY = hoverValue !== null ? getY(hoverValue) : null
  const hoverTooltipX =
    hoverX !== null
      ? hoverX > viewBoxWidth - padding.right - tooltipWidth - 20
        ? hoverX - tooltipWidth - 12
        : hoverX + 12
      : null
  const hoverTooltipY =
    hoverY !== null
      ? Math.min(Math.max(hoverY - tooltipHeight / 2, padding.top), padding.top + chartHeight - tooltipHeight)
      : null
  const xAxisLabels = labels
    ? labels
        .map((label, index) => (index % labelStep === 0 ? { label, x: getX(index) } : null))
        .filter(Boolean) as Array<{ label: string; x: number }>
    : []

  return (
    <div className="hud-chart-shell w-full" style={{ height: resolvedHeight }}>
      {updateEffect === 'pulse' && (
        <motion.div
          aria-hidden
          className="hud-chart-pulse"
          initial={false}
          animate={isPulsing ? { opacity: [0, 0.9, 0], scale: [0.985, 1.01, 1.02] } : { opacity: 0, scale: 1 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />
      )}
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeightValue}`}
        className="block h-full w-full"
        overflow="hidden"
        preserveAspectRatio="none"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {showGrid && (
          <g>
            {gridValues.map((value, i) => (
              <g key={i}>
                <line
                  x1={padding.left}
                  y1={getY(value)}
                  x2={viewBoxWidth - padding.right}
                  y2={getY(value)}
                  stroke="currentColor"
                  className="text-hud-border"
                  strokeWidth={0.5}
                  opacity={0.3}
                />
              </g>
            ))}
          </g>
        )}

        {marketHours && (
          <>
            {marketHours.openIndex > 0 && (
              <rect
                x={padding.left}
                y={padding.top}
                width={getX(marketHours.openIndex) - padding.left}
                height={chartHeight}
                fill="var(--color-hud-bg)"
                opacity={0.6}
              />
            )}
            {marketHours.closeIndex < maxPoints - 1 && (
              <rect
                x={getX(marketHours.closeIndex)}
                y={padding.top}
                width={viewBoxWidth - padding.right - getX(marketHours.closeIndex)}
                height={chartHeight}
                fill="var(--color-hud-bg)"
                opacity={0.6}
              />
            )}
          </>
        )}

        {markers && markers.map((marker, i) => (
          <g key={`marker-${i}`}>
            <line
              x1={getX(marker.index)}
              y1={padding.top}
              x2={getX(marker.index)}
              y2={padding.top + chartHeight}
              stroke={marker.color || 'var(--color-hud-text-dim)'}
              strokeWidth={1}
              strokeDasharray="4,4"
              opacity={0.5}
            />
          </g>
        ))}

        {series.map((s, seriesIndex) => {
          const colors = variantColors[s.variant ?? variant]
          const points = s.data.map((value, i) => ({ x: getX(i), y: getY(value) }))
          if (points.length === 0) return null

          const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
          const areaD = `${pathD} L ${points[points.length - 1]?.x ?? 0} ${padding.top + chartHeight} L ${points[0]?.x ?? 0} ${padding.top + chartHeight} Z`
          const gradientId = `area-gradient-${seriesIndex}`
          const shouldRenderTrace = updateEffect === 'trace' && animationVersion > 0

          return (
            <g key={seriesIndex}>
              {showArea && (
                <defs>
                  <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor={colors.fill} stopOpacity={0.2} />
                    <stop offset="100%" stopColor={colors.fill} stopOpacity={0} />
                  </linearGradient>
                </defs>
              )}

              {showArea && (
                <motion.path
                  d={areaD}
                  fill={`url(#${gradientId})`}
                  initial={animated ? { opacity: 0 } : undefined}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.8 }}
                />
              )}

              <motion.path
                d={pathD}
                fill="none"
                stroke={colors.stroke}
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.94}
                vectorEffect="non-scaling-stroke"
                initial={animated ? { pathLength: 0 } : undefined}
                animate={{ pathLength: 1 }}
                transition={{ duration: 1.2, ease: [0.25, 0.46, 0.45, 0.94] }}
              />

              {shouldRenderTrace && (
                <LineTraceEffect
                  key={`trace-${seriesIndex}-${animationVersion}`}
                  pathD={pathD}
                  color={colors.stroke}
                  animationKey={animationVersion}
                />
              )}

              {showDots &&
                points.map((p, i) => (
                  <motion.circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r={3}
                    fill={colors.fill}
                    opacity={0.92}
                    vectorEffect="non-scaling-stroke"
                    initial={animated ? { scale: 0 } : undefined}
                    animate={{ scale: 1 }}
                    transition={{ delay: i * 0.03, duration: 0.2 }}
                  />
                ))}
            </g>
          )
        })}

        {hoverIndex !== null && hoverValue !== null && (() => {
          return (
            <g>
              <line
                x1={hoverX!}
                y1={padding.top}
                x2={hoverX!}
                y2={padding.top + chartHeight}
                stroke="var(--color-hud-text-dim)"
                strokeWidth={1}
                opacity={0.6}
              />
              <circle
                cx={hoverX!}
                cy={hoverY!}
                r={4}
                fill="var(--color-hud-bg)"
                stroke={variantColors[series[0]?.variant ?? variant].stroke}
                strokeWidth={2}
              />
            </g>
          )
        })()}
      </svg>

      <div className="hud-chart-overlay hud-chart-overlay--labels" aria-hidden="true">
        {showGrid &&
          gridValues.map((value, index) => (
            <div
              key={`y-label-${index}`}
              className="hud-chart-axis-label hud-chart-axis-label-y"
              style={{
                top: toPercentY(getY(value), viewBoxHeightValue),
                width: `calc(${toPercentX(padding.left, viewBoxWidth)} - 10px)`,
              }}
            >
              {formatLabel(value)}
            </div>
          ))}

        {xAxisLabels.map(({ label, x }, index) => (
          <div
            key={`x-label-${index}`}
            className="hud-chart-axis-label hud-chart-axis-label-x"
            style={{
              left: toPercentX(x, viewBoxWidth),
              bottom: '4px',
            }}
          >
            {label}
          </div>
        ))}

        {markers?.map((marker, index) => (
          <div
            key={`marker-label-${index}`}
            className="hud-chart-marker-label"
            style={{
              left: toPercentX(getX(marker.index), viewBoxWidth),
              top: '2px',
              color: marker.color || 'var(--color-hud-text-dim)',
            }}
          >
            {marker.label}
          </div>
        ))}

        {hoverIndex !== null && hoverValue !== null && (
          <div
            className="hud-chart-tooltip"
            style={{
              left: toPercentX(hoverTooltipX!, viewBoxWidth),
              top: toPercentY(hoverTooltipY!, viewBoxHeightValue),
            }}
          >
            <div className="hud-chart-tooltip-value">{formatLabel(hoverValue)}</div>
            {hoverLabel && <div className="hud-chart-tooltip-label">{hoverLabel}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

interface PositionTimelineChartProps {
  series: PositionTimelineSeries[]
  height?: number | string
  viewBoxHeight?: number
  formatValue?: (value: number) => string
  xDomainStart?: number
  xDomainEnd?: number
  updateToken?: number
}

const MARKET_TIME_ZONE = 'America/New_York'

function formatTimelineTick(timestamp: number, minTimestamp: number, maxTimestamp: number): string {
  const spanMs = maxTimestamp - minTimestamp
  const date = new Date(timestamp)

  if (spanMs <= 36 * 60 * 60 * 1000) {
    return date.toLocaleTimeString('en-US', {
      timeZone: MARKET_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  }

  if (spanMs <= 3 * 24 * 60 * 60 * 1000) {
    return date.toLocaleString('en-US', {
      timeZone: MARKET_TIME_ZONE,
      weekday: 'short',
      hour: '2-digit',
      hour12: false,
    })
  }

  return date.toLocaleDateString('en-US', {
    timeZone: MARKET_TIME_ZONE,
    month: 'short',
    day: 'numeric',
  })
}

export const PositionTimelineChart = memo(function PositionTimelineChart({
  series,
  height = 220,
  viewBoxHeight,
  formatValue = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`,
  xDomainStart,
  xDomainEnd,
  updateToken,
}: PositionTimelineChartProps) {
  const [hoveredSeries, setHoveredSeries] = useState<number | null>(null)
  const [isPulsing, setIsPulsing] = useState(false)
  const hasMountedRef = useRef(false)

  useEffect(() => {
    if (updateToken === undefined) return

    if (!hasMountedRef.current) {
      hasMountedRef.current = true
      return
    }

    setIsPulsing(true)
    const timeoutId = window.setTimeout(() => setIsPulsing(false), 950)
    return () => window.clearTimeout(timeoutId)
  }, [updateToken])

  const allPoints = series.flatMap((item) => item.points).filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value))

  if (allPoints.length === 0) {
    return null
  }

  const viewBoxWidth = CHART_VIEWBOX_WIDTH
  const resolvedViewBoxHeight = viewBoxHeight ?? (typeof height === 'number' ? height : 300)
  const viewBoxHeightValue = resolvedViewBoxHeight
  const padding = { top: 18, right: 12, bottom: 34, left: 78 }
  const chartWidth = viewBoxWidth - padding.left - padding.right
  const chartHeight = viewBoxHeightValue - padding.top - padding.bottom

  const pointMinTimestamp = Math.min(...allPoints.map((point) => point.timestamp))
  const pointMaxTimestamp = Math.max(...allPoints.map((point) => point.timestamp))
  const minTimestamp = Number.isFinite(xDomainStart) ? (xDomainStart as number) : pointMinTimestamp
  const maxTimestamp = Number.isFinite(xDomainEnd) ? Math.max(xDomainEnd as number, pointMaxTimestamp) : pointMaxTimestamp
  const safeMaxTimestamp = maxTimestamp === minTimestamp ? minTimestamp + 60_000 : maxTimestamp

  const rawMinValue = Math.min(0, ...allPoints.map((point) => point.value))
  const rawMaxValue = Math.max(0, ...allPoints.map((point) => point.value))
  const paddedRange = Math.max(rawMaxValue - rawMinValue, 2)
  const minValue = rawMinValue - paddedRange * 0.12
  const maxValue = rawMaxValue + paddedRange * 0.12
  const valueRange = maxValue - minValue || 1

  const getX = (timestamp: number) =>
    padding.left + ((timestamp - minTimestamp) / (safeMaxTimestamp - minTimestamp || 1)) * chartWidth
  const getY = (value: number) => padding.top + chartHeight - ((value - minValue) / valueRange) * chartHeight

  const gridValues = Array.from({ length: 5 }, (_, index) => minValue + (valueRange / 4) * index)
  const tickCount = 5
  const timeTicks = Array.from({ length: tickCount }, (_, index) => {
    const ratio = index / (tickCount - 1)
    return minTimestamp + (safeMaxTimestamp - minTimestamp) * ratio
  })
  const zeroLineVisible = minValue < 0 && maxValue > 0

  return (
    <div className="hud-chart-shell w-full" style={{ height }}>
      <motion.div
        aria-hidden
        className="hud-chart-pulse"
        initial={false}
        animate={isPulsing ? { opacity: [0, 0.85, 0], scale: [0.985, 1.008, 1.02] } : { opacity: 0, scale: 1 }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      />
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeightValue}`}
        className="block h-full w-full"
        overflow="hidden"
        preserveAspectRatio="none"
      >
        <g>
          {gridValues.map((value, index) => (
            <g key={`grid-${index}`}>
              <line
                x1={padding.left}
                y1={getY(value)}
                x2={viewBoxWidth - padding.right}
                y2={getY(value)}
                stroke="currentColor"
                className="text-hud-border"
                strokeWidth={0.5}
                opacity={0.28}
              />
            </g>
          ))}
        </g>

        {zeroLineVisible && (
          <g>
            <line
              x1={padding.left}
              y1={getY(0)}
              x2={viewBoxWidth - padding.right}
              y2={getY(0)}
              stroke="var(--color-hud-primary)"
              strokeWidth={1.6}
              strokeDasharray="7,5"
              opacity={0.72}
            />
          </g>
        )}

        <g>
          {timeTicks.map((timestamp, index) => (
            <g key={`tick-${index}`}>
              <line
                x1={getX(timestamp)}
                y1={padding.top}
                x2={getX(timestamp)}
                y2={padding.top + chartHeight}
                stroke="currentColor"
                className="text-hud-border"
                strokeWidth={0.5}
                opacity={0.14}
              />
            </g>
          ))}
        </g>

        {series.map((item, seriesIndex) => {
          const colors = variantColors[item.variant ?? 'primary']
          const points = [...item.points]
            .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value))
            .sort((a, b) => a.timestamp - b.timestamp)
            .map((point) => ({
              ...point,
              x: getX(point.timestamp),
              y: getY(point.value),
            }))

          if (points.length < 2) return null

          const pathD = points.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
          const isHovered = hoveredSeries === seriesIndex

          return (
            <g
              key={item.label}
              onMouseEnter={() => setHoveredSeries(seriesIndex)}
              onMouseLeave={() => setHoveredSeries(null)}
            >
              <motion.path
                d={pathD}
                fill="none"
                stroke={colors.stroke}
                strokeWidth={isHovered ? 3 : 2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={isHovered || hoveredSeries === null ? 0.95 : 0.34}
                vectorEffect="non-scaling-stroke"
                animate={{ opacity: isHovered || hoveredSeries === null ? 0.95 : 0.34 }}
                transition={{ duration: 0.18 }}
              />

              {points.map((point, pointIndex) => {
                if (!point.label) return null

                if (point.label === 'NOW') {
                  return null
                }

                if (point.label === 'BUY' || point.label === 'SOLD') {
                  return (
                    <circle
                      key={`${item.label}-${pointIndex}`}
                      cx={point.x}
                      cy={point.y}
                      r={3.2}
                      fill={colors.stroke}
                      opacity={isHovered || hoveredSeries === null ? 0.95 : 0.45}
                    />
                  )
                }

                return (
                  <g key={`${item.label}-${pointIndex}`}>
                    {point.label && (
                      <circle
                        cx={point.x}
                        cy={point.y}
                        r={2.6}
                        fill={colors.stroke}
                        opacity={isHovered || hoveredSeries === null ? 0.9 : 0.45}
                      />
                    )}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>

      <div className="hud-chart-overlay hud-chart-overlay--labels" aria-hidden="true">
        {gridValues.map((value, index) => (
          <div
            key={`timeline-y-${index}`}
            className="hud-chart-axis-label hud-chart-axis-label-y"
            style={{
              top: toPercentY(getY(value), viewBoxHeightValue),
              width: `calc(${toPercentX(padding.left, viewBoxWidth)} - 10px)`,
            }}
          >
            {formatValue(value)}
          </div>
        ))}

        {timeTicks.map((timestamp, index) => (
          <div
            key={`timeline-x-${index}`}
            className="hud-chart-axis-label hud-chart-axis-label-x"
            style={{
              left: toPercentX(getX(timestamp), viewBoxWidth),
              bottom: '4px',
            }}
          >
            {formatTimelineTick(timestamp, minTimestamp, safeMaxTimestamp)}
          </div>
        ))}
      </div>
    </div>
  )
})

// Mini sparkline chart for inline use
interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  variant?: ChartVariant
  showChange?: boolean
}

export function Sparkline({
  data,
  width = 80,
  height = 24,
}: SparklineProps) {
  if (data.length < 2) return null

  const padding = 2
  const chartWidth = width - padding * 2
  const chartHeight = height - padding * 2

  const minValue = Math.min(...data)
  const maxValue = Math.max(...data)
  const valueRange = maxValue - minValue || 1

  const points = data.map((value, i) => ({
    x: padding + (i / (data.length - 1)) * chartWidth,
    y: padding + chartHeight - ((value - minValue) / valueRange) * chartHeight,
    value,
  }))
  const baseline = data[0]
  const baselineY = padding + chartHeight - ((baseline - minValue) / valueRange) * chartHeight
  const segments: Array<{ x1: number; y1: number; x2: number; y2: number; positive: boolean }> = []

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!
    const current = points[index]!
    const previousPositive = previous.value >= baseline
    const currentPositive = current.value >= baseline

    if (previousPositive === currentPositive) {
      segments.push({
        x1: previous.x,
        y1: previous.y,
        x2: current.x,
        y2: current.y,
        positive: previousPositive,
      })
      continue
    }

    const deltaValue = current.value - previous.value || 1
    const crossRatio = (baseline - previous.value) / deltaValue
    const crossX = previous.x + (current.x - previous.x) * crossRatio
    const crossY = previous.y + (current.y - previous.y) * crossRatio

    segments.push({
      x1: previous.x,
      y1: previous.y,
      x2: crossX,
      y2: crossY,
      positive: previousPositive,
    })
    segments.push({
      x1: crossX,
      y1: crossY,
      x2: current.x,
      y2: current.y,
      positive: currentPositive,
    })
  }

  return (
    <svg width={width} height={height}>
      <line
        x1={padding}
        y1={baselineY}
        x2={width - padding}
        y2={baselineY}
        stroke="currentColor"
        className="text-hud-border"
        strokeWidth={0.75}
        opacity={0.28}
      />
      {segments.map((segment, index) => (
        <line
          key={`${segment.x1}-${segment.y1}-${index}`}
          x1={segment.x1}
          y1={segment.y1}
          x2={segment.x2}
          y2={segment.y2}
          fill="none"
          stroke={segment.positive ? variantColors.green.stroke : variantColors.red.stroke}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}
