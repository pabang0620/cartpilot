import { z } from 'zod'
import { config } from '../config.js'
import { claudeTools, runTool } from './tools.js'
import { SYSTEM_PROMPT } from './claudeAgent.js'

// Local development only: runs the same tools and system prompt through the Claude Agent SDK,
// which uses the developer's Claude Code login instead of an API key. Enabled with LLM_BACKEND=account.
const SERVER_NAME = 'cartpilot'
const MAX_TURNS = 12

let sdk = null

async function loadSdk() {
  if (!sdk) sdk = await import('@anthropic-ai/claude-agent-sdk')
  return sdk
}

function withoutApiKey() {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...env } = process.env
  return env
}

function buildServer({ tool, createSdkMcpServer }, session, events) {
  const tools = claudeTools().map((def) =>
    tool(def.name, def.description, z.fromJSONSchema(def.input_schema).shape, async (input) => {
      const outcome = await runTool(session, def.name, input)
      events.push({ tool: def.name, source: outcome.source, ok: outcome.ok, input })
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.result).slice(0, 12000) }],
        isError: !outcome.ok,
      }
    }),
  )
  return createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', tools })
}

export async function runAccountAgent(session, userText) {
  const agentSdk = await loadSdk()
  const events = []
  let reply = ''
  let sessionId = session.accountSessionId

  const stream = agentSdk.query({
    prompt: userText,
    options: {
      model: config.anthropicModel,
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      allowedTools: [`mcp__${SERVER_NAME}__*`],
      mcpServers: { [SERVER_NAME]: buildServer(agentSdk, session, events) },
      maxTurns: MAX_TURNS,
      effort: 'medium',
      settingSources: [],
      // Without this the Claude Code process would pick up ANTHROPIC_API_KEY from .env and bill the API.
      env: withoutApiKey(),
      ...(sessionId ? { resume: sessionId } : {}),
    },
  })

  for await (const message of stream) {
    if (message.session_id) sessionId = message.session_id
    if (message.type === 'result') {
      if (message.subtype === 'success') reply = message.result
      else if (message.subtype === 'error_max_turns') reply = 'I stopped after several steps. Tell me what to focus on and I will continue.'
      else throw new Error(`Account agent failed: ${message.subtype}`)
    }
  }

  session.accountSessionId = sessionId
  return { reply: reply?.trim() || 'Done.', events }
}
