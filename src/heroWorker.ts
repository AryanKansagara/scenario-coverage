// Builds the landing-page coverage map off the main thread: 600 simulated runs take about a second.
import { coverage, judgeAll } from './engine/coverage.ts'
import { DEFAULT_THRESHOLDS, generateSample, SAMPLE_ODD } from './engine/sample.ts'

const { campaigns } = generateSample()
let acc: typeof campaigns[number]['runs'] = []
const frames = campaigns.map(c => {
  acc = [...acc, ...c.runs]
  const cov = coverage(SAMPLE_ODD, acc, judgeAll(acc, DEFAULT_THRESHOLDS))
  const fails = judgeAll(c.runs, DEFAULT_THRESHOLDS).filter(v => v.status === 'fail').length
  return { label: c.label, pairwise: cov.pairwisePct, runs: acc.length, fails, pairs: cov.pairs }
})
postMessage(frames)
