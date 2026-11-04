/**
 * Connection settings for the CLI's own requests (`probe`, `check`, the MCP servers' live calls).
 */
import net from 'node:net'
import process from 'node:process'

/**
 * How long each address may take to connect before Node tries the next. Node's default (250 ms)
 * is shorter than an IPv4 connect across continents (about 370 ms measured from India to Hacker
 * News); on a network without working IPv6, every attempt then times out and `fetch` fails while
 * `curl` and the browser succeed. A slower attempt costs nothing when the first address works.
 */
const CONNECT_ATTEMPT_TIMEOUT_MS = 1000

/** Gives each connection attempt {@link CONNECT_ATTEMPT_TIMEOUT_MS}, unless Node was told otherwise. */
export function allowSlowConnects(execArgv: readonly string[] = process.execArgv): void {
  if (execArgv.some(arg => arg.startsWith('--network-family-autoselection-attempt-timeout')))
    return
  if (net.getDefaultAutoSelectFamilyAttemptTimeout() < CONNECT_ATTEMPT_TIMEOUT_MS)
    net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS)
}
