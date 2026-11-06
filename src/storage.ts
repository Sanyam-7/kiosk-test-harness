const SESSION_KEY = 'api_harness_session'
const API_KEY_KEY = 'api_harness_apikey'
const FLOW_ID_KEY = 'api_harness_flowid'

export interface StoredSession {
  session_id: string
  api_key: string
  flow_id: string
  expires_at: string
}

export const storage = {
  getSession: (): StoredSession | null => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { return null }
  },
  setSession: (s: StoredSession) => localStorage.setItem(SESSION_KEY, JSON.stringify(s)),
  clearSession: () => localStorage.removeItem(SESSION_KEY),

  getApiKey: () => localStorage.getItem(API_KEY_KEY) || '',
  setApiKey: (k: string) => localStorage.setItem(API_KEY_KEY, k),

  getFlowId: () => localStorage.getItem(FLOW_ID_KEY) || '',
  setFlowId: (f: string) => localStorage.setItem(FLOW_ID_KEY, f),
}
