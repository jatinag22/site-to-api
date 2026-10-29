/**
 * Names that carry values: some sites put an id in a cookie name itself
 * (`https://www.shop.com_<uuid>$$<account>$$session_state`). The model keeps raw names, so cookies
 * still match `Set-Cookie` headers, traces and probe results; every emitter writes them through
 * {@link withRedactedNames} instead, so the specs, flows.json, AGENT.md, API_MAP.md and the client
 * README agree on one redacted spelling.
 */
import type { Analysis } from '../../model'
import type { ProbeReport } from '../../model/probe'

/** Redacts the name in a probe `requires` item: `cookie:<name>`, `header:<name>`. */
export function redactRequirement(item: string, redactName: (name: string) => string): string {
  const colon = item.indexOf(':')
  return colon === -1
    ? redactName(item)
    : `${item.slice(0, colon + 1)}${redactName(item.slice(colon + 1))}`
}

/**
 * A copy of the analysis for emitters, with redacted names: cookie, header and query parameter
 * names of operations, WebSocket channel cookie and query names, session cookie names, and the
 * names in `requires` items.
 */
export function withRedactedNames(analysis: Analysis, redactName: (name: string) => string): Analysis {
  const named = <T extends { name: string }>(items: readonly T[]): T[] => items.map(item => ({
    ...item,
    name: redactName(item.name),
  }))
  return {
    ...analysis,
    operations: analysis.operations.map(operation => ({
      ...operation,
      query: named(operation.query),
      headers: named(operation.headers),
      cookies: named(operation.cookies),
      ...(operation.requires === undefined || operation.requires === null
        ? {}
        : {
            requires: operation.requires.map(item => redactRequirement(item, redactName)),
          }),
    })),
    ...(analysis.channels === undefined
      ? {}
      : {
          channels: analysis.channels.map(channel => ({
            ...channel,
            query: named(channel.query),
            cookies: {
              ...channel.cookies,
              names: channel.cookies.names.map(redactName),
            },
          })),
        }),
    flows: {
      ...analysis.flows,
      session: analysis.flows.session.map(entry => ({
        ...entry,
        cookies: named(entry.cookies),
      })),
    },
  }
}

/** `probe.json` with its `requires` items redacted, as the handoff folder keeps it. */
export function probeReportWithRedactedNames(report: ProbeReport, redactName: (name: string) => string): ProbeReport {
  return {
    ...report,
    operations: report.operations.map(probe => ({
      ...probe,
      requires: probe.requires === null
        ? null
        : probe.requires.map(item => redactRequirement(item, redactName)),
    })),
  }
}
