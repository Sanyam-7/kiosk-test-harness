import type { SessionEnvelope, ApiChannel, ApiKey, RequestLog } from './types'

type LogCallback = (log: RequestLog) => void
let _logCallback: LogCallback = () => {}
export function setLogCallback(cb: LogCallback) { _logCallback = cb }

async function request<T>(
  method: string,
  path: string,
  options: {
    auth?: { type: 'apikey'; key: string } | { type: 'bearer'; token: string }
    accountId?: string
    body?: unknown
    formData?: FormData
    idempotencyKey?: string
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.auth?.type === 'apikey') headers['Authorization'] = `ApiKey ${options.auth.key}`
  if (options.auth?.type === 'bearer') headers['Authorization'] = `Bearer ${options.auth.token}`
  if (options.accountId) headers['X-Account-Id'] = options.accountId
  if (options.idempotencyKey) headers['X-Idempotency-Key'] = options.idempotencyKey
  if (options.body) headers['Content-Type'] = 'application/json'

  const id = crypto.randomUUID()
  const start = Date.now()
  const maskedAuth = headers['Authorization']
    ? headers['Authorization'].replace(/(ApiKey|Bearer) .+/, '$1 ****')
    : undefined

  let status: number | null = null
  let responseBody: unknown = null
  let error: string | undefined

  try {
    const res = await fetch(path, {
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
      path,
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

// ── Conversation API ────────────────────────────────────────────────────────

export function startFlow(flowId: string, apiKey: string, opts: {
  language?: string; end_user_id?: string; context_variables?: Record<string, string>
} = {}) {
  return request<SessionEnvelope>('POST', `/api/v1/flow/${flowId}/start`, {
    auth: { type: 'apikey', key: apiKey },
    body: { language: opts.language || 'en', ...opts },
  })
}

export function getSessionToken(sessionId: string, apiKey: string) {
  return request<{ session_token: string; expires_at: string }>(
    'POST', `/api/v1/flow-session/${sessionId}/session-token`,
    { auth: { type: 'apikey', key: apiKey } }
  )
}

export function sendMessage(sessionId: string, token: string, input: {
  type: 'text' | 'option' | 'event'; value?: string; option_id?: string; event?: string
}, idempotencyKey: string) {
  return request<SessionEnvelope>('POST', `/api/v1/flow-session/${sessionId}/messages`, {
    auth: { type: 'bearer', token },
    idempotencyKey,
    body: { input },
  })
}

export function uploadFile(sessionId: string, token: string, file: File, idempotencyKey: string) {
  const fd = new FormData()
  fd.append('file', file)
  return request<SessionEnvelope>('POST', `/api/v1/flow-session/${sessionId}/messages`, {
    auth: { type: 'bearer', token },
    idempotencyKey,
    formData: fd,
  })
}

export function getSession(sessionId: string, token: string) {
  return request<SessionEnvelope>('GET', `/api/v1/flow-session/${sessionId}`, {
    auth: { type: 'bearer', token },
  })
}

export function deleteSession(sessionId: string, token: string) {
  return request<void>('DELETE', `/api/v1/flow-session/${sessionId}`, {
    auth: { type: 'bearer', token },
  })
}

// ── Admin API ───────────────────────────────────────────────────────────────

export function listChannels(webId: string, flowId?: string) {
  const q = flowId ? `?flow_id=${flowId}` : ''
  return request<{ channels: ApiChannel[] }>('GET', `/v1/admin/api-channels${q}`, {
    accountId: webId,
  })
}

export function createChannel(webId: string, flowId: string) {
  return request<ApiChannel>('POST', '/v1/admin/api-channels', {
    accountId: webId,
    body: { flow_id: flowId },
  })
}

export function listKeys(webId: string, channelId: string) {
  return request<{ keys: ApiKey[] }>('GET', `/v1/admin/api-channels/${channelId}/keys`, {
    accountId: webId,
  })
}

export function generateKey(webId: string, channelId: string, name: string, guidedIds: string[]) {
  return request<{ key_id: string; key_prefix: string; name: string; status: string; raw_key: string; created_at: string }>(
    'POST', `/v1/admin/api-channels/${channelId}/keys`,
    { accountId: webId, body: { name, guided_ids: guidedIds } }
  )
}

export function rotateKey(webId: string, channelId: string, keyId: string) {
  return request<{ key_id: string; raw_key: string; old_key_expires_at: string }>(
    'POST', `/v1/admin/api-channels/${channelId}/keys/${keyId}/rotate`,
    { accountId: webId }
  )
}

export function revokeKey(webId: string, channelId: string, keyId: string) {
  return request<void>('DELETE', `/v1/admin/api-channels/${channelId}/keys/${keyId}/revoke`, {
    accountId: webId,
  })
}
