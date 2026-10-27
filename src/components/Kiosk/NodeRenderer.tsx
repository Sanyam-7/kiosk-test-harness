import { useState, useRef, useCallback, useEffect } from 'react'
import type { SessionNode } from '../../types'

export type AnswerPayload =
  | { type: 'text'; value: string }
  | { type: 'option'; option_id: string }
  | { type: 'file'; file: File }

interface Props {
  nodes: SessionNode[]
  onAnswer: (answer: AnswerPayload) => void
  disabled: boolean
}

// ── message node ────────────────────────────────────────────────────────────
function MessageBubble({ node }: { node: SessionNode }) {
  return (
    <div className="node-bubble">
      {node.messages.map((m, i) => (
        <p key={i}>{m.text}</p>
      ))}
    </div>
  )
}

// ── question_text node ───────────────────────────────────────────────────────
function TextQuestion({
  node,
  onAnswer,
  disabled,
}: {
  node: SessionNode
  onAnswer: (a: AnswerPayload) => void
  disabled: boolean
}) {
  const [value, setValue] = useState('')
  const validation = node.input?.validation

  // client-side hint message (never blocks submit)
  const hint = (() => {
    if (!validation || !value) return ''
    if (validation.min_length && value.length < validation.min_length)
      return `Minimum ${validation.min_length} characters`
    if (validation.max_length && value.length > validation.max_length)
      return `Maximum ${validation.max_length} characters`
    if (validation.pattern && !new RegExp(validation.pattern).test(value))
      return validation.error_message ?? 'Invalid format'
    return ''
  })()

  const inputType =
    node.input?.inbound_type === 'number'
      ? 'number'
      : node.input?.inbound_type === 'email'
      ? 'email'
      : 'text'

  const submit = () => {
    if (value.trim()) onAnswer({ type: 'text', value: value.trim() })
  }

  return (
    <div className="node-bubble question-input-wrap">
      {node.messages.map((m, i) => (
        <p key={i}>{m.text}</p>
      ))}
      {node.error && <p className="node-error">{node.error.message}</p>}
      <div className="question-input">
        <input
          type={inputType}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          disabled={disabled}
          placeholder="Type your answer…"
          aria-label="Answer"
        />
        <button onClick={submit} disabled={disabled || !value.trim()}>
          Send
        </button>
      </div>
      {hint && <p className="input-hint">{hint}</p>}
    </div>
  )
}

// ── question_options node ────────────────────────────────────────────────────
function OptionsQuestion({
  node,
  onAnswer,
  disabled,
}: {
  node: SessionNode
  onAnswer: (a: AnswerPayload) => void
  disabled: boolean
}) {
  const options = node.input?.options ?? []
  return (
    <div className="node-bubble">
      {node.messages.map((m, i) => (
        <p key={i}>{m.text}</p>
      ))}
      {node.error && <p className="node-error">{node.error.message}</p>}
      <div className="option-grid">
        {options.map(opt => (
          <button
            key={opt.id}
            className="option-btn"
            onClick={() => onAnswer({ type: 'option', option_id: opt.id })}
            disabled={disabled}
          >
            <span className="option-label">{opt.label}</span>
            {opt.description && (
              <span className="option-desc">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── question_capture node ────────────────────────────────────────────────────
type CaptureStep = 'consent' | 'capture' | 'preview'

function CaptureQuestion({
  node,
  onAnswer,
  disabled,
}: {
  node: SessionNode
  onAnswer: (a: AnswerPayload) => void
  disabled: boolean
}) {
  const [step, setStep] = useState<CaptureStep>('consent')
  const [cameraFailed, setCameraFailed] = useState(false)
  const [snapshot, setSnapshot] = useState<File | null>(null)
  const [attemptsLeft, setAttemptsLeft] = useState(node.input?.max_attempts ?? null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }, [])

  useEffect(() => () => stopStream(), [stopStream])

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
    } catch {
      setCameraFailed(true)
    }
  }, [])

  const onConsent = useCallback(() => {
    setStep('capture')
    if (!cameraFailed) startCamera()
  }, [cameraFailed, startCamera])

  const takeSnapshot = useCallback(() => {
    if (!videoRef.current) return
    const canvas = document.createElement('canvas')
    canvas.width = videoRef.current.videoWidth
    canvas.height = videoRef.current.videoHeight
    canvas.getContext('2d')!.drawImage(videoRef.current, 0, 0)
    canvas.toBlob(blob => {
      if (!blob) return
      const file = new File([blob], 'capture.jpg', { type: 'image/jpeg' })
      setSnapshot(file)
      stopStream()
      setStep('preview')
    }, 'image/jpeg', 0.9)
  }, [stopStream])

  const retake = useCallback(() => {
    setSnapshot(null)
    if (attemptsLeft !== null) setAttemptsLeft(n => (n !== null ? n - 1 : null))
    setStep('capture')
    if (!cameraFailed) startCamera()
  }, [attemptsLeft, cameraFailed, startCamera])

  const submit = useCallback(() => {
    if (snapshot) onAnswer({ type: 'file', file: snapshot })
  }, [snapshot, onAnswer])

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) { setSnapshot(f); setStep('preview') }
  }, [])

  if (step === 'consent') {
    return (
      <div className="node-bubble">
        {node.messages.map((m, i) => <p key={i}>{m.text}</p>)}
        {node.input?.consent_text && (
          <p className="consent-text">{node.input.consent_text}</p>
        )}
        {node.input?.instructions && (
          <p className="capture-instructions">{node.input.instructions}</p>
        )}
        {node.error && <p className="node-error">{node.error.message}</p>}
        <button className="btn-primary" onClick={onConsent} disabled={disabled}>
          I Agree
        </button>
      </div>
    )
  }

  if (step === 'capture') {
    const accepted = node.input?.accepted_types?.join(',') ?? 'image/*'
    return (
      <div className="node-bubble capture-area">
        {attemptsLeft !== null && (
          <p className="attempts-counter">Attempts remaining: {attemptsLeft}</p>
        )}
        {!cameraFailed ? (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="camera-preview"
              onLoadedMetadata={() => videoRef.current?.play()}
            />
            <button className="btn-primary snapshot-btn" onClick={takeSnapshot} disabled={disabled}>
              Take Photo
            </button>
          </>
        ) : (
          <>
            <p className="camera-error">Camera unavailable — pick a file instead.</p>
            <input
              ref={fileRef}
              type="file"
              accept={accepted}
              onChange={onFileChange}
              style={{ display: 'none' }}
            />
            <button className="btn-primary" onClick={() => fileRef.current?.click()} disabled={disabled}>
              Choose File
            </button>
          </>
        )}
      </div>
    )
  }

  // preview
  return (
    <div className="node-bubble capture-area">
      {snapshot && (
        <img
          src={URL.createObjectURL(snapshot)}
          alt="Captured preview"
          className="capture-preview"
        />
      )}
      <div className="capture-actions">
        <button
          className="btn-secondary"
          onClick={retake}
          disabled={disabled || (attemptsLeft !== null && attemptsLeft <= 0)}
        >
          Retake
        </button>
        <button className="btn-primary" onClick={submit} disabled={disabled}>
          Submit
        </button>
      </div>
    </div>
  )
}

// ── end node ─────────────────────────────────────────────────────────────────
function EndNode({ node }: { node: SessionNode }) {
  return (
    <div className="end-screen">
      <div className="checkmark" aria-hidden="true">&#10003;</div>
      {node.messages.map((m, i) => <p key={i}>{m.text}</p>)}
    </div>
  )
}

// ── main renderer ────────────────────────────────────────────────────────────
export default function NodeRenderer({ nodes, onAnswer, disabled }: Props) {
  // The input node drives interaction; messages before it are display-only.
  // Find the last actionable node (question_* or end) — render all nodes.
  return (
    <div className="node-list">
      {nodes.map(node => {
        switch (node.type) {
          case 'message':
            return <MessageBubble key={node.node_id} node={node} />
          case 'question_text':
            return (
              <TextQuestion
                key={node.node_id}
                node={node}
                onAnswer={onAnswer}
                disabled={disabled}
              />
            )
          case 'question_options':
            return (
              <OptionsQuestion
                key={node.node_id}
                node={node}
                onAnswer={onAnswer}
                disabled={disabled}
              />
            )
          case 'question_capture':
            return (
              <CaptureQuestion
                key={node.node_id}
                node={node}
                onAnswer={onAnswer}
                disabled={disabled}
              />
            )
          case 'end':
            return <EndNode key={node.node_id} node={node} />
          default:
            return null
        }
      })}
    </div>
  )
}
