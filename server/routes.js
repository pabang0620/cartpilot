import { Router } from 'express'
import { z } from 'zod'
import { config, modes } from './config.js'
import { createSession, publicState, logActivity, spentAmount } from './store.js'
import { round2 } from './services.js'
import { runClaudeAgent } from './agent/claudeAgent.js'
import { runMockAgent } from './agent/mockAgent.js'
import { runAccountAgent } from './agent/accountAgent.js'
import { isOutage, degrade, fallbackLog } from './fallback.js'
import { HttpError, sessionIdSchema, parse, requireSession } from './http.js'
import { registerPaymentRoutes, MERCHANT_POLICY } from './paymentRoutes.js'

export const api = Router()

api.get('/health', (req, res) => {
  const testBuyer = modes.paypal === 'sandbox' ? config.testBuyer : null
  res.json({ success: true, data: { modes, model: config.anthropicModel, fallbacks: fallbackLog.length, testBuyer, merchantPolicy: MERCHANT_POLICY } })
})

api.post('/session', (req, res) => {
  const session = createSession()
  res.json({ success: true, data: { ...publicState(session), modes } })
})

api.get('/state', (req, res, next) => {
  try {
    const session = requireSession(parse(sessionIdSchema, req.query.sessionId))
    res.json({ success: true, data: publicState(session) })
  } catch (err) {
    next(err)
  }
})

api.put('/budget', (req, res, next) => {
  try {
    const body = parse(z.object({ sessionId: sessionIdSchema, amount: z.number().positive().max(100000) }), req.body)
    const session = requireSession(body.sessionId)
    if (round2(body.amount) <= 0) throw new HttpError(400, 'amount: must be at least $0.01')
    session.budget = round2(body.amount)
    if (session.cart && session.cart.status !== 'paid' && session.cart.total > round2(session.budget - spentAmount(session))) {
      session.cart = { ...session.cart, overBudget: true }
    } else if (session.cart) {
      session.cart = { ...session.cart, overBudget: false }
    }
    logActivity(session, { source: 'human', tool: 'set_budget', origin: 'shopper', ok: true, detail: `$${session.budget}` })
    res.json({ success: true, data: publicState(session) })
  } catch (err) {
    next(err)
  }
})

api.post('/chat', async (req, res, next) => {
  try {
    const body = parse(z.object({ sessionId: sessionIdSchema, message: z.string().trim().min(1).max(2000) }), req.body)
    const session = requireSession(body.sessionId)
    if (session.busy) throw new HttpError(409, 'The agent is still working on the previous message.')
    session.busy = true
    try {
      let result
      let answeredBy = 'claude'
      if (modes.llm === 'live' && !req.demoLimited) {
        const before = session.messages?.length ?? 0
        try {
          result = config.llmBackend === 'account'
            ? await runAccountAgent(session, body.message)
            : await runClaudeAgent(session, body.message)
        } catch (err) {
          if (!isOutage(err)) throw err
          // Claude is unreachable or the key stopped working: answer from the built-in agent instead.
          if (session.messages) session.messages.length = before
          if (/401|403|authentication|api key|credit balance|permission/i.test(`${err.status} ${err.message}`)) degrade('llm', err)
          console.error('[fallback] Claude call failed, using the built-in agent for this message:', err.message)
          result = await runMockAgent(session, body.message)
          answeredBy = 'built-in (Claude unavailable)'
        }
      } else {
        result = await runMockAgent(session, body.message)
        answeredBy = req.demoLimited ? 'built-in (demo limit reached)' : 'built-in'
      }
      const { reply, events } = result
      res.json({ success: true, data: { reply, events, answeredBy, state: publicState(session), modes } })
    } finally {
      session.busy = false
    }
  } catch (err) {
    next(err)
  }
})

registerPaymentRoutes(api)

api.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found.' })
})

export function errorHandler(err, req, res, next) {
  const status = err.status || 500
  if (status >= 500) console.error(err)
  res.status(status).json({ success: false, message: status >= 500 ? `Server error: ${err.message}` : err.message })
}
