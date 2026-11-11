import { z } from 'zod'
import { config } from './config.js'
import { getSession } from './store.js'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export const sessionIdSchema = z.string().uuid()

export function parse(schema, data) {
  const result = schema.safeParse(data)
  if (!result.success) throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  return result.data
}

export function requireSession(id) {
  const session = getSession(id)
  if (!session) throw new HttpError(404, 'Session not found. Reload the page.')
  return session
}

export function redirectToApp(res, params) {
  const query = new URLSearchParams(params).toString()
  res.redirect(`${config.appUrl}/?${query}`)
}
