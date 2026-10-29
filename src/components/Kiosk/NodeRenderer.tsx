import { useState, useRef, useCallback, useEffect } from 'react'
import type { SessionNode } from '../../types'

export type AnswerPayload =
  | { type: 'text'; value: string }
  | { type: 'option'; option_id: string; label?: string }
  | { type: 'file'; file: File }

interface Props {
  node: SessionNode
  onAnswer: (answer: AnswerPayload) => void
  disabled: boolean
}

// ── question_text ────────────────────────────────────────────────────────────
function TextInput({ node, onAnswer, disabled }: Props) {
  const [value, setValue] = useState('')
  const validation = node.input?.validation

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
    node.input?.inbound_type === 'number' ? 'number'
    : node.input?.inbound_type === 'email' ? 'email'
    : 'text'

  const submit = () => {
    if (value.trim()) onAnswer({ type: 'text', value: value.trim() })
  }

  return (
    <div className="kiosk-input-bar">
      {node.error && <p className="k-node-error">{node.error.message}</p>}
      <div className="k-text-row">
        <input
          className="k-text-field"
          type={inputType}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          disabled={disabled}
          placeholder="Type your answer…"
          aria-label="Answer"
          autoFocus
        />
        <button
          className="k-send-btn"
          onClick={submit}
          disabled={disabled || !value.trim()}
          aria-label="Send"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" width="18" height="18">
            <path d="M3.105 2.288a.75.75 0 0 0-.826.95l1.903 6.557H13.5a.75.75 0 0 1 0 1.5H4.182l-1.903 6.557a.75.75 0 0 0 .826.95 28.897 28.897 0 0 0 15.293-7.154.75.75 0 0 0 0-1.115A28.897 28.897 0 0 0 3.105 2.288Z" />
          </svg>
        </button>
      </div>
      {hint && <p className="k-hint">{hint}</p>}
    </div>
  )
}

// ── question_options ─────────────────────────────────────────────────────────
function OptionsInput({ node, onAnswer, disabled }: Props) {
  const options = node.input?.options ?? []
  return (
    <div className="kiosk-input-bar">
      {node.error && <p className="k-node-error">{node.error.message}</p>}
      <div className="k-options">
        {options.map(opt => (
          <button
            key={opt.id}
            className="k-opt-btn"
            onClick={() => onAnswer({ type: 'option', option_id: opt.id, label: opt.label })}
            disabled={disabled}
          >
            <span className="k-opt-label">{opt.label}</span>
            {opt.description && <span className="k-opt-desc">{opt.description}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Face dot positions (in 100×133 SVG viewBox) ──────────────────────────────
const FACE_DOTS: [number, number][] = [
  // Forehead
  [50,10],[37,14],[63,14],[26,21],[74,21],
  // Eyebrows
  [24,26],[30,23],[38,24],[62,24],[70,23],[76,26],
  // Left eye
  [23,33],[29,29],[37,29],[43,33],[37,37],[29,37],
  // Right eye
  [57,33],[63,29],[71,29],[77,33],[71,37],[63,37],
  // Nose bridge
  [50,36],[50,44],[50,52],
  // Nose wings + tip
  [42,55],[50,57],[58,55],
  // Cheeks
  [17,50],[83,50],[15,60],[85,60],
  // Upper lip
  [36,64],[43,61],[50,62],[57,61],[64,64],
  // Lower lip
  [36,72],[43,75],[50,76],[57,75],[64,72],
  // Jaw + chin
  [22,72],[78,72],[23,81],[77,81],[34,90],[66,90],[50,95],
]

// ── question_capture ─────────────────────────────────────────────────────────
type CapturePhase = 'consent' | 'scanning' | 'captured' | 'fallback'

function CaptureInput({ node, onAnswer, disabled }: Props) {
  const [phase, setPhase] = useState<CapturePhase>('consent')
  const [countdown, setCountdown] = useState(4)
  const [faceDetected, setFaceDetected] = useState(false)
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const capturedRef = useRef(false)

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }, [])

  useEffect(() => () => { stopStream(); capturedRef.current = true }, [stopStream])

  const capturePhoto = useCallback(() => {
    if (capturedRef.current || !videoRef.current) return
    capturedRef.current = true
    const canvas = document.createElement('canvas')
    canvas.width = videoRef.current.videoWidth || 640
    canvas.height = videoRef.current.videoHeight || 480
    canvas.getContext('2d')!.drawImage(videoRef.current, 0, 0)
    canvas.toBlob(blob => {
      if (!blob) return
      const file = new File([blob], 'capture.jpg', { type: 'image/jpeg' })
      const url = URL.createObjectURL(file)
      setCapturedUrl(url)
      stopStream()
      setPhase('captured')
      setTimeout(() => {
        URL.revokeObjectURL(url)
        onAnswer({ type: 'file', file })
      }, 1800)
    }, 'image/jpeg', 0.9)
  }, [stopStream, onAnswer])

  const startCamera = useCallback(async () => {
    capturedRef.current = false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setPhase('scanning')
      setCountdown(4)
      setFaceDetected(false)
    } catch {
      setPhase('fallback')
    }
  }, [])

  // Face detection + countdown auto-capture
  useEffect(() => {
    if (phase !== 'scanning') return
    let stopped = false

    // Countdown (fallback if no FaceDetector or face not found)
    let secs = 4
    const tick = setInterval(() => {
      secs--
      setCountdown(secs)
      if (secs <= 0) {
        clearInterval(tick)
        if (!stopped) { stopped = true; capturePhoto() }
      }
    }, 1000)

    // FaceDetector API (Chrome only)
    let detectInterval: ReturnType<typeof setInterval> | undefined
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const FD = (window as any).FaceDetector
    if (FD) {
      try {
        const fd = new FD({ fastMode: true, maxDetectedFaces: 1 })
        detectInterval = setInterval(async () => {
          if (stopped || !videoRef.current || videoRef.current.readyState < 2) return
          try {
            const faces = await fd.detect(videoRef.current)
            if (faces.length > 0) {
              setFaceDetected(true)
              clearInterval(tick)
              clearInterval(detectInterval)
              if (!stopped) { stopped = true; capturePhoto() }
            }
          } catch { /* ignore */ }
        }, 500)
      } catch { /* FaceDetector unavailable */ }
    }

    return () => {
      stopped = true
      clearInterval(tick)
      clearInterval(detectInterval)
    }
  }, [phase, capturePhoto])

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const url = URL.createObjectURL(f)
    setCapturedUrl(url)
    setPhase('captured')
    setTimeout(() => {
      URL.revokeObjectURL(url)
      onAnswer({ type: 'file', file: f })
    }, 1800)
  }, [onAnswer])

  const accepted = node.input?.accepted_types?.join(',') ?? 'image/*'

  if (phase === 'consent') {
    return (
      <div className="kiosk-input-bar">
        {node.error && <p className="k-node-error">{node.error.message}</p>}
        <div className="k-consent">
          {node.input?.consent_text && (
            <p className="k-consent-text">{node.input.consent_text}</p>
          )}
          {node.input?.instructions && (
            <p className="k-consent-text">{node.input.instructions}</p>
          )}
          <button className="k-primary-btn" onClick={startCamera} disabled={disabled}>
            Open Camera
          </button>
        </div>
      </div>
    )
  }

  // full-screen camera overlay
  return (
    <div className="camera-overlay">
      {phase === 'captured' && capturedUrl
        ? <img className="camera-captured-img" src={capturedUrl} alt="" />
        : <video
            ref={videoRef}
            className="camera-video"
            autoPlay
            playsInline
            muted
            onLoadedMetadata={() => videoRef.current?.play()}
          />
      }

      {/* Oval + face mesh dots */}
      {phase === 'scanning' && (
        <div className="camera-guide">
          <svg className="face-mesh-svg" viewBox="0 0 100 133" fill="none">
            <ellipse
              cx="50" cy="66.5" rx="44" ry="59.5"
              stroke="#7BAE8B" strokeWidth="0.6"
              strokeDasharray="3 2.5" opacity="0.6"
            />
            {FACE_DOTS.map(([x, y], i) => (
              <circle
                key={i}
                cx={x} cy={y} r="1.3"
                fill={faceDetected ? '#7BAE8B' : '#E2DDD7'}
                className={`face-dot${faceDetected ? ' detected' : ''}`}
                style={{ animationDelay: `${(i * 0.05) % 2}s` }}
              />
            ))}
          </svg>
        </div>
      )}

      {/* Tick on capture */}
      {phase === 'captured' && (
        <div className="capture-tick-overlay">
          <svg className="capture-tick-svg" viewBox="0 0 60 60">
            <circle cx="30" cy="30" r="28" stroke="#7BAE8B" strokeWidth="2.5"
              fill="rgba(123,174,139,.18)" />
            <path d="M18 30 L27 39 L42 21"
              stroke="#7BAE8B" strokeWidth="3" strokeLinecap="round"
              strokeLinejoin="round" fill="none" />
          </svg>
        </div>
      )}

      {/* Status label */}
      {phase === 'scanning' && (
        <p className="camera-scan-label">
          {faceDetected ? 'Face detected' : 'Position your face in the oval'}
        </p>
      )}

      {/* Countdown */}
      {phase === 'scanning' && !faceDetected && countdown > 0 && (
        <p className="camera-countdown">Auto-capturing in {countdown}s</p>
      )}

      {/* Fallback file input */}
      {phase === 'fallback' && (
        <div className="camera-fallback">
          <p>Camera unavailable — please choose a file.</p>
          <input
            ref={fileRef}
            type="file"
            accept={accepted}
            onChange={onFileChange}
            style={{ display: 'none' }}
          />
          <button className="k-primary-btn" onClick={() => fileRef.current?.click()}>
            Choose File
          </button>
        </div>
      )}
    </div>
  )
}

// ── main renderer ────────────────────────────────────────────────────────────
export default function NodeRenderer({ node, onAnswer, disabled }: Props) {
  switch (node.type) {
    case 'question_text':
      return <TextInput node={node} onAnswer={onAnswer} disabled={disabled} />
    case 'question_options':
      return <OptionsInput node={node} onAnswer={onAnswer} disabled={disabled} />
    case 'question_capture':
      return <CaptureInput node={node} onAnswer={onAnswer} disabled={disabled} />
    default:
      return null
  }
}
