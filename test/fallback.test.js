import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modes } from '../server/config.js'
import { isOutage, enforceLiveWindow, LIVE_UNTIL } from '../server/fallback.js'

test('outages are detected, business errors are not', () => {
  assert.equal(isOutage({ status: 401, message: 'invalid x-api-key' }), true)
  assert.equal(isOutage(new Error('fetch failed')), true)
  assert.equal(isOutage(new Error('Channel3 403: Forbidden')), true)
  assert.equal(isOutage(new Error('PayPal create_order: Failed to fetch access token: Client Authentication failed')), true)
  assert.equal(isOutage(new Error('PayPal create_refund: REFUND_AMOUNT_EXCEEDED')), false)
  assert.equal(isOutage(new Error('Refund must be between $0.01 and $500')), false)
})

test('paid APIs stop after the hackathon results (2026-12-21 KST)', () => {
  const saved = { ...modes }
  modes.llm = 'live'
  modes.channel3 = 'live'
  enforceLiveWindow(LIVE_UNTIL - 60_000)
  assert.equal(modes.llm, 'live')
  enforceLiveWindow(LIVE_UNTIL + 1)
  assert.equal(modes.llm, 'mock')
  assert.equal(modes.channel3, 'mock')
  Object.assign(modes, saved)
})

test('over the demo limit the request is marked for the built-in agent instead of being blocked', async () => {
  const { chatLimiter } = await import('../server/demoLimits.js')
  let limited = false
  for (let i = 0; i < 45; i += 1) {
    const req = { ip: '203.0.113.9' }
    let passed = false
    chatLimiter(req, { status: () => ({ json: () => {} }) }, () => { passed = true })
    assert.equal(passed, true)
    if (req.demoLimited) limited = true
  }
  assert.equal(limited, true)
})
