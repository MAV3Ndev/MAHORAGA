import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'

interface MetricProps {
  label: string
  value: string | number
  size?: 'sm' | 'md' | 'lg' | 'xl'
  color?: 'default' | 'success' | 'warning' | 'error'
  className?: string
}

const sizeClasses = {
  sm: 'hud-value-sm',
  md: 'hud-value-md',
  lg: 'hud-value-lg',
  xl: 'hud-value-xl',
}

const colorClasses = {
  default: '',
  success: 'text-hud-success',
  warning: 'text-hud-warning',
  error: 'text-hud-error',
}

interface FormattedToken {
  char: string
  digitIndexFromRight: number | null
}

function tokenizeFormattedValue(formattedValue: string): FormattedToken[] {
  let digitIndex = 0
  return formattedValue
    .split('')
    .reverse()
    .map((char) => {
      if (/\d/.test(char)) {
        const token: FormattedToken = { char, digitIndexFromRight: digitIndex }
        digitIndex += 1
        return token
      }

      return { char, digitIndexFromRight: null }
    })
    .reverse()
}

function buildDigitMap(tokens: FormattedToken[]): Record<number, number> {
  return tokens.reduce<Record<number, number>>((accumulator, token) => {
    if (token.digitIndexFromRight !== null) {
      accumulator[token.digitIndexFromRight] = Number(token.char)
    }
    return accumulator
  }, {})
}

function buildReelSequence(previousDigit: number, nextDigit: number, direction: number): number[] {
  if (previousDigit === nextDigit || direction === 0) {
    return [nextDigit]
  }

  const sequence = [previousDigit]
  let currentDigit = previousDigit

  while (currentDigit !== nextDigit) {
    currentDigit = direction > 0 ? (currentDigit + 1) % 10 : (currentDigit + 9) % 10
    sequence.push(currentDigit)
  }

  return sequence
}

interface DigitReelProps {
  digit: number
  previousDigit?: number
  direction: number
  delaySeconds: number
  durationSeconds: number
  spinKey: number
}

function DigitReel({
  digit,
  previousDigit,
  direction,
  delaySeconds,
  durationSeconds,
  spinKey,
}: DigitReelProps) {
  const sequence = useMemo(() => {
    if (previousDigit === undefined) {
      return [digit]
    }

    return buildReelSequence(previousDigit, digit, direction)
  }, [digit, direction, previousDigit])
  const reverseSpin = direction > 0
  const displaySequence = useMemo(
    () => (reverseSpin ? [...sequence].reverse() : sequence),
    [reverseSpin, sequence],
  )

  const shouldAnimate = previousDigit !== undefined && sequence.length > 1
  const startOffset = shouldAnimate ? (reverseSpin ? displaySequence.length - 1 : 0) : displaySequence.length - 1
  const endOffset = displaySequence.length - 1 - startOffset
  const [offsetSteps, setOffsetSteps] = useState(startOffset)

  useEffect(() => {
    if (!shouldAnimate) {
      setOffsetSteps(displaySequence.length - 1)
      return
    }

    setOffsetSteps(startOffset)
    const frameId = window.requestAnimationFrame(() => {
      setOffsetSteps(endOffset)
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [displaySequence.length, endOffset, shouldAnimate, spinKey, startOffset])

  return (
    <span className="hud-reel-slot" aria-hidden="true">
      <span
        className={clsx('hud-reel-strip', shouldAnimate && 'hud-reel-strip-spinning')}
        style={{
          transform: `translateY(calc(-1em * ${offsetSteps}))`,
          transitionDuration: shouldAnimate ? `${durationSeconds}s` : '0s',
          transitionDelay: shouldAnimate ? `${delaySeconds}s` : '0s',
        }}
      >
        {displaySequence.map((sequenceDigit, index) => (
          <span key={`${sequenceDigit}-${index}`} className="hud-reel-digit">
            {sequenceDigit}
          </span>
        ))}
      </span>
    </span>
  )
}

export function Metric({
  label,
  value,
  size = 'lg',
  color = 'default',
  className,
}: MetricProps) {
  return (
    <div className={clsx('flex flex-col', className)}>
      <span className="hud-label mb-1">{label}</span>
      <span className={clsx(sizeClasses[size], colorClasses[color])}>
        {value}
      </span>
    </div>
  )
}

interface MetricInlineProps {
  label: string
  value: string | number
  color?: 'default' | 'success' | 'warning' | 'error'
  valueClassName?: string
  className?: string
}

export function MetricInline({
  label,
  value,
  color = 'default',
  valueClassName,
  className,
}: MetricInlineProps) {
  return (
    <div className={clsx('flex items-baseline gap-2', className)}>
      <span className="hud-label">{label}</span>
      <span className={clsx('hud-value-sm', valueClassName || colorClasses[color])}>
        {value}
      </span>
    </div>
  )
}

interface AnimatedMetricValueProps {
  value: number
  formatter: (value: number) => string
  className?: string
  durationMs?: number
  pulseOnChange?: boolean
}

export function AnimatedMetricValue({
  value,
  formatter,
  className,
  durationMs = 900,
  pulseOnChange = false,
}: AnimatedMetricValueProps) {
  const formattedValue = formatter(value)
  const tokens = useMemo(() => tokenizeFormattedValue(formattedValue), [formattedValue])
  const digitMap = useMemo(() => buildDigitMap(tokens), [tokens])
  const previousValueRef = useRef(value)
  const previousDigitMapRef = useRef<Record<number, number>>(digitMap)
  const pulseTimeoutRef = useRef<number | null>(null)
  const pulseFrameRef = useRef<number | null>(null)
  const [direction, setDirection] = useState(0)
  const [animationVersion, setAnimationVersion] = useState(0)
  const [animationPreviousDigits, setAnimationPreviousDigits] = useState<Record<number, number>>(digitMap)
  const [pulseClassName, setPulseClassName] = useState('')

  useEffect(() => {
    const nextDirection = value === previousValueRef.current ? 0 : value > previousValueRef.current ? 1 : -1
    if (nextDirection !== 0) {
      setAnimationPreviousDigits(previousDigitMapRef.current)
      setDirection(nextDirection)
      setAnimationVersion((current) => current + 1)

      if (pulseOnChange) {
        setPulseClassName('')

        if (pulseFrameRef.current !== null) {
          window.cancelAnimationFrame(pulseFrameRef.current)
        }
        if (pulseTimeoutRef.current !== null) {
          window.clearTimeout(pulseTimeoutRef.current)
        }

        pulseFrameRef.current = window.requestAnimationFrame(() => {
          setPulseClassName(nextDirection > 0 ? 'hud-counter-pulse-up' : 'hud-counter-pulse-down')
        })

        pulseTimeoutRef.current = window.setTimeout(() => {
          setPulseClassName('')
          pulseTimeoutRef.current = null
        }, 720)
      }
    }
    previousValueRef.current = value
    previousDigitMapRef.current = digitMap

    return () => {
      if (pulseFrameRef.current !== null) {
        window.cancelAnimationFrame(pulseFrameRef.current)
        pulseFrameRef.current = null
      }
    }
  }, [digitMap, pulseOnChange, value])

  useEffect(() => {
    return () => {
      if (pulseFrameRef.current !== null) {
        window.cancelAnimationFrame(pulseFrameRef.current)
      }
      if (pulseTimeoutRef.current !== null) {
        window.clearTimeout(pulseTimeoutRef.current)
      }
    }
  }, [])

  return (
    <span className={clsx('hud-counter', pulseClassName, className)} aria-label={formattedValue}>
      {tokens.map((token, index) => {
        if (token.digitIndexFromRight === null) {
          return (
            <span key={`static-${index}-${token.char}`} className="hud-counter-static">
              {token.char}
            </span>
          )
        }

        const previousDigit = animationPreviousDigits[token.digitIndexFromRight]
        const reelDelay = direction >= 0 ? token.digitIndexFromRight * 0.028 : token.digitIndexFromRight * 0.018
        const reelDuration = Math.max(0.42, durationMs / 1000 - token.digitIndexFromRight * 0.02)

        return (
          <DigitReel
            key={`digit-${token.digitIndexFromRight}-${animationVersion}`}
            digit={Number(token.char)}
            previousDigit={previousDigit}
            direction={direction}
            delaySeconds={reelDelay}
            durationSeconds={reelDuration}
            spinKey={animationVersion}
          />
        )
      })}
    </span>
  )
}
