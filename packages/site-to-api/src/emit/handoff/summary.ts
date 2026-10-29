/**
 * Limits that keep `AGENT.md` an index on any site (decision 0041). Each list `AGENT.md` cuts
 * ends with a line saying how many more there are and which file has them; nothing is dropped
 * from the folder, only moved to `hosts/<host>.md`, `flows.md` or `API_MAP.md`.
 */
import { counted } from './context'

/** Lines per list in `AGENT.md`: hosts, flows, endpoints, channels, computed values, gaps. */
export const MAX_SUMMARY_LINES = 12

/** More lines for the two lists an agent most needs whole when there is room: hosts and gaps. */
export const MAX_HOST_LINES = 30
export const MAX_GAP_LINES = 15

/** Steps written per flow in `AGENT.md`; `flows.md` has all of them. */
const MAX_FLOW_STEPS = 6

/** Characters of a flow name (a page title or button label) kept in `AGENT.md`. */
export const MAX_NAME_LENGTH = 80

/** `- 4 more endpoints in the host files.`, or nothing when nothing was left out. */
export function moreLine(left: number, noun: string, where: string): string[] {
  return left > 0
    ? [`- ${counted(left, `more ${noun}`, `more ${noun}s`)} in ${where}.`]
    : []
}

/** A raw string cut to `max` characters with `…`; escaped by the caller afterwards. */
export function shorten(value: string, max: number): string {
  const chars = [...value]
  return chars.length > max
    ? `${chars.slice(0, max - 1).join('')}…`
    : value
}

/**
 * Collapses runs of the same rendered step (`` `postCollect` ×5 ``) and keeps the first
 * {@link MAX_FLOW_STEPS} entries, adding how many steps were left out.
 */
export function stepList(steps: readonly string[]): string {
  const runs: Array<{ step: string, count: number }> = []
  for (const step of steps) {
    const last = runs.at(-1)
    if (last?.step === step)
      last.count += 1
    else
      runs.push({ step, count: 1 })
  }
  const shown = runs.slice(0, MAX_FLOW_STEPS)
  const hidden = runs.slice(MAX_FLOW_STEPS).reduce((sum, run) => sum + run.count, 0)
  const list = shown.map(run => run.count > 1
    ? `${run.step} ×${run.count}`
    : run.step).join(' → ')
  return hidden > 0
    ? `${list} → … (${counted(hidden, 'more step')})`
    : list
}
