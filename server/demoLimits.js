// Public demo guard: caps agent turns per IP per hour and per day so the hosted demo
// cannot burn through model credits. Counters live in memory and reset each UTC day.
const CHAT_PER_IP_HOUR = Number(process.env.CHAT_PER_IP_HOUR || 40)
const CHAT_PER_DAY = Number(process.env.CHAT_PER_DAY || 200)
const HOUR_MS = 3_600_000

const hitsByIp = new Map()
let dayKey = ''
let dayCount = 0

export function chatLimiter(req, res, next) {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  if (today !== dayKey) {
    dayKey = today
    dayCount = 0
    hitsByIp.clear()
  }
  const recent = (hitsByIp.get(req.ip) || []).filter((t) => now - t < HOUR_MS)
  if (recent.length >= CHAT_PER_IP_HOUR || dayCount >= CHAT_PER_DAY) {
    // Keep the demo usable: the rule-based agent answers without calling the paid model.
    req.demoLimited = true
    return next()
  }
  hitsByIp.set(req.ip, [...recent, now])
  dayCount += 1
  next()
}
