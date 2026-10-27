// Session envelope from the API
export interface SessionNode {
  schema_version: number
  node_id: string
  type: 'message' | 'question_text' | 'question_options' | 'question_capture' | 'end'
  messages: { text: string }[]
  input: QuestionInput | null
  is_final: boolean
  error?: { code: string; message: string }
}

export interface QuestionInput {
  // question_text
  inbound_type?: string
  validation?: {
    min_length?: number; max_length?: number; pattern?: string
    min_value?: number; max_value?: number; format?: string
    max_retries?: number; error_message?: string
  }
  // question_options
  options?: { id: string; label: string; description: string | null }[]
  // question_capture
  capture_type?: string
  consent_text?: string | null
  instructions?: string | null
  max_attempts?: number | null
  max_file_size_mb?: number
  accepted_types?: string[]
}

export interface SessionEnvelope {
  schema_version: number
  session_id: string
  session_status: 'active' | 'ended'
  language: string
  expires_at: string
  nodes: SessionNode[]
  is_final: boolean
}

export interface ApiError {
  error_code: string
  message: string
  request_id?: string
}

// Admin types
export interface ApiKey {
  key_id: string
  key_prefix: string
  name: string
  status: 'active' | 'rotating' | 'revoked'
  guided_ids: string[]
  created_at: string
  last_used_at: string | null
  rotating_key_expires_at: string | null
}

export interface ApiChannel {
  _id: string
  flow_id: string
  web_id: string
  keys: ApiKey[]
  rate_limit_rpm: number
  session_ttl_seconds: number
  created_at: string
  updated_at: string
}

// Inspector log
export interface RequestLog {
  id: string
  timestamp: string
  method: string
  path: string
  status: number | null
  durationMs: number | null
  idempotencyKey?: string
  requestBody?: unknown
  responseBody?: unknown
  error?: string
}
