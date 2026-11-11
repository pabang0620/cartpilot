import 'dotenv/config'

const forceMock = process.env.FORCE_MOCK === '1'
const port = Number(process.env.PORT || 3001)
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '')

export const config = {
  port,
  publicUrl,
  appUrl: (process.env.APP_URL || publicUrl).replace(/\/$/, ''),
  anthropicKey: forceMock ? '' : process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  // 'account' = local development through the Claude Agent SDK and the developer's Claude Code login.
  llmBackend: !forceMock && process.env.LLM_BACKEND === 'account' ? 'account' : 'api',
  paypalClientId: forceMock ? '' : process.env.PAYPAL_CLIENT_ID || '',
  paypalClientSecret: forceMock ? '' : process.env.PAYPAL_CLIENT_SECRET || '',
  channel3Key: forceMock ? '' : process.env.CHANNEL3_API_KEY || '',
  shippingFlat: Number(process.env.SHIPPING_FLAT_USD || 0),
  // PayPal Sandbox test buyer for judges. Sandbox accounts hold fake money only.
  testBuyer: process.env.SANDBOX_BUYER_EMAIL ? { email: process.env.SANDBOX_BUYER_EMAIL, password: process.env.SANDBOX_BUYER_PASSWORD || '' } : null,
}

export const modes = {
  llm: config.anthropicKey || config.llmBackend === 'account' ? 'live' : 'mock',
  paypal: config.paypalClientId && config.paypalClientSecret ? 'sandbox' : 'mock',
  channel3: config.channel3Key ? 'live' : 'mock',
}
