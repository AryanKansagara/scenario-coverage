import { useEffect, useMemo, useState } from 'react'
import type { Pair } from './engine/coverage.ts'
import { DEFAULT_THRESHOLDS, HERO_PARAMS, SAMPLE_ODD, simulate } from './engine/sample.ts'
import { Link } from './ui.tsx'
import { HeatLegend, Heatmap, reducedMotion, Replay } from './viz.tsx'

interface Frame { label: string; pairwise: number; runs: number; fails: number; pairs: Pair[] }

const PAIR_A = SAMPLE_ODD.findIndex(d => d.key === 'ego_speed'), PAIR_B = SAMPLE_ODD.findIndex(d => d.key === 'gap')

function CoverageStage() {
  const [frames, setFrames] = useState<Frame[] | null>(null)
  const [step, setStep] = useState(0)
  const [reveal, setReveal] = useState(0)
  const [auto, setAuto] = useState(!reducedMotion())
  useEffect(() => {
    const w = new Worker(new URL('./heroWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = e => { setFrames(e.data as Frame[]); w.terminate() }
    return () => w.terminate()
  }, [])
  // Each campaign "paints" its cells in, then the next one lands.
  useEffect(() => {
    if (!frames) return
    if (reducedMotion()) { setReveal(1); return }
    setReveal(0)
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => { const r = Math.min(1, (now - start) / 900); setReveal(r); if (r < 1) raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [frames, step])
  useEffect(() => {
    if (!frames || !auto) return
    const t = setTimeout(() => setStep(s => (s + 1) % frames.length), 3400)
    return () => clearTimeout(t)
  }, [frames, step, auto])

  const f = frames?.[step]
  const pair = f?.pairs.find(p => p.a === PAIR_A && p.b === PAIR_B)
  return (
    <div className="stage-card">
      <div className="stage-head">
        <span className="stage-title">ODD coverage · ego speed × cut-in gap</span>
        <span className="stage-num tab-nums">{f ? `${(f.pairwise * 100).toFixed(1)}%` : '—'}<small>pairwise, all 7 dims</small></span>
      </div>
      <div className="stage-steps" role="tablist" aria-label="Campaigns">
        {(frames ?? [{ label: 'Aug 2026' }, { label: 'Sep 2026' }, { label: 'Oct 2026' }] as Frame[]).map((x, i) => (
          <button key={i} type="button" role="tab" aria-selected={i === step} className={i <= step ? 'on' : ''} disabled={!frames} onClick={() => { setAuto(false); setStep(i) }}>
            <b>+ {x.label.split('·')[0].trim()}</b><small>{x.label.split('·')[1]?.trim() ?? 'loading'}</small>
          </button>
        ))}
      </div>
      {pair ? <Heatmap odd={SAMPLE_ODD} pair={pair} reveal={reveal} /> : <div className="stage-loading"><span className="spinner" /> Simulating 600 synthetic runs</div>}
      <div className="row between wrap gap-sm"><HeatLegend />{f && <span className="muted tiny tab-nums">{f.runs} runs · {f.fails} failed in this campaign</span>}</div>
    </div>
  )
}

const FEATURES: [string, string, string][] = [
  ['Import what you already have', 'Parameter tables, OpenSCENARIO 1.x files, CARLA scenario_runner JSON and per-run trajectory CSVs. Auto-detected, mapped and validated with line numbers.', 'M4 4h16v16H4zM4 9h16M9 9v11'],
  ['Coverage you can defend', '1-way and pairwise (2-way combinatorial) coverage over your ODD, a heatmap for every parameter pair, and a gap list ranked by risk.', 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z'],
  ['Metrics from motion', 'TTC with oriented bounding boxes, post-encroachment time, minimum gap, peak deceleration and jerk, and lane offset from a centreline polyline.', 'M3 17l5-5 4 4 8-8M15 8h5v5'],
  ['Fails when X and Y', 'Failure clustering with k-means on normalised parameters plus decision-tree rules, and a triage worklist with status and notes.', 'M12 3l9 16H3zM12 10v4M12 17h.01'],
  ['What to run next', 'Maximin space-filling over untested cells and boundary probes near failures. Export CSV or an OpenSCENARIO ParameterValueDistribution.', 'M5 12h14M13 6l6 6-6 6'],
  ['Campaign history', 'Every campaign is a dated snapshot. Watch coverage climb, compare two campaigns, see which failure regions appeared or went away.', 'M4 19V5M4 19h16M8 15l3-4 3 2 4-6'],
]

const QUOTES: [string, string][] = [
  ['Which simulators are actually usable for research now that LGSVL is sunset and Applied Intuition is closed? CARLA scenario_runner seems to be what is left.', 'r/SelfDrivingCars, “What good autonomous driving simulators are there for research?” (paraphrased)'],
  ['Can AI help design automated driving scenarios, instead of hand-building every one?', 'r/matlab, “Can you design an automated driving scenario with AI?” (paraphrased)'],
  ['The hard part of simulation testing is finding the safety-critical scenarios, not running the easy ones.', 'r/Scholar, “Simulation testing of autonomous driving systems based on safety-critical scenarios” (paraphrased)'],
  ['World models make it possible to generate far more scenarios than anyone can review. Which ones matter?', 'r/waymo, “The Waymo World Model: a new frontier for AD simulation” (paraphrased)'],
]

export function Landing() {
  const rows = useMemo(() => simulate(HERO_PARAMS, 4), [])
  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-copy">
            <div className="eyebrow">For AV safety and simulation engineers</div>
            <h1 className="display">Know what you <em>haven&rsquo;t</em> tested.</h1>
            <p className="lede">Import your scenario catalog and simulation results. Measure coverage of the operational design domain, compute TTC, PET and braking from trajectories, find where the stack fails, and get the next scenarios to run.</p>
            <div className="hero-ctas">
              <Link href="/app?sample=1" className="btn primary lg">Open the sample campaign</Link>
              <Link href="/app" className="btn outline lg">Import your data</Link>
            </div>
            <p className="hero-note">Runs in your browser. No account needed. The sample is a synthetic highway trucking programme.</p>
          </div>
          <div className="stage">
            <div className="stage-card dark">
              <div className="stage-head"><span className="stage-title">Replay · cut-in at 9 m, 88 km/h, dusk</span><span className="badge synthetic">Synthetic</span></div>
              <Replay rows={rows} th={DEFAULT_THRESHOLDS} autoplay loop compact speed={1} />
              <p className="stage-cap">A car cuts into a 9 m gap in front of a loaded tractor-trailer. TTC is computed live from oriented bounding boxes; the strip below turns red under the 1.5 s threshold.</p>
            </div>
            <CoverageStage />
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head"><div className="eyebrow">The problem</div><h2>Running scenarios is easy. Knowing which ones you are missing is not.</h2><p>Simulators generate runs faster than anyone can review them. Coverage lives in spreadsheets, failures in log folders, and the next campaign gets planned from memory.</p></div>
        <div className="quotes">{QUOTES.map(([q, s]) => <figure key={s} className="quote"><blockquote>{q}</blockquote><figcaption className="src">{s}</figcaption></figure>)}</div>
      </section>

      <section className="section">
        <div className="section-head"><div className="eyebrow">What it does</div><h2>From a folder of results to the next campaign plan.</h2></div>
        <div className="features">{FEATURES.map(([t, d, icon]) => (
          <article key={t} className="feature"><div className="ico"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icon} /></svg></div><h3>{t}</h3><p>{d}</p></article>
        ))}</div>
      </section>

      <section className="section">
        <div className="steps">
          {[['01', 'Define the ODD', 'Weather, lighting, road type, speeds, actor types, cut-in gaps. Inferred from your files, editable.'], ['02', 'Import a campaign', 'A table, .xosc files, CARLA results or trajectories. Each campaign is a dated snapshot.'], ['03', 'Triage failures', 'Rules and clusters say where it fails; the worklist tracks who is on it.'], ['04', 'Export the next runs', 'CSV or OpenSCENARIO parameter distributions, plus a printable coverage report.']].map(([n, t, d]) => (
            <div key={n} className="step"><span>{n}</span><h3>{t}</h3><p>{d}</p></div>
          ))}
        </div>
      </section>

      <section className="cta-band">
        <div className="cta-inner">
          <div><h2>See it on 600 synthetic runs.</h2><p>Three campaigns of cut-ins, merges, braking leads and debris, with trajectories to replay.</p></div>
          <Link href="/app?sample=1" className="btn primary lg">Open the sample</Link>
        </div>
      </section>
    </>
  )
}
