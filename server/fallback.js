import { modes } from './config.js'

// Outage fallback: when an outside service is unreachable or its key stops working
// (expired, revoked, out of credit), switch that integration to the built-in mock data
// so the public demo keeps working. Business errors (for example a refund that is too
// large) are not outages and are passed through unchanged.
const OUTAGE = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|request timed out|invalid_client|Client Authentication failed|authentication|unauthori[sz]ed|invalid x-api-key|api key|credit balance|Channel3 (401|403|429|5\d\d)|overloaded/i

export function isOutage(err) {
  if (!err) return false
  const status = err.status || err.statusCode
  if ([401, 403, 429, 500, 502, 503, 504, 529].includes(status)) return true
  if (['APIConnectionError', 'APIConnectionTimeoutError', 'AuthenticationError', 'PermissionDeniedError', 'InternalServerError', 'RateLimitError'].includes(err.constructor?.name)) return true
  return OUTAGE.test(String(err.message || err))
}

export const fallbackLog = []

export function degrade(service, err) {
  if (modes[service] === 'mock') return
  modes[service] = 'mock'
  const entry = { service, at: new Date().toISOString(), reason: String(err?.message || err).slice(0, 200) }
  fallbackLog.push(entry)
  console.error(`[fallback] ${service} switched to mock data: ${entry.reason}`)
}
