import { useState, useEffect, useRef, useCallback } from 'react'
import * as api from '../../api'
import { storage } from '../../storage'
import type { SessionNode, RequestLog } from '../../types'
import NodeRenderer, { type AnswerPayload } from './NodeRenderer'
import './Kiosk.css'

type Screen = 'welcome' | 'loading' | 'flow' | 'ended' | 'error'

const IDLE_TIMEOUT_MS = 60_000
const COUNTDOWN_START = 10


export default function KioskScreen({ logs }: { logs: RequestLog[] }) {
  const [screen, setScreen] = useState<Screen>('welcome')
  const [nodes, setNodes] = useState<SessionNode[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  const [countdown, setCountdown] = useState<number | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // idempotency key — one UUID per user action, reused on 409 retry
  const idempotencyKey = useRef<string>('')
  const retryCount = useRef(0)
  const pendingAnswer = useRef<AnswerPayload | null>(null)

  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const countdownInterval = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const endResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const countdownRef = useRef(0)

  // ── idle timer ───────────────────────────────────────────────────────────
  const clearCountdown = useCallback(() => {
    clearInterval(countdownInterval.current)
    setCountdown(null)
  }, [])

  const resetToWelcome = useCallback(async () => {
    clearCountdown()
    clearTimeout(idleTimer.current)
    const sess = storage.getSession()
    if (sess) {
      try { await api.deleteSession(sess.session_id, sess.session_token) } catch { /* best-effort */ }
      storage.clearSession()
    }
    setNodes([])
    setScreen('welcome')
  }, [clearCountdown])

  const startCountdown = useCallback(() => {
    countdownRef.current = COUNTDOWN_START
    setCountdown(COUNTDOWN_START)
    countdownInterval.current = setInterval(() => {
      countdownRef.current -= 1
      setCountdown(countdownRef.current)
      if (countdownRef.current <= 0) {
        clearInterval(countdownInterval.current)
        resetToWelcome()
      }
    }, 1_000)
  }, [resetToWelcome])

  const resetIdleTimer = useCallback(() => {
    clearTimeout(idleTimer.current)
    clearCountdown()
    idleTimer.current = setTimeout(startCountdown, IDLE_TIMEOUT_MS - COUNTDOWN_START * 1_000)
  }, [clearCountdown, startCountdown])

  // Attach global activity listeners when in 'flow'
  useEffect(() => {
    if (screen !== 'flow') {
      clearTimeout(idleTimer.current)
      clearCountdown()
      return
    }
    const events = ['pointerdown', 'keydown', 'touchstart']
    const handler = () => resetIdleTimer()
    events.forEach(e => window.addEventListener(e, handler, { passive: true }))
    resetIdleTimer()
    return () => {
      events.forEach(e => window.removeEventListener(e, handler))
      clearTimeout(idleTimer.current)
      clearCountdown()
    }
  }, [screen, resetIdleTimer, clearCountdown])

  // ── on mount: check for existing session ─────────────────────────────────
  useEffect(() => {
    const sess = storage.getSession()
    if (!sess) return

    ;(async () => {
      setScreen('loading')
      try {
        const envelope = await api.getSession(sess.session_id, sess.session_token)
        setNodes(envelope.nodes)
        setScreen('flow')
      } catch (err: unknown) {
        storage.clearSession()
        const code = (err as { error_code?: string }).error_code
        if (code !== 'session_expired') {
          // non-expiry errors: still fall back to welcome silently
        }
        setScreen('welcome')
      }
    })()
  }, [])

  // ── start flow ───────────────────────────────────────────────────────────
  const startFlow = useCallback(async () => {
    const apiKey = storage.getApiKey()
    const flowId = storage.getFlowId()
    if (!apiKey || !flowId) {
      setErrorMsg('Missing API key or flow ID. Configure them in settings.')
      setScreen('error')
      return
    }

    setScreen('loading')
    try {
      const envelope = await api.startFlow(flowId, apiKey)
      // get a session token for subsequent calls
      const tokenEnvelope = await api.getSessionToken(envelope.session_id, apiKey)
      storage.setSession({
        session_id: envelope.session_id,
        session_token: tokenEnvelope.session_token,
        flow_id: flowId,
        expires_at: envelope.expires_at,
      })
      setNodes(envelope.nodes)
      if (envelope.is_final) {
        triggerEnded()
      } else {
        setScreen('flow')
      }
    } catch (err: unknown) {
      setErrorMsg(extractMessage(err))
      setScreen('error')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── ended state ──────────────────────────────────────────────────────────
  const triggerEnded = useCallback(() => {
    setScreen('ended')
    let n = COUNTDOWN_START
    setCountdown(n)
    endResetTimer.current = setInterval(() => {
      n -= 1
      setCountdown(n)
      if (n <= 0) {
        clearInterval(endResetTimer.current)
        storage.clearSession()
        setNodes([])
        setCountdown(null)
        setScreen('welcome')
      }
    }, 1_000)
  }, [])

  useEffect(() => () => clearInterval(endResetTimer.current), [])

  // ── send answer ──────────────────────────────────────────────────────────
  const sendAnswer = useCallback(async (answer: AnswerPayload, key: string, retry = 0) => {
    const sess = storage.getSession()
    if (!sess) { setScreen('welcome'); return }

    setSubmitting(true)
    try {
      let envelope
      if (answer.type === 'file') {
        envelope = await api.uploadFile(sess.session_id, sess.session_token, answer.file, key)
      } else {
        const input =
          answer.type === 'option'
            ? { type: 'option' as const, option_id: answer.option_id }
            : { type: 'text' as const, value: answer.value }
        envelope = await api.sendMessage(sess.session_id, sess.session_token, input, key)
      }

      setNodes(envelope.nodes)
      if (envelope.is_final) {
        triggerEnded()
      }
    } catch (err: unknown) {
      const code = (err as { error_code?: string }).error_code
      const status = (err as { status?: number }).status

      if ((status === 409 || code === 'duplicate_request') && retry < 2) {
        // same key, retry after 500ms
        setTimeout(() => sendAnswer(answer, key, retry + 1), 500)
        return
      }

      if (code === 'invalid_option_id') {
        // 422 invalid option — shouldn't happen; prompt restart
        setErrorMsg("This shouldn't happen — please restart.")
        setScreen('error')
        return
      }

      if (code === 'session_expired' || status === 404) {
        storage.clearSession()
        setScreen('welcome')
        return
      }

      setErrorMsg(extractMessage(err))
      setScreen('error')
    } finally {
      setSubmitting(false)
    }
  }, [triggerEnded])

  const onAnswer = useCallback((answer: AnswerPayload) => {
    // New user action → new idempotency key
    idempotencyKey.current = crypto.randomUUID()
    retryCount.current = 0
    pendingAnswer.current = answer
    sendAnswer(answer, idempotencyKey.current)
  }, [sendAnswer])

  // ── inspector log helpers ─────────────────────────────────────────────────
  const statusClass = (status: number | null) => {
    if (!status) return 'status-pending'
    if (status >= 500) return 'status-5xx'
    if (status >= 400) return 'status-4xx'
    if (status >= 200) return 'status-2xx'
    return ''
  }

  const truncate = (v: unknown) => {
    if (v === undefined) return ''
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s.length > 300 ? s.slice(0, 300) + '…' : s
  }

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="kiosk-screen" role="main">
      {/* Inspector toggle */}
      <button
        className="inspector-toggle"
        onClick={() => setInspectorOpen(o => !o)}
        aria-label={inspectorOpen ? 'Close inspector' : 'Open inspector'}
        aria-expanded={inspectorOpen}
      >
        {inspectorOpen ? '✕ Logs' : '☰ Logs'}
      </button>

      {/* Main content area */}
      <div className="kiosk-content">
        {screen === 'welcome' && (
          <div className="welcome-screen">
            <h1>Welcome</h1>
            <p className="welcome-subtitle">Touch the button below to begin</p>
            <button className="start-btn" onClick={startFlow}>
              Start Check-in
            </button>
          </div>
        )}

        {screen === 'loading' && (
          <div className="loading-screen">
            <div className="spinner" role="status" aria-label="Loading" />
            <p>Loading…</p>
          </div>
        )}

        {screen === 'flow' && (
          <div className="flow-screen">
            <NodeRenderer
              nodes={nodes}
              onAnswer={onAnswer}
              disabled={submitting}
            />
          </div>
        )}

        {screen === 'ended' && (
          <div className="end-screen">
            <div className="checkmark" aria-hidden="true">&#10003;</div>
            <h2>Thank you!</h2>
            <p>Your check-in is complete.</p>
            {countdown !== null && (
              <p className="end-countdown">Returning to start in {countdown}s…</p>
            )}
          </div>
        )}

        {screen === 'error' && (
          <div className="error-screen">
            <p className="error-message">{errorMsg}</p>
            <div className="error-actions">
              <button className="btn-primary" onClick={startFlow}>
                Try Again
              </button>
              <button className="btn-secondary" onClick={resetToWelcome}>
                Start Over
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Idle warning banner */}
      {countdown !== null && screen === 'flow' && (
        <div className="idle-warning" role="alert">
          Are you still there? Resetting in {countdown}s
          <button onClick={resetIdleTimer} className="idle-cancel">
            I&apos;m here
          </button>
        </div>
      )}

      {/* Inspector drawer */}
      {inspectorOpen && (
        <aside className="inspector-drawer" aria-label="Request logs">
          <h2 className="inspector-title">Request Log</h2>
          {logs.length === 0 && <p className="inspector-empty">No requests yet.</p>}
          {[...logs].reverse().map(log => (
            <div key={log.id} className="log-entry">
              <div className="log-header">
                <span className={`log-status ${statusClass(log.status)}`}>
                  {log.status ?? '…'}
                </span>
                <span className="log-method">{log.method}</span>
                <span className="log-path">{log.path}</span>
                {log.durationMs !== null && (
                  <span className="log-duration">{log.durationMs}ms</span>
                )}
              </div>
              {log.requestBody !== undefined && (
                <pre className="log-body">REQ: {truncate(log.requestBody) as string}</pre>
              )}
              {log.responseBody !== undefined && (
                <pre className="log-body">RES: {truncate(log.responseBody) as string}</pre>
              )}
              {log.error && (
                <pre className="log-body log-error-text">ERR: {log.error}</pre>
              )}
            </div>
          ))}
        </aside>
      )}
    </div>
  )
}

function extractMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    if (typeof e.message === 'string') return e.message
    if (e.response && typeof e.response === 'object') {
      const r = e.response as Record<string, unknown>
      if (r.data && typeof r.data === 'object') {
        const d = r.data as Record<string, unknown>
        if (typeof d.message === 'string') return d.message
      }
    }
  }
  return 'An unexpected error occurred. Please try again.'
}
