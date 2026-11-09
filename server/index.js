import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config, modes } from './config.js'
import { api, errorHandler } from './routes.js'
import { mockPaypalRouter } from './mockPaypalPage.js'

const app = express()
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')

app.disable('x-powered-by')
app.use(express.json({ limit: '50kb' }))
app.use(express.urlencoded({ extended: false, limit: '10kb' }))

// Public demo guard: cap agent turns per IP and per day so the hosted demo
// cannot burn through model credits.
const CHAT_PER_IP_HOUR = Number(process.env.CHAT_PER_IP_HOUR || 40)
const CHAT_PER_DAY = Number(process.env.CHAT_PER_DAY || 1500)
const chatHits = new Map()
let dayKey = ''
let dayCount = 0
app.set('trust proxy', 'loopback')
app.post('/api/chat', (req, res, next) => {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  if (today !== dayKey) { dayKey = today; dayCount = 0; chatHits.clear() }
  const recent = (chatHits.get(req.ip) || []).filter((t) => now - t < 3600_000)
  if (recent.length >= CHAT_PER_IP_HOUR || dayCount >= CHAT_PER_DAY) {
    return res.status(429).json({ success: false, message: 'Demo limit reached. Please try again later.' })
  }
  chatHits.set(req.ip, [...recent, now])
  dayCount += 1
  next()
})

app.use('/api', api)
app.use('/mock-paypal', mockPaypalRouter)

if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.use(errorHandler)

app.listen(config.port, () => {
  console.log(`CartPilot on ${config.publicUrl}`)
  console.log(`Modes: Claude=${modes.llm} PayPal=${modes.paypal} Channel3=${modes.channel3}`)
})
