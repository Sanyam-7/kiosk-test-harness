import { useState, useRef, useCallback, useEffect } from 'react'
import type { SessionNode } from '../../types'
import { FaceDetector as MPFaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import type { Detection } from '@mediapipe/tasks-vision'

// ── MediaPipe face detector (singleton) ──────────────────────────────────────
// Version package.json wale @mediapipe/tasks-vision se match rakho.
// Kiosk ke liye wasm + model apne server par host karna best hai.
const MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const MP_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'

let mpDetectorPromise: Promise<MPFaceDetector> | null = null

async function getMPDetector(): Promise<MPFaceDetector> {
  if (!mpDetectorPromise) {
    mpDetectorPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(MP_WASM)
      const make = (delegate: 'GPU' | 'CPU') =>
        MPFaceDetector.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MP_MODEL, delegate },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.6,
        })
      try { return await make('GPU') } catch { return await make('CPU') }
    })().catch(err => {
      mpDetectorPromise = null
      throw err
    })
  }
  return mpDetectorPromise
}

// ── Capture tuning (kiosk camera ke hisaab se test karke adjust karo) ────────
const FRAME_INTERVAL_MS = 150
const STABLE_FRAMES = 6          // ~0.9s lagataar OK
const FACE_SPAN_MIN = 0.28       // face width / video ki chhoti side
const FACE_SPAN_MAX = 0.70
const CENTER_TOL_X = 0.12        // video width ka fraction
const CENTER_TOL_Y = 0.15
const MOVE_TOL = 0.025           // frame-to-frame center movement (fraction)
const YAW_MAX = 0.28             // nose offset / eye distance
const ROLL_MAX_DEG = 12
const BLUR_MIN = 25              // laplacian variance (96x96 face crop)
const BRIGHT_MIN = 60
const BRIGHT_MAX = 215
const CROP_MARGIN = 2.0          // face box ka multiple (square side)
const CROP_SIZE = 512

type Box = { originX: number; originY: number; width: number; height: number }

const qCanvas = document.createElement('canvas')
qCanvas.width = 96
qCanvas.height = 96
const qCtx = qCanvas.getContext('2d', { willReadFrequently: true })!

function measureQuality(video: HTMLVideoElement, box: Box) {
  const sx = Math.max(0, box.originX)
  const sy = Math.max(0, box.originY)
  const sw = Math.min(video.videoWidth - sx, box.width)
  const sh = Math.min(video.videoHeight - sy, box.height)
  qCtx.drawImage(video, sx, sy, sw, sh, 0, 0, 96, 96)
  const { data } = qCtx.getImageData(0, 0, 96, 96)
  const g = new Float32Array(96 * 96)
  let sum = 0
  for (let i = 0; i < g.length; i++) {
    const v = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    g[i] = v
    sum += v
  }
  const brightness = sum / g.length
  let s = 0, s2 = 0, n = 0
  for (let y = 1; y < 95; y++) {
    for (let x = 1; x < 95; x++) {
      const i = y * 96 + x
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - 96] - g[i + 96]
      s += lap
      s2 += lap * lap
      n++
    }
  }
  const mean = s / n
  const blur = s2 / n - mean * mean
  return { brightness, blur }
}

type Assessment = { ok: boolean; message: string; box?: Box }

function assessFrame(video: HTMLVideoElement, dets: Detection[]): Assessment {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (dets.length === 0) return { ok: false, message: 'Position your face in the oval' }
  if (dets.length > 1) return { ok: false, message: 'Only one person please' }

  const det = dets[0]
  const b = det.boundingBox
  if (!b) return { ok: false, message: 'Position your face in the oval' }
  const box: Box = { originX: b.originX, originY: b.originY, width: b.width, height: b.height }

  const span = box.width / Math.min(vw, vh)
  if (span < FACE_SPAN_MIN) return { ok: false, message: 'Come a little closer', box }
  if (span > FACE_SPAN_MAX) return { ok: false, message: 'Move back a little', box }

  const offX = Math.abs(box.originX + box.width / 2 - vw / 2) / vw
  const offY = Math.abs(box.originY + box.height / 2 - vh / 2) / vh
  if (offX > CENTER_TOL_X || offY > CENTER_TOL_Y) return { ok: false, message: 'Center your face', box }

  // keypoints (normalized): 0 right eye, 1 left eye, 2 nose tip, 3 mouth, 4/5 ears
  const kp = det.keypoints
  if (kp && kp.length >= 3) {
    const ex0 = kp[0].x * vw, ey0 = kp[0].y * vh
    const ex1 = kp[1].x * vw, ey1 = kp[1].y * vh
    const noseX = kp[2].x * vw
    const eyeDist = Math.hypot(ex1 - ex0, ey1 - ey0) || 1
    const yaw = Math.abs(noseX - (ex0 + ex1) / 2) / eyeDist
    const roll = Math.abs((Math.atan2(ey1 - ey0, ex1 - ex0) * 180) / Math.PI)
    const rollNorm = roll > 90 ? 180 - roll : roll
    if (yaw > YAW_MAX) return { ok: false, message: 'Look straight at the camera', box }
    if (rollNorm > ROLL_MAX_DEG) return { ok: false, message: 'Keep your head straight', box }
  }

  const { brightness, blur } = measureQuality(video, box)
  if (brightness < BRIGHT_MIN) return { ok: false, message: 'Too dark, find better light', box }
  if (brightness > BRIGHT_MAX) return { ok: false, message: 'Too bright, avoid direct light', box }
  if (blur < BLUR_MIN) return { ok: false, message: 'Hold still, image is blurry', box }

  return { ok: true, message: 'Hold still…', box }
}

// Face ke around square crop (KYC style): margin + thoda upar shift (forehead/hair)
function cropFaceSquare(video: HTMLVideoElement, box: Box): Promise<Blob | null> {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const cx = box.originX + box.width / 2
  const cy = box.originY + box.height / 2 - box.height * 0.08
  const side = Math.min(Math.max(box.width, box.height) * CROP_MARGIN, vw, vh)
  const sx = Math.min(Math.max(0, cx - side / 2), vw - side)
  const sy = Math.min(Math.max(0, cy - side / 2), vh - side)
  const canvas = document.createElement('canvas')
  canvas.width = CROP_SIZE
  canvas.height = CROP_SIZE
  canvas.getContext('2d')!.drawImage(video, sx, sy, side, side, 0, 0, CROP_SIZE, CROP_SIZE)
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92))
}

export type AnswerPayload =
  | { type: 'text'; value: string }
  | { type: 'option'; option_id: string; label?: string }
  | { type: 'file'; file: File; previewUrl?: string }

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
  const [hovered, setHovered] = useState<string | null>(null)

  return (
    <div className="kiosk-options-wrap">
      {node.error && <p className="k-node-error">{node.error.message}</p>}
      <div className="k-options-list">
        {options.map((opt, i) => (
          <button
            key={opt.id}
            className={`k-opt-item${hovered === opt.id ? ' hovered' : ''}`}
            onClick={() => onAnswer({ type: 'option', option_id: opt.id, label: opt.label })}
            onMouseEnter={() => setHovered(opt.id)}
            onMouseLeave={() => setHovered(null)}
            disabled={disabled}
            style={{ '--delay': `${i * 55}ms` } as React.CSSProperties}
          >
            <span className="k-opt-index">{i + 1}</span>
            <span className="k-opt-body">
              <span className="k-opt-label">{opt.label}</span>
              {opt.description && <span className="k-opt-desc">{opt.description}</span>}
            </span>
            <svg className="k-opt-arrow" viewBox="0 0 16 16" fill="none">
              <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6"
                strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Face dot positions (in 100×133 SVG viewBox) ──────────────────────────────
const FACE_DOTS: [number, number][] = [
  [50,10],[37,14],[63,14],[26,21],[74,21],
  [24,26],[30,23],[38,24],[62,24],[70,23],[76,26],
  [23,33],[29,29],[37,29],[43,33],[37,37],[29,37],
  [57,33],[63,29],[71,29],[77,33],[71,37],[63,37],
  [50,36],[50,44],[50,52],
  [42,55],[50,57],[58,55],
  [17,50],[83,50],[15,60],[85,60],
  [36,64],[43,61],[50,62],[57,61],[64,64],
  [36,72],[43,75],[50,76],[57,75],[64,72],
  [22,72],[78,72],[23,81],[77,81],[34,90],[66,90],[50,95],
]

// ── question_capture ─────────────────────────────────────────────────────────
type CapturePhase = 'consent' | 'scanning' | 'analyzing' | 'captured' | 'fallback' | 'submitted'

function CaptureInput({ node, onAnswer, disabled }: Props) {
  const [phase, setPhase] = useState<CapturePhase>('consent')
  const [guidance, setGuidance] = useState('Position your face in the oval')
  const [ready, setReady] = useState(false)
  const [detectorFailed, setDetectorFailed] = useState(false)
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null)
  const [capturedFile, setCapturedFile] = useState<File | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const capturedRef = useRef(false)
  const analyzeRef = useRef(false)

  const captureType = node.input?.capture_type ?? 'face'
  const isIdCapture = captureType === 'id'
  const accepted = node.input?.accepted_types?.join(',') ?? 'image/*'

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
  }, [])

  useEffect(() => () => { stopStream(); capturedRef.current = true }, [stopStream])

  const showCaptured = useCallback((blob: Blob, name = 'capture.jpg') => {
    const file = new File([blob], name, { type: 'image/jpeg' })
    setCapturedFile(file)
    setCapturedUrl(URL.createObjectURL(file))
    setReady(false)
    setPhase('captured')
  }, [])

  // Auto-capture: fresh detection + face crop. Face na mile to wapas scanning.
  const capturePhoto = useCallback(async () => {
    const video = videoRef.current
    if (capturedRef.current || !video) return

    let box: Box | null = null
    try {
      const det = await getMPDetector()
      const dets = det.detectForVideo(video, performance.now()).detections
      if (dets.length === 1 && dets[0].boundingBox) {
        const b = dets[0].boundingBox
        box = { originX: b.originX, originY: b.originY, width: b.width, height: b.height }
      }
    } catch { /* box null → retry */ }

    if (!box) {
      analyzeRef.current = false
      setGuidance('Could not see your face, please try again')
      setPhase('scanning')
      return
    }

    capturedRef.current = true
    const blob = await cropFaceSquare(video, box)
    stopStream()
    if (!blob) { capturedRef.current = false; setPhase('fallback'); return }
    showCaptured(blob)
  }, [stopStream, showCaptured])

  // Detector fail hone par manual capture (center square crop)
  const manualFaceCapture = useCallback(async () => {
    const video = videoRef.current
    if (!video || capturedRef.current) return
    capturedRef.current = true
    const s = Math.min(video.videoWidth, video.videoHeight) * 0.5
    const box: Box = {
      originX: video.videoWidth / 2 - s / 2,
      originY: video.videoHeight / 2 - s / 2,
      width: s,
      height: s,
    }
    const blob = await cropFaceSquare(video, box)
    stopStream()
    if (blob) showCaptured(blob)
  }, [stopStream, showCaptured])

  const usePhoto = useCallback(() => {
    if (!capturedFile) return
    setPhase('submitted')
    onAnswer({ type: 'file', file: capturedFile, previewUrl: capturedUrl ?? undefined })
  }, [capturedFile, capturedUrl, onAnswer])

  const goAnalyze = useCallback(() => {
    if (analyzeRef.current) return
    analyzeRef.current = true
    setPhase('analyzing')
  }, [])

  const startCamera = useCallback(async () => {
    capturedRef.current = false
    analyzeRef.current = false
    setReady(false)
    setGuidance('Position your face in the oval')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      streamRef.current = stream
      setPhase('scanning')
    } catch {
      setPhase('fallback')
    }
  }, [])

  const retake = useCallback(() => {
    if (capturedUrl) URL.revokeObjectURL(capturedUrl)
    setCapturedUrl(null)
    setCapturedFile(null)
    startCamera()
  }, [capturedUrl, startCamera])

  // Live detection loop (sirf face mode)
  useEffect(() => {
    if (phase !== 'scanning' || isIdCapture) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stable = 0
    let prev: { x: number; y: number } | null = null
    let detector: MPFaceDetector | null = null

    const loop = async () => {
      if (cancelled) return
      const video = videoRef.current
      if (video && video.readyState >= 2 && video.videoWidth) {
        try {
          if (!detector) detector = await getMPDetector()
          if (cancelled) return
          const dets = detector.detectForVideo(video, performance.now()).detections
          const a = assessFrame(video, dets)

          let ok = a.ok
          if (ok && a.box) {
            const c = {
              x: (a.box.originX + a.box.width / 2) / video.videoWidth,
              y: (a.box.originY + a.box.height / 2) / video.videoHeight,
            }
            if (prev && Math.hypot(c.x - prev.x, c.y - prev.y) > MOVE_TOL) ok = false
            prev = c
          } else {
            prev = null
          }

          setReady(a.ok)
          setGuidance(ok ? 'Hold still…' : a.ok ? 'Hold still…' : a.message)

          if (ok) {
            stable++
            if (stable >= STABLE_FRAMES) { goAnalyze(); return }
          } else {
            stable = 0
          }
        } catch {
          setDetectorFailed(true)
          return
        }
      }
      timer = setTimeout(loop, FRAME_INTERVAL_MS)
    }

    timer = setTimeout(loop, 800) // camera warm-up
    return () => { cancelled = true; clearTimeout(timer) }
  }, [phase, isIdCapture, goAnalyze])

  // analyzing: chhota pause, phir fresh detect + crop
  useEffect(() => {
    if (phase !== 'analyzing') return
    const t = setTimeout(capturePhoto, 600)
    return () => clearTimeout(t)
  }, [phase, capturePhoto])

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setCapturedFile(f)
    setCapturedUrl(URL.createObjectURL(f))
    setPhase('captured')
  }, [])

  // ID card: fixed center crop (manual capture button)
  const cropAndSubmit = useCallback((sourceUrl: string, sourceFile: File) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const cw = Math.round(img.width * 0.85)
      const ch = Math.round(img.height * 0.54)
      const cx = Math.round((img.width - cw) / 2)
      const cy = Math.round((img.height - ch) / 2)
      canvas.width = cw
      canvas.height = ch
      canvas.getContext('2d')!.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch)
      canvas.toBlob(blob => {
        if (!blob) { onAnswer({ type: 'file', file: sourceFile, previewUrl: sourceUrl }); return }
        showCaptured(blob, sourceFile.name)
      }, 'image/jpeg', 0.92)
    }
    img.src = sourceUrl
  }, [onAnswer, showCaptured])

  if (phase === 'submitted') return null

  if (phase === 'consent') {
    const instructions = node.input?.instructions
    const consentText = node.input?.consent_text
    return (
      <div className="kiosk-input-bar">
        {node.error && <p className="k-node-error">{node.error.message}</p>}
        <div className="k-consent">
          {consentText && <p className="k-consent-text">{consentText}</p>}
          {instructions && <p className="k-consent-instructions">{instructions}</p>}
          <button className="k-primary-btn" onClick={startCamera} disabled={disabled}>
            {isIdCapture ? 'Scan ID Card' : 'Open Camera'}
          </button>
        </div>
      </div>
    )
  }

  const guideColor = ready ? '#7BAE8B' : '#E0A458'

  return (
    <div className="camera-overlay">
      {phase === 'captured' && capturedUrl
        ? <img className="camera-captured-img" src={capturedUrl} alt="" />
        : <video
            ref={el => {
              videoRef.current = el
              if (el && streamRef.current && el.srcObject !== streamRef.current) {
                el.srcObject = streamRef.current
              }
            }}
            className="camera-video"
            autoPlay
            playsInline
            muted
          />
      }

      {(phase === 'scanning' || phase === 'analyzing') && (
        <div className="camera-guide">
          {isIdCapture ? (
            <svg className="id-frame-svg" viewBox="0 0 100 63" fill="none">
              <rect x="2" y="2" width="96" height="59" rx="4"
                stroke="#7BAE8B" strokeWidth="0.8" strokeDasharray="4 2.5"
                opacity={phase === 'analyzing' ? 0.9 : 0.65} />
              {([
                [2,2,'h8'], [2,2,'v8'],
                [98,2,'h-8'], [98,2,'v8'],
                [2,61,'h8'], [2,61,'v-8'],
                [98,61,'h-8'], [98,61,'v-8'],
              ] as [number,number,string][]).map(([x,y,d],i) => (
                <path key={i} d={`M${x} ${y} ${d}`}
                  stroke="#7BAE8B" strokeWidth="2" strokeLinecap="round"/>
              ))}
            </svg>
          ) : (
            <svg className="face-mesh-svg" viewBox="0 0 100 133" fill="none">
              <ellipse
                cx="50" cy="66.5" rx="44" ry="59.5"
                stroke={guideColor} strokeWidth="0.8"
                strokeDasharray={ready ? '0' : '3 2.5'}
                opacity={phase === 'analyzing' ? 1 : 0.75}
                style={{ transition: 'stroke 0.2s' }}
              />
              {FACE_DOTS.map(([x, y], i) => (
                <circle
                  key={i}
                  cx={x} cy={y} r="1.3"
                  fill={guideColor}
                  className={`face-dot${phase === 'analyzing' ? ' analyzing' : ''}`}
                  style={{ animationDelay: `${(i * 0.04) % 1.6}s` }}
                />
              ))}
            </svg>
          )}
        </div>
      )}

      {phase === 'scanning' && (
        <p className="camera-scan-label">
          {isIdCapture
            ? 'Fit your ID card inside the frame'
            : detectorFailed ? 'Auto-detect unavailable. Align your face and tap Capture' : guidance}
        </p>
      )}
      {phase === 'analyzing' && <p className="camera-scan-label analyzing">Capturing…</p>}

      {/* Manual capture: ID mode ya detector fail */}
      {phase === 'scanning' && (isIdCapture || detectorFailed) && (
        <button
          className="id-capture-btn"
          onClick={() => {
            const video = videoRef.current
            if (!video) return
            if (!isIdCapture) { manualFaceCapture(); return }
            const canvas = document.createElement('canvas')
            canvas.width = video.videoWidth || 1280
            canvas.height = video.videoHeight || 720
            canvas.getContext('2d')!.drawImage(video, 0, 0)
            canvas.toBlob(blob => {
              if (!blob) return
              const file = new File([blob], 'id_capture.jpg', { type: 'image/jpeg' })
              const url = URL.createObjectURL(file)
              stopStream()
              cropAndSubmit(url, file)
            }, 'image/jpeg', 0.92)
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" width="20" height="20">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/>
            <circle cx="12" cy="12" r="4.5" fill="currentColor"/>
          </svg>
          Capture
        </button>
      )}

      {phase === 'analyzing' && <div className="camera-analyze-bar" />}

      {phase === 'captured' && (
        <>
          <div className="capture-tick-overlay">
            <svg className="capture-tick-svg" viewBox="0 0 60 60">
              <circle cx="30" cy="30" r="28" stroke="#7BAE8B" strokeWidth="2.5"
                fill="rgba(123,174,139,.18)" />
              <path d="M18 30 L27 39 L42 21"
                stroke="#7BAE8B" strokeWidth="3" strokeLinecap="round"
                strokeLinejoin="round" fill="none" />
            </svg>
          </div>
          <div className="camera-confirm-bar">
            <button className="camera-confirm-retake" onClick={retake}>Retake</button>
            <button className="camera-confirm-use" onClick={usePhoto}>Use This</button>
          </div>
        </>
      )}

      {phase === 'fallback' && (
        <div className="camera-fallback">
          <p>Camera unavailable, please choose a file.</p>
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
    case 'question_text': {
      const { inbound_type, options } = node.input ?? {}
      if (inbound_type === 'single_select' && options?.length) {
        const textOnAnswer = (a: AnswerPayload) =>
          onAnswer(a.type === 'option' ? { type: 'text', value: a.label ?? a.option_id } : a)
        return <OptionsInput node={node} onAnswer={textOnAnswer} disabled={disabled} />
      }
      return <TextInput node={node} onAnswer={onAnswer} disabled={disabled} />
    }
    case 'question_options':
      return <OptionsInput node={node} onAnswer={onAnswer} disabled={disabled} />
    case 'question_capture':
      return <CaptureInput node={node} onAnswer={onAnswer} disabled={disabled} />
    default:
      return null
  }
}