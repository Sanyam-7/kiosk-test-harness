import { ADMIN_API_BASE, CONV_API_BASE, CONV_API_PATH } from './config'
import type { SessionEnvelope, ApiChannel, RequestLog } from './types'

type LogCallback = (log: RequestLog) => void
let _logCallback: LogCallback = () => {}
export function setLogCallback(cb: LogCallback) { _logCallback = cb }

async function request<T>(
  method: string,
  url: string,
  options: {
    auth?: { type: 'apikey'; key: string } | { type: 'bearer'; token: string }
    accountId?: string
    body?: unknown
    formData?: FormData
    idempotencyKey?: string
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.auth?.type === 'apikey') headers['apiKey'] = options.auth.key
  if (options.auth?.type === 'bearer') headers['Authorization'] = `Bearer ${options.auth.token}`
  if (options.accountId) headers['X-Account-Id'] = options.accountId
  if (options.idempotencyKey) headers['X-Idempotency-Key'] = options.idempotencyKey
  if (options.body) headers['Content-Type'] = 'application/json'

  const id = crypto.randomUUID()
  const start = Date.now()
  const maskedAuth = headers['apiKey']
    ? 'apiKey ****'
    : headers['Authorization']
      ? headers['Authorization'].replace(/Bearer .+/, 'Bearer ****')
      : undefined

  let status: number | null = null
  let responseBody: unknown = null
  let error: string | undefined

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: options.formData ?? (options.body ? JSON.stringify(options.body) : undefined),
    })
    status = res.status
    try { responseBody = await res.clone().json() } catch {}

    if (!res.ok) {
      const err = (responseBody as Record<string, unknown>) || {}
      throw Object.assign(new Error(String(err.message || res.statusText)), {
        status,
        error_code: err.error_code,
        response: responseBody,
      })
    }
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    _logCallback({
      id,
      timestamp: new Date().toISOString(),
      method,
      path: url,
      status,
      durationMs: Date.now() - start,
      idempotencyKey: options.idempotencyKey,
      requestBody: options.body,
      responseBody,
      error,
      ...(maskedAuth ? { maskedAuth } : {}),
    } as RequestLog & { maskedAuth?: string })
  }
}

// ── Conversation API (direct to conversation-flow-python, ApiKey auth) ───────

export function startFlow(flowId: string, apiKey: string, opts: {
  language?: string; end_user_id?: string; context_variables?: Record<string, string>
} = {}) {
  return request<SessionEnvelope>('POST', `${CONV_API_BASE}${CONV_API_PATH}/flow/${flowId}/start`, {
    auth: { type: 'apikey', key: apiKey },
    body: { language: opts.language || 'en', ...opts },
  })
}

export function sendMessage(sessionId: string, apiKey: string, input: {
  type: 'text' | 'option' | 'event'; value?: string; option_id?: string; event?: string
}, idempotencyKey: string) {
  return request<SessionEnvelope>('POST', `${CONV_API_BASE}${CONV_API_PATH}/flow-session/${sessionId}/messages`, {
    auth: { type: 'apikey', key: apiKey },
    idempotencyKey,
    body: { input },
  })
}

export function uploadFile(sessionId: string, apiKey: string, file: File, idempotencyKey: string) {
  const fd = new FormData()
  fd.append('file', file)
  return request<SessionEnvelope>('POST', `${CONV_API_BASE}${CONV_API_PATH}/flow-session/${sessionId}/messages`, {
    auth: { type: 'apikey', key: apiKey },
    idempotencyKey,
    formData: fd,
  })
}

export function getSession(sessionId: string, apiKey: string) {
  return request<SessionEnvelope>('GET', `${CONV_API_BASE}${CONV_API_PATH}/flow-session/${sessionId}`, {
    auth: { type: 'apikey', key: apiKey },
  })
}

export function deleteSession(sessionId: string, apiKey: string) {
  return request<void>('DELETE', `${CONV_API_BASE}${CONV_API_PATH}/flow-session/${sessionId}`, {
    auth: { type: 'apikey', key: apiKey },
  })
}

// ── Admin API (direct to conversation-flow-python, X-Account-Id only) ────────

export function listChannels(webId: string, flowId?: string) {
  const q = flowId ? `?flow_id=${flowId}` : ''
  return request<{ channels: ApiChannel[] }>('GET', `${ADMIN_API_BASE}/v2/guided-conv/admin/api-channels${q}`, {
    accountId: webId,
  })
}

export function createChannel(webId: string, flowId: string) {
  return request<ApiChannel>('POST', `${ADMIN_API_BASE}/v2/guided-conv/admin/api-channels`, {
    accountId: webId,
    body: { flow_id: flowId },
  })
}

