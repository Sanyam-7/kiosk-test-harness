import { useState, useEffect, useRef, useCallback } from 'react'
import * as api from '../../api'
import { storage } from '../../storage'
import type { SessionNode, RequestLog } from '../../types'
import NodeRenderer, { type AnswerPayload } from './NodeRenderer'
import './Kiosk.css'

type Screen = 'welcome' | 'loading' | 'flow' | 'ended' | 'error'
type HistoryItem = { role: 'bot' | 'user'; text: string }

const IDLE_TIMEOUT_MS  = 60_000
const COUNTDOWN_START  = 10
const ARC_CIRCUMFERENCE = 2 * Math.PI * 24  // r=24 on 56×56 SVG

function answerText(a: AnswerPayload): string {
  if (a.type === 'text')   return a.value
  if (a.type === 'option') return a.label ?? '✓ Selected'
  return '📷 Photo captured'
}

export default function KioskScreen({ logs }: { logs: RequestLog[] }) {
  const [screen, setScreen]             = useState<Screen>('welcome')
  const [nodes, setNodes]               = useState<SessionNode[]>([])
  const [errorMsg, setErrorMsg]         = useState('')
  const [countdown, setCountdown]       = useState<number | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [submitting, setSubmitting]     = useState(false)

  // typewriter + history
  const [history, setHistory]             = useState<HistoryItem[]>([])
  const [currentBotText, setCurrentBotText] = useState('')
  const [typed, setTyped]                 = useState('')
  const [typewriterDone, setTypewriterDone] = useState(true)
  const [pendingFinal, setPendingFinal]   = useState(false)

  const processedNodeIds = useRef(new Set<string>())
  const historyEndRef    = useRef<HTMLDivElement>(null)
  const idempotencyKey   = useRef('')
  const pendingAnswer    = useRef<AnswerPayload | null>(null)

  const idleTimer           = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const countdownInterval   = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const endResetTimer       = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const countdownRef        = useRef(0)

  // ── Idle timer ───────────────────────────────────────────────────────────
  const clearCountdown = useCallback(() => {
    clearInterval(countdownInterval.current)
    setCountdown(null)
  }, [])

  const resetToWelcome = useCallback(async () => {
    clearCountdown()
    clearTimeout(idleTimer.current)
    const sess = storage.getSession()
    if (sess) {
      try { await api.deleteSession(sess.session_id, sess.api_key) } catch { /* best-effort */ }
      storage.clearSession()
    }
    processedNodeIds.current = new Set()
    setNodes([])
    setHistory([])
    setCurrentBotText('')
    setTyped('')
    setTypewriterDone(true)
    setPendingFinal(false)
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

  // ── Detect new bot messages when nodes change ────────────────────────────
  useEffect(() => {
    const newNodes = nodes.filter(n => !processedNodeIds.current.has(n.node_id))
    if (!newNodes.length) return
    newNodes.forEach(n => processedNodeIds.current.add(n.node_id))
    const botText = newNodes
      .flatMap(n => n.messages.map(m => m.text))
      .filter(Boolean)
      .join(' ')
    if (botText) setCurrentBotText(botText)
    else setTypewriterDone(true)
  }, [nodes])

  // ── Typewriter + TTS ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!currentBotText) return
    setTyped('')
    setTypewriterDone(false)

    window.speechSynthesis?.cancel()
    const utt = new SpeechSynthesisUtterance(currentBotText)
    window.speechSynthesis?.speak(utt)

    let i = 0
    const timer = setInterval(() => {
      i++
      setTyped(currentBotText.slice(0, i))
      if (i >= currentBotText.length) {
        clearInterval(timer)
        setTypewriterDone(true)
      }
    }, 38)

    return () => {
      clearInterval(timer)
      window.speechSynthesis?.cancel()
    }
  }, [currentBotText])

  // ── Scroll history to bottom ─────────────────────────────────────────────
  useEffect(() => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [history])

  // ── Trigger end after typewriter finishes ────────────────────────────────
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
        processedNodeIds.current = new Set()
        setNodes([])
        setHistory([])
        setCurrentBotText('')
        setTyped('')
        setCountdown(null)
        setScreen('welcome')
      }
    }, 1_000)
  }, [])

  useEffect(() => () => clearInterval(endResetTimer.current), [])

  useEffect(() => {
    if (typewriterDone && pendingFinal) {
      setPendingFinal(false)
      triggerEnded()
    }
  }, [typewriterDone, pendingFinal, triggerEnded])

  // ── On mount: restore session ────────────────────────────────────────────
  useEffect(() => {
    const sess = storage.getSession()
    if (!sess) return
    ;(async () => {
      setScreen('loading')
      try {
        const envelope = await api.getSession(sess.session_id, sess.api_key)
        setNodes(envelope.nodes)
        setScreen('flow')
      } catch (err: unknown) {
        storage.clearSession()
        const code = (err as { error_code?: string }).error_code
        if (code !== 'session_expired') { /* fall through */ }
        setScreen('welcome')
      }
    })()
  }, [])

  // ── Start flow ───────────────────────────────────────────────────────────
  const startFlow = useCallback(async () => {
    const apiKey = storage.getApiKey()
    const flowId = storage.getFlowId()
    if (!apiKey || !flowId) {
      setErrorMsg('Missing API key or flow ID. Configure them in the Admin panel.')
      setScreen('error')
      return
    }
    setScreen('loading')
    processedNodeIds.current = new Set()
    setHistory([])
    setCurrentBotText('')
    setTyped('')
    setTypewriterDone(true)
    setPendingFinal(false)
    try {
      const envelope = await api.startFlow(flowId, apiKey)
      storage.setSession({
        session_id: envelope.session_id,
        api_key: apiKey,
        flow_id: flowId,
        expires_at: envelope.expires_at,
      })
      setNodes(envelope.nodes)
      setScreen('flow')
      if (envelope.is_final) setPendingFinal(true)
    } catch (err: unknown) {
      setErrorMsg(extractMessage(err))
      setScreen('error')
    }
  }, [])

  // ── Send answer ──────────────────────────────────────────────────────────
  const sendAnswer = useCallback(async (answer: AnswerPayload, key: string, retry = 0) => {
    const sess = storage.getSession()
    if (!sess) { setScreen('welcome'); return }

    setSubmitting(true)
    try {
      let envelope
      if (answer.type === 'file') {
        envelope = await api.uploadFile(sess.session_id, sess.api_key, answer.file, key)
      } else {
        const input =
          answer.type === 'option'
            ? { type: 'option' as const, option_id: answer.option_id }
            : { type: 'text' as const, value: answer.value }
        envelope = await api.sendMessage(sess.session_id, sess.api_key, input, key)
      }

      setNodes(envelope.nodes)
      if (envelope.is_final) setPendingFinal(true)
    } catch (err: unknown) {
      const code   = (err as { error_code?: string }).error_code
      const status = (err as { status?: number }).status

      if ((status === 409 || code === 'duplicate_request') && retry < 2) {
        setTimeout(() => sendAnswer(answer, key, retry + 1), 500)
        return
      }
      if (code === 'invalid_option_id') {
        setErrorMsg("Invalid option — please restart.")
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
  }, [])

  const onAnswer = useCallback((answer: AnswerPayload) => {
    // push current bot message + user answer to history
    if (currentBotText) {
      setHistory(h => [...h, { role: 'bot', text: currentBotText }])
    }
    setHistory(h => [...h, { role: 'user', text: answerText(answer) }])
    setCurrentBotText('')
    setTyped('')
    setTypewriterDone(false)

    idempotencyKey.current = crypto.randomUUID()
    pendingAnswer.current = answer
    sendAnswer(answer, idempotencyKey.current)
  }, [currentBotText, sendAnswer])

  // ── Active input node ────────────────────────────────────────────────────
  const activeInputNode = nodes
    .slice()
    .reverse()
    .find(n => ['question_text', 'question_options', 'question_capture'].includes(n.type)) ?? null

  const isIdle = countdown !== null && screen === 'flow'

  // ── Inspector helpers ────────────────────────────────────────────────────
  const statusClass = (status: number | null) => {
    if (!status) return 'status-pending'
    if (status >= 500) return 'status-5xx'
    if (status >= 400) return 'status-4xx'
    return 'status-2xx'
  }

  const truncate = (v: unknown) => {
    if (v === undefined) return ''
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s.length > 300 ? s.slice(0, 300) + '…' : s
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className={`kiosk-screen${isIdle ? ' is-idle' : ''}`} role="main">

      {/* progress bar */}
      {(screen === 'loading' || submitting) && <div className="kiosk-progress" />}

      {/* inspector toggle */}
      <button
        className="inspector-toggle"
        onClick={() => setInspectorOpen(o => !o)}
        aria-label={inspectorOpen ? 'Close logs' : 'Open logs'}
      >
        {inspectorOpen ? '✕ Logs' : '☰ Logs'}
      </button>

      {/* ── screens ── */}

      {screen === 'welcome' && (
        <div className="kiosk-welcome">
          <div className="welcome-card">
            <h1 className="welcome-headline">Hello.<br />Let's begin.</h1>
            <p className="welcome-sub">Touch the button below to start your check-in.</p>
            <button className="kiosk-begin-btn" onClick={startFlow}>
              Begin
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {screen === 'loading' && (
        <div className="kiosk-loading">
          <div className="kiosk-dots">
            <span /><span /><span />
          </div>
        </div>
      )}

      {screen === 'flow' && (
        <div className="kiosk-flow">
          {/* history */}
          {history.length > 0 && (
            <div className="kiosk-history">
              {history.map((item, i) => (
                <div key={i} className={`h-item h-${item.role}`}>{item.text}</div>
              ))}
              <div ref={historyEndRef} />
            </div>
          )}

          {/* typewriter stage */}
          <div className="kiosk-stage">
            {(currentBotText || typed) && (
              <div className="typewriter-wrap">
                <p className="typewriter-text">
                  {typed || currentBotText.slice(0, 1)}
                  {!typewriterDone && <span className="tw-cursor" aria-hidden="true" />}
                </p>
              </div>
            )}
            {submitting && !currentBotText && (
              <div className="kiosk-dots">
                <span /><span /><span />
              </div>
            )}
          </div>

          {/* node input — shown when typewriter done */}
          {typewriterDone && activeInputNode && (
            <NodeRenderer
              node={activeInputNode}
              onAnswer={onAnswer}
              disabled={submitting}
            />
          )}
        </div>
      )}

      {screen === 'ended' && (
        <div className="kiosk-end">
          <svg className="end-check-svg" viewBox="0 0 52 52">
            <circle className="end-check-circle" cx="26" cy="26" r="25" />
            <path className="end-check-path" d="M14 27 L22 35 L38 17" />
          </svg>
          <p className="end-headline">Thank you!</p>
          <p className="end-sub">Your check-in is complete.</p>
          {countdown !== null && (
            <div className="end-arc-wrap" aria-label={`Resetting in ${countdown}s`}>
              <svg className="end-arc-svg" viewBox="0 0 56 56">
                <circle className="end-arc-track" cx="28" cy="28" r="24" />
                <circle
                  className="end-arc-fill"
                  cx="28" cy="28" r="24"
                  strokeDasharray={ARC_CIRCUMFERENCE}
                  strokeDashoffset={ARC_CIRCUMFERENCE * (1 - countdown / COUNTDOWN_START)}
                />
              </svg>
              <span className="end-arc-num">{countdown}</span>
            </div>
          )}
        </div>
      )}

      {screen === 'error' && (
        <div className="kiosk-error">
          <span className="error-icon" aria-hidden="true">⚠</span>
          <p className="error-message">{errorMsg}</p>
          <div className="k-error-actions">
            <button className="k-primary-btn" onClick={startFlow}>Try Again</button>
            <button className="k-ghost-btn"   onClick={resetToWelcome}>Start Over</button>
          </div>
        </div>
      )}

      {/* idle banner */}
      {isIdle && (
        <div className="kiosk-idle-banner" role="alert">
          Still there? Resetting in {countdown}s
          <button className="kiosk-idle-cancel" onClick={resetIdleTimer}>
            I'm here
          </button>
        </div>
      )}

      {/* inspector drawer */}
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
                <span className="log-path" title={log.path}>{log.path}</span>
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
  }
  return 'An unexpected error occurred. Please try again.'
}
