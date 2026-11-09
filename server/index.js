import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { config, modes } from './config.js'
import { api, errorHandler } from './routes.js'
import { mockPaypalRouter } from './mockPaypalPage.js'
import { enforceLiveWindow } from './fallback.js'
import { chatLimiter } from './demoLimits.js'

const app = express()
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')

app.disable('x-powered-by')
app.use(express.json({ limit: '50kb' }))
app.use(express.urlencoded({ extended: false, limit: '10kb' }))

app.set('trust proxy', 'loopback')
app.post('/api/chat', chatLimiter)
app.use('/api', (req, res, next) => { enforceLiveWindow(); next() })
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
