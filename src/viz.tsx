import { useEffect, useMemo, useRef, useState } from 'react'
import type { Pair } from './engine/coverage.ts'
import { binLabels } from './engine/coverage.ts'
import { computeMetrics, stateAt, toTracks } from './engine/metrics.ts'
import type { Odd, Thresholds, TrajRow } from './engine/types.ts'

export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

const short = (s: string) => s.replace(/_/g, ' ')

// ---------- Pairwise heatmap ----------

export function Heatmap({ odd, pair, reveal = 1, compact, onCell, selected }: { odd: Odd; pair: Pair; reveal?: number; compact?: boolean; onCell?(i: number, j: number): void; selected?: [number, number] | null }) {
  const A = odd[pair.a], B = odd[pair.b]
  const la = binLabels(A), lb = binLabels(B)
  const max = Math.max(1, ...pair.counts.flat())
  return (
    <div className={`heatmap${compact ? ' compact' : ''}`} style={{ ['--cols' as string]: lb.length }}>
      <div className="hm-corner"><span>{A.label}{A.unit ? ` (${A.unit})` : ''}</span><span>{B.label}{B.unit ? ` (${B.unit})` : ''} &rarr;</span></div>
      {lb.map(l => <div key={l} className="hm-col" title={l}>{short(l)}</div>)}
      {la.map((l, i) => (
        <div key={l} className="hm-row">
          <div className="hm-lab" title={l}>{short(l)}</div>
          {lb.map((_, j) => {
            const n = pair.counts[i][j], f = pair.fails[i][j]
            const shown = (i * lb.length + j) / (la.length * lb.length) < reveal
            const v = n ? Math.round(18 + 82 * Math.sqrt(n / max)) : 0
            const rate = n ? f / n : 0
            const label = `${A.label} ${la[i]} × ${B.label} ${lb[j]}: ${n ? `${n} run${n > 1 ? 's' : ''}, ${f} failed` : 'not tested'}`
            const cls = `hm-cell${n && shown ? ' hit' : ''}${n && shown && v > 50 ? ' deep' : ''}${!n ? ' gap' : ''}${rate >= 0.5 ? ' hot' : rate > 0 ? ' warm' : ''}${selected && selected[0] === i && selected[1] === j ? ' sel' : ''}`
            return onCell
              ? <button key={j} type="button" className={cls} style={{ ['--v' as string]: `${shown ? v : 0}%` }} aria-label={label} title={label} onClick={() => onCell(i, j)}>{!compact && n ? <span>{n}</span> : null}</button>
              : <div key={j} className={cls} style={{ ['--v' as string]: `${shown ? v : 0}%` }} title={label}>{!compact && n ? <span>{n}</span> : null}</div>
          })}
        </div>
      ))}
    </div>
  )
}

export const HeatLegend = () => (
  <div className="legend"><span><i className="lg-hit" />Runs (darker = more)</span><span><i className="lg-warm" />Some failures</span><span><i className="lg-hot" />Fails ≥ 50%</span><span><i className="lg-gap" />Not tested</span></div>
)

// ---------- Top-down replay ----------

const LANE = 3.7

export function Replay({ rows, th, autoplay = false, loop = false, compact = false, speed: initialSpeed = 1, laneWidth = LANE }: { rows: TrajRow[]; th: Thresholds; autoplay?: boolean; loop?: boolean; compact?: boolean; speed?: number; laneWidth?: number }) {
  const { ego, others } = useMemo(() => toTracks(rows), [rows])
  const res = useMemo(() => computeMetrics(rows, { laneWidth }), [rows, laneWidth])
  const t0 = ego.t[0], t1 = ego.t[ego.t.length - 1]
  const [t, setT] = useState(autoplay && !reducedMotion() ? t0 : t1 * 0.45)
  const [playing, setPlaying] = useState(autoplay && !reducedMotion())
  const [speed, setSpeed] = useState(initialSpeed)
  const last = useRef<number | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!playing) { last.current = null; return }
    let raf = 0
    const tick = (now: number) => {
      const dt = last.current === null ? 0 : (now - last.current) / 1000
      last.current = now
      setT(prev => {
        const n = prev + dt * speed
        if (n > t1) { if (loop) return t0; setPlaying(false); return t1 }
        return n
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, loop, t0, t1])

  useEffect(() => {
    if (compact) return
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement
      if (ev.key !== ' ' || /INPUT|TEXTAREA|SELECT|BUTTON/.test(el.tagName)) return
      ev.preventDefault()
      setPlaying(p => !p)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [compact])

  // Pause offscreen loops (landing page) to save battery.
  useEffect(() => {
    if (!loop || !box.current || typeof IntersectionObserver === 'undefined') return
    const ob = new IntersectionObserver(([e]) => setPlaying(e.isIntersecting && !reducedMotion()))
    ob.observe(box.current)
    return () => ob.disconnect()
  }, [loop])

  const e = stateAt(ego, t) ?? { x: ego.x[0], y: ego.y[0], h: 0, v: ego.v[0] }
  const i = Math.max(0, Math.min(res.series.t.length - 1, Math.round(((t - t0) / Math.max(1e-9, t1 - t0)) * (res.series.t.length - 1))))
  const ttc = res.series.ttc[i], gap = res.series.dist[i], acc = res.series.accel[i]
  const danger = ttc < th.ttc, warn = ttc < th.ttc * 2
  const W = compact ? 72 : 96, left = 14, H = laneWidth * (compact ? 4.4 : 5)
  const vx = e.x - left
  const dash = 12
  const dashOff = -(vx % dash)

  return (
    <div className={`replay${compact ? ' compact' : ''}`} ref={box}>
      <div className="replay-stage">
        <svg viewBox={`0 ${-H / 2} ${W} ${H}`} style={{ aspectRatio: `${W} / ${H}` }} role="img" aria-label={`Top-down replay at ${t.toFixed(1)} seconds. Time to collision ${Number.isFinite(ttc) ? ttc.toFixed(2) + ' seconds' : 'not closing'}.`} preserveAspectRatio="xMidYMid meet">
          <rect x="0" y={-laneWidth * 1.5} width={W} height={laneWidth * 3} className="rp-road" />
          {[-1.5, 1.5].map(k => <line key={k} x1="0" x2={W} y1={k * laneWidth} y2={k * laneWidth} className="rp-edge" />)}
          {[-0.5, 0.5].map(k => <line key={k} x1={dashOff - dash} x2={W + dash} y1={k * laneWidth} y2={k * laneWidth} className="rp-lane" strokeDasharray={`${dash / 2} ${dash / 2}`} />)}
          {/* Constant-velocity projection used by the TTC readout */}
          <line x1={left} y1={-e.y} x2={left + e.v * Math.min(3, Number.isFinite(ttc) ? ttc : 3)} y2={-e.y} className={`rp-proj${danger ? ' danger' : ''}`} />
          {others.map(o => {
            const s = stateAt(o, t)
            if (!s) return null
            return <g key={o.id} transform={`translate(${s.x - vx} ${-s.y}) rotate(${(-s.h * 180) / Math.PI})`}>
              <rect x={-o.len / 2} y={-o.wid / 2} width={o.len} height={o.wid} rx={o.len > 2 ? 0.6 : 0.2} className={`rp-actor${danger ? ' danger' : warn ? ' warn' : ''}`} />
              {!compact && <text x="0" y={-o.wid / 2 - 0.6} className="rp-tag" textAnchor="middle">{o.id}</text>}
            </g>
          })}
          <g transform={`translate(${left} ${-e.y}) rotate(${(-e.h * 180) / Math.PI})`}>
            <rect x={-ego.len / 2} y={-ego.wid / 2} width={ego.len - 4.2} height={ego.wid} rx="0.3" className="rp-trailer" />
            <rect x={ego.len / 2 - 3.8} y={-ego.wid / 2} width="3.8" height={ego.wid} rx="0.6" className="rp-cab" />
            {!compact && <text x={-ego.len / 4} y={-ego.wid / 2 - 0.6} className="rp-tag" textAnchor="middle">ego truck</text>}
          </g>
        </svg>
        <div className={`ttc-readout${danger ? ' danger' : warn ? ' warn' : ''}`} aria-live="off">
          <small>TTC</small>
          <b>{Number.isFinite(ttc) ? ttc.toFixed(2) : '∞'}<span>s</span></b>
          <div className="ro-sub"><span>gap {Number.isFinite(gap) ? gap.toFixed(1) : '—'} m</span><span>{(e.v * 3.6).toFixed(0)} km/h</span><span>{acc < -0.05 ? `brake ${(-acc).toFixed(1)}` : 'coast'}{acc < -0.05 ? ' m/s²' : ''}</span></div>
        </div>
      </div>
      <TtcStrip series={res.series} th={th} t={t} onSeek={x => { setPlaying(false); setT(x) }} />
      {!compact && (
        <div className="replay-controls">
          <button type="button" className="btn ghost sm" onClick={() => { if (t >= t1) setT(t0); setPlaying(p => !p) }} aria-label={playing ? 'Pause' : 'Play'}>{playing ? 'Pause' : 'Play'}</button>
          <input type="range" min={t0} max={t1} step="0.05" value={t} onChange={ev => { setPlaying(false); setT(Number(ev.target.value)) }} aria-label="Scrub time" />
          <span className="mono small tab-nums">{t.toFixed(1)} / {t1.toFixed(1)} s</span>
          <select value={speed} onChange={ev => setSpeed(Number(ev.target.value))} aria-label="Playback speed">{[0.25, 0.5, 1, 2].map(s => <option key={s} value={s}>{s}×</option>)}</select>
        </div>
      )}
    </div>
  )
}

function TtcStrip({ series, th, t, onSeek }: { series: { t: number[]; ttc: number[] }; th: Thresholds; t: number; onSeek(t: number): void }) {
  const W = 300, H = 46, cap = Math.max(6, th.ttc * 3)
  const t0 = series.t[0], t1 = series.t.at(-1) ?? 1
  const X = (x: number) => ((x - t0) / Math.max(1e-9, t1 - t0)) * W
  const Y = (v: number) => H - 3 - (Math.min(cap, v) / cap) * (H - 8)
  let d = ''
  series.t.forEach((x, i) => { const v = series.ttc[i]; d += `${!d || !Number.isFinite(series.ttc[i - 1] ?? Infinity) && Number.isFinite(v) ? 'M' : 'L'}${X(x).toFixed(1)},${Y(Number.isFinite(v) ? v : cap).toFixed(1)}` })
  return (
    <svg className="ttc-strip" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Time-to-collision over the run"
      onPointerDown={e => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); onSeek(t0 + ((e.clientX - r.left) / r.width) * (t1 - t0)) }}>
      <rect x="0" y={Y(th.ttc)} width={W} height={H - Y(th.ttc)} className="ts-danger" />
      <line x1="0" x2={W} y1={Y(th.ttc)} y2={Y(th.ttc)} className="ts-th" />
      <path d={d} className="ts-line" vectorEffect="non-scaling-stroke" />
      <line x1={X(t)} x2={X(t)} y1="0" y2={H} className="ts-head" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ---------- Small charts ----------

export function Hist({ values, threshold, unit, lowerIsBad = true, bins = 16, max }: { values: number[]; threshold: number; unit: string; lowerIsBad?: boolean; bins?: number; max?: number }) {
  const xs = values.filter(Number.isFinite)
  if (!xs.length) return <p className="muted small">Not measured in this scope.</p>
  const hi = max ?? Math.max(threshold * 2, ...xs.map(x => Math.min(x, threshold * 4)))
  const w = hi / bins
  const counts = Array(bins).fill(0)
  for (const x of xs) counts[Math.min(bins - 1, Math.floor(Math.min(x, hi) / w))]++
  const top = Math.max(...counts)
  const bad = (i: number) => lowerIsBad ? (i + 1) * w <= threshold + 1e-9 : i * w >= threshold - 1e-9
  return (
    <div className="hist" role="img" aria-label={`Distribution of ${xs.length} values, threshold ${threshold} ${unit}`}>
      <div className="hist-bars">{counts.map((c, i) => <span key={i} className={bad(i) ? 'bad' : ''} style={{ height: `${(c / top) * 100}%` }} title={`${(i * w).toFixed(1)}–${((i + 1) * w).toFixed(1)} ${unit}: ${c}`} />)}
        <i style={{ left: `${(threshold / hi) * 100}%` }} title={`Threshold ${threshold} ${unit}`} />
      </div>
      <div className="hist-axis"><span>0</span><span>{threshold} {unit}</span><span>{hi.toFixed(hi < 10 ? 1 : 0)}+</span></div>
    </div>
  )
}

export function TrendChart({ points, compareIds }: { points: { id: string; label: string; pairwise: number; oneWay: number; failRate: number; cumRuns: number }[]; compareIds?: string[] }) {
  if (!points.length) return null
  const W = 960, H = 250, padL = 44, padR = 60, padT = 24, padB = 44
  const X = (i: number) => padL + (points.length === 1 ? (W - padL - padR) / 2 : (i / (points.length - 1)) * (W - padL - padR))
  const Y = (v: number) => padT + (1 - v) * (H - padT - padB)
  const line = (k: 'pairwise' | 'oneWay') => points.map((p, i) => `${i ? 'L' : 'M'}${X(i)},${Y(p[k])}`).join('')
  const bw = Math.min(46, ((W - padL - padR) / points.length) * 0.4)
  return (
    <svg className="trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Coverage trend: ${points.map(p => `${p.label} ${Math.round(p.pairwise * 100)}% pairwise`).join(', ')}`}>
      {[0, 0.25, 0.5, 0.75, 1].map(v => <g key={v}><line x1={padL} x2={W - padR} y1={Y(v)} y2={Y(v)} className="grid" /><text x={padL - 6} y={Y(v) + 4} textAnchor="end" className="axis">{v * 100}%</text></g>)}
      {points.map((p, i) => <rect key={p.id} x={X(i) - bw / 2} y={Y(p.failRate)} width={bw} height={Y(0) - Y(p.failRate)} rx="4" className={`fail-bar${compareIds?.includes(p.id) ? ' on' : ''}`}><title>{`${p.label}: ${Math.round(p.failRate * 100)}% of runs failed`}</title></rect>)}
      <path d={line('oneWay')} className="l-oneway" />
      <path d={line('pairwise')} className="l-pair" />
      {points.map((p, i) => <g key={p.id}><circle cx={X(i)} cy={Y(p.pairwise)} r="5" className="dot" /><text x={X(i) + (i === 0 && points.length > 1 ? 8 : 0)} y={Y(p.pairwise) - 10} textAnchor={i === 0 && points.length > 1 ? 'start' : 'middle'} className="val">{Math.round(p.pairwise * 1000) / 10}%</text>
        <text x={X(i)} y={H - 24} textAnchor="middle" className="axis">{p.label.split('·')[0].trim()}</text><text x={X(i)} y={H - 10} textAnchor="middle" className="axis faint">{p.cumRuns} runs total</text></g>)}
    </svg>
  )
}

export function Meter({ value, label }: { value: number; label: string }) {
  return <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label}><span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></div>
}
