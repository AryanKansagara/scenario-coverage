export type ParamValue = number | string
export type Params = Record<string, ParamValue>

/** One dimension of the operational design domain. Ranges are binned evenly; categories are their own bins. */
export interface OddParam {
  key: string
  label: string
  kind: 'range' | 'category'
  unit?: string
  min?: number
  max?: number
  bins?: number
  categories?: string[]
}
export type Odd = OddParam[]

/** Safety metrics for one run. Missing values mean "not measured". */
export interface Metrics {
  ttc?: number // s, minimum time-to-collision
  pet?: number // s, minimum post-encroachment time
  minDist?: number // m, closest box-to-box gap
  maxDecel?: number // m/s², strongest ego braking
  maxJerk?: number // m/s³
  laneDev?: number // m, largest offset from the lane centreline
  collision?: boolean
}

export interface Run {
  id: string
  scenario: string
  params: Params
  metrics: Metrics
  /** Verdict reported by the simulator (CARLA criteria, a result column). */
  outcome?: 'pass' | 'fail'
  reason?: string
  /** A per-run trajectory is stored on this device. */
  traj?: boolean
}

export interface Thresholds {
  ttc: number
  pet: number
  minDist: number
  maxDecel: number
  maxJerk: number
  laneDev: number
}

/** A test campaign: one batch of simulation runs. Campaigns are the project's dated snapshots. */
export interface Campaign {
  id: string
  label: string
  date: string // YYYY-MM-DD
  runs: Run[]
  source?: string
}

export interface TrajRow { t: number; id: string; x: number; y: number; h: number; v: number; len?: number; wid?: number }
