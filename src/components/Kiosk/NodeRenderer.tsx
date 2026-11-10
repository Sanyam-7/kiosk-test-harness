import { useState, useRef, useCallback, useEffect } from 'react'
import type { SessionNode } from '../../types'
import { FaceDetector as MPFaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import type { Detection } from '@mediapipe/tasks-vision'

// ── MediaPipe face detector (singleton) ──────────────────────────────────────
// Pin this version to match @mediapipe/tasks-vision in package.json.
// For production kiosks, self-host the wasm bundle and model file.
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

// ── Capture tuning — calibrate against your kiosk camera before deploying ────
const FRAME_INTERVAL_MS = 150
const STABLE_FRAMES = 6          // ~0.9s of consecutive passing frames
const FACE_SPAN_MIN = 0.28       // face width / shorter video dimension
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

// Square crop around the face (KYC style): scaled margin + slight upward shift to include forehead/hair
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

// ── ID card detection (edge-based, no ML) ────────────────────────────────────
const ID_REGION_SCALE = 1.5     // analyze a 1.5× region around the guide frame
const ID_W = 240                // analysis canvas width
const ID_EDGE_MIN = 10          // minimum edge gradient strength for a card edge
const ID_PEAK_RATIO = 1.5       // edge peak / window average
const ID_SCALE_MIN = 0.88
const ID_SCALE_MAX = 1.12
const ID_CENTER_TOL = 0.07
const ID_ASPECT_TOL = 0.15      // width/height scale mismatch = tilt
const ID_MOVE_TOL = 0.03
const ID_STABLE_FRAMES = 6
const ID_BLUR_MIN = 20
const ID_BRIGHT_MIN = 60
const ID_BRIGHT_MAX = 220
const ID_GLARE_MAX = 0.08       // max fraction of pixels inside the guide with brightness >250
const ID_CROP_PAD = 0.03

type IdAssessment = { ok: boolean; message: string; cx?: number; cy?: number; scale?: number }

const idCanvas = document.createElement('canvas')
const idCtx = idCanvas.getContext('2d', { willReadFrequently: true })!

// Map the CSS guide element to video pixel coordinates, accounting for object-fit: cover and horizontal mirror
function guideToVideoRect(video: HTMLVideoElement, guideEl: HTMLElement): Box | null {
  const vr = video.getBoundingClientRect()
  const gr = guideEl.getBoundingClientRect()
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh || !vr.width || !vr.height) return null
  const scale = Math.max(vr.width / vw, vr.height / vh)
  const offX = (vr.width - vw * scale) / 2
  const offY = (vr.height - vh * scale) / 2
  let x0 = (gr.left - vr.left - offX) / scale
  let x1 = (gr.right - vr.left - offX) / scale
  ;[x0, x1] = [vw - x1, vw - x0] // flip x coords: preview is horizontally mirrored
  const y0 = (gr.top - vr.top - offY) / scale
  const y1 = (gr.bottom - vr.top - offY) / scale
  const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0)
  const cx1 = Math.min(vw, x1), cy1 = Math.min(vh, y1)
  if (cx1 - cx0 < 50 || cy1 - cy0 < 30) return null
  return { originX: cx0, originY: cy0, width: cx1 - cx0, height: cy1 - cy0 }
}

function findPeak(vals: number[]) {
  let bi = 0
  let sum = 0
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i]
    if (vals[i] > vals[bi]) bi = i
  }
  return { i: bi, v: vals[bi], mean: sum / vals.length }
}

function analyzeId(video: HTMLVideoElement, g: Box): IdAssessment {
  const rw = g.width * ID_REGION_SCALE
  const rh = g.height * ID_REGION_SCALE
  const rx = g.originX + g.width / 2 - rw / 2
  const ry = g.originY + g.height / 2 - rh / 2
  const cw = ID_W
  const ch = Math.round((ID_W * rh) / rw)
  if (idCanvas.width !== cw || idCanvas.height !== ch) {
    idCanvas.width = cw
    idCanvas.height = ch
  }
  idCtx.drawImage(video, rx, ry, rw, rh, 0, 0, cw, ch)
  const { data } = idCtx.getImageData(0, 0, cw, ch)
  const gray = new Float32Array(cw * ch)
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  }

  const k = cw / rw
  const gx0 = Math.round((g.originX - rx) * k)
  const gy0 = Math.round((g.originY - ry) * k)
  const gw = Math.round(g.width * k)
  const gh = Math.round(g.height * k)
  const gx1 = gx0 + gw
  const gy1 = gy0 + gh

  // 1. Brightness + glare check inside the guide region
  let sum = 0, n = 0, glare = 0
  for (let y = gy0; y < gy1; y++) {
    for (let x = gx0; x < gx1; x++) {
      const v = gray[y * cw + x]
      sum += v
      n++
      if (v > 250) glare++
    }
  }
  const brightness = sum / n
  if (brightness < ID_BRIGHT_MIN) return { ok: false, message: 'Too dark, find better light' }
  if (brightness > ID_BRIGHT_MAX) return { ok: false, message: 'Too bright, avoid direct light' }
  if (glare / n > ID_GLARE_MAX) return { ok: false, message: 'Reduce glare, tilt the card slightly' }

  // 2. Find all 4 card edges: strongest edge line within a ±20% search window on each side
  const winY = Math.max(3, Math.round(gh * 0.2))
  const winX = Math.max(3, Math.round(gw * 0.2))
  const xa = gx0 + Math.round(gw * 0.2), xb = gx1 - Math.round(gw * 0.2)
  const ya = gy0 + Math.round(gh * 0.2), yb = gy1 - Math.round(gh * 0.2)

  const rowProfile = (yc: number) => {
    const out: number[] = []
    for (let y = yc - winY; y <= yc + winY; y++) {
      let s = 0
      for (let x = xa; x < xb; x++) s += Math.abs(gray[(y + 1) * cw + x] - gray[(y - 1) * cw + x])
      out.push(s / (xb - xa))
    }
    return out
  }
  const colProfile = (xc: number) => {
    const out: number[] = []
    for (let x = xc - winX; x <= xc + winX; x++) {
      let s = 0
      for (let y = ya; y < yb; y++) s += Math.abs(gray[y * cw + x + 1] - gray[y * cw + x - 1])
      out.push(s / (yb - ya))
    }
    return out
  }

  const top = findPeak(rowProfile(gy0))
  const bottom = findPeak(rowProfile(gy1))
  const left = findPeak(colProfile(gx0))
  const right = findPeak(colProfile(gx1))
  const valid = (p: { v: number; mean: number }) => p.v >= ID_EDGE_MIN && p.v >= p.mean * ID_PEAK_RATIO
  if (!valid(top) || !valid(bottom) || !valid(left) || !valid(right)) {
    return { ok: false, message: 'Place the whole ID card inside the frame' }
  }

  const cardTop = gy0 - winY + top.i
  const cardBottom = gy1 - winY + bottom.i
  const cardLeft = gx0 - winX + left.i
  const cardRight = gx1 - winX + right.i
  const sx = (cardRight - cardLeft) / gw
  const sy = (cardBottom - cardTop) / gh
  const scale = (sx + sy) / 2
  const cx = ((cardLeft + cardRight) / 2 - (gx0 + gx1) / 2) / gw
  const cy = ((cardTop + cardBottom) / 2 - (gy0 + gy1) / 2) / gh

  if (scale > ID_SCALE_MAX) return { ok: false, message: 'Move back a little' }
  if (scale < ID_SCALE_MIN) return { ok: false, message: 'Move closer' }
  if (Math.abs(sx - sy) > ID_ASPECT_TOL) return { ok: false, message: 'Hold the card flat and straight' }
  if (Math.abs(cx) > ID_CENTER_TOL || Math.abs(cy) > ID_CENTER_TOL) {
    return { ok: false, message: 'Center the card in the frame' }
  }

  // 3. Blur (guide interior)
  const ix0 = gx0 + Math.round(gw * 0.1), ix1 = gx1 - Math.round(gw * 0.1)
  const iy0 = gy0 + Math.round(gh * 0.1), iy1 = gy1 - Math.round(gh * 0.1)
  let s = 0, s2 = 0, m = 0
  for (let y = iy0; y < iy1; y++) {
    for (let x = ix0; x < ix1; x++) {
      const i = y * cw + x
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - cw] - gray[i + cw]
      s += lap
      s2 += lap * lap
      m++
    }
  }
  const blur = s2 / m - (s / m) * (s / m)
  if (blur < ID_BLUR_MIN) return { ok: false, message: 'Hold still, image is blurry' }

  return { ok: true, message: 'Hold still…', cx, cy, scale }
}

// Crop any rect from the video frame — used for ID capture with a small padding around the guide
function cropRect(video: HTMLVideoElement, r: Box, pad = 0, maxW = 1280): Promise<Blob | null> {
  const px = r.width * pad
  const py = r.height * pad
  const sx = Math.max(0, r.originX - px)
  const sy = Math.max(0, r.originY - py)
  const sw = Math.min(video.videoWidth - sx, r.width + 2 * px)
  const sh = Math.min(video.videoHeight - sy, r.height + 2 * py)
  const k = Math.min(1, maxW / sw)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sw * k)
  canvas.height = Math.round(sh * k)
  canvas.getContext('2d')!.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
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
  const [guidance, setGuidance] = useState('')
  const [ready, setReady] = useState(false)
  const [detectorFailed, setDetectorFailed] = useState(false)
  const [idAssist, setIdAssist] = useState(false)
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null)
  const [capturedFile, setCapturedFile] = useState<File | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const guideRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const capturedRef = useRef(false)
  const analyzeRef = useRef(false)

  const captureType = node.input?.capture_type ?? 'face'
  const isIdCapture = captureType === 'id'
  const accepted = node.input?.accepted_types?.join(',') ?? 'image/*'
  const initialGuidance = isIdCapture
    ? 'Place your ID card inside the frame'
    : 'Position your face in the oval'

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

  // Auto-capture: re-verify conditions and crop. If the check fails, return to scanning.
  const capturePhoto = useCallback(async () => {
    const video = videoRef.current
    if (capturedRef.current || !video) return

    if (isIdCapture) {
      const g = guideRef.current ? guideToVideoRect(video, guideRef.current) : null
      const a = g ? analyzeId(video, g) : null
      if (!g || !a || !a.ok) {
        analyzeRef.current = false
        setGuidance(a?.message ?? 'Hold the card steady')
        setPhase('scanning')
        return
      }
      capturedRef.current = true
      const blob = await cropRect(video, g, ID_CROP_PAD)
      stopStream()
      if (!blob) { capturedRef.current = false; setPhase('fallback'); return }
      showCaptured(blob, 'id_capture.jpg')
      return
    }

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
  }, [isIdCapture, stopStream, showCaptured])

  // Manual capture fallback: for face when detector fails, for ID when auto-capture hasn't triggered in 10s
  const manualCapture = useCallback(async () => {
    const video = videoRef.current
    if (!video || capturedRef.current) return
    capturedRef.current = true
    let blob: Blob | null = null
    if (isIdCapture) {
      const g = guideRef.current ? guideToVideoRect(video, guideRef.current) : null
      if (g) blob = await cropRect(video, g, ID_CROP_PAD)
    } else {
      const s = Math.min(video.videoWidth, video.videoHeight) * 0.5
      blob = await cropFaceSquare(video, {
        originX: video.videoWidth / 2 - s / 2,
        originY: video.videoHeight / 2 - s / 2,
        width: s,
        height: s,
      })
    }
    stopStream()
    if (blob) showCaptured(blob, isIdCapture ? 'id_capture.jpg' : 'capture.jpg')
    else { capturedRef.current = false; setPhase('fallback') }
  }, [isIdCapture, stopStream, showCaptured])

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
    setIdAssist(false)
    setGuidance(initialGuidance)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      streamRef.current = stream
      setPhase('scanning')
    } catch {
      setPhase('fallback')
    }
  }, [initialGuidance])

  const retake = useCallback(() => {
    if (capturedUrl) URL.revokeObjectURL(capturedUrl)
    setCapturedUrl(null)
    setCapturedFile(null)
    startCamera()
  }, [capturedUrl, startCamera])

  // ── Live detection: FACE ──
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
          setGuidance(a.ok ? 'Hold still…' : a.message)

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

    timer = setTimeout(loop, 800)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [phase, isIdCapture, goAnalyze])

  // ── Live detection: ID CARD ──
  useEffect(() => {
    if (phase !== 'scanning' || !isIdCapture) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let stable = 0
    let prev: { cx: number; cy: number; scale: number } | null = null

    const loop = () => {
      if (cancelled) return
      const video = videoRef.current
      const guideEl = guideRef.current
      if (video && guideEl && video.readyState >= 2 && video.videoWidth) {
        const g = guideToVideoRect(video, guideEl)
        if (g) {
          const a = analyzeId(video, g)
          let ok = a.ok
          if (a.ok && a.cx !== undefined) {
            const moved = prev
              ? Math.abs(a.cx - prev.cx) + Math.abs(a.cy! - prev.cy) + Math.abs(a.scale! - prev.scale)
              : 0
            if (prev && moved > ID_MOVE_TOL) ok = false
            prev = { cx: a.cx, cy: a.cy!, scale: a.scale! }
          } else {
            prev = null
          }

          setReady(a.ok)
          setGuidance(a.ok ? 'Hold still…' : a.message)

          if (ok) {
            stable++
            if (stable >= ID_STABLE_FRAMES) { goAnalyze(); return }
          } else {
            stable = 0
          }
        }
      }
      timer = setTimeout(loop, FRAME_INTERVAL_MS)
    }

    timer = setTimeout(loop, 800)
    const assist = setTimeout(() => setIdAssist(true), 10000)
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(assist) }
  }, [phase, isIdCapture, goAnalyze])

  // Brief pause in the analyzing phase, then run a fresh check and crop
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
  const showManual = phase === 'scanning' && (isIdCapture ? idAssist : detectorFailed)

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
        <div className="camera-guide" ref={guideRef}>
          {isIdCapture ? (
            <svg className="id-frame-svg" viewBox="0 0 100 63" fill="none">
              <rect x="2" y="2" width="96" height="59" rx="4"
                stroke={guideColor} strokeWidth="0.8"
                strokeDasharray={ready ? '0' : '4 2.5'}
                opacity={phase === 'analyzing' ? 1 : 0.8}
                style={{ transition: 'stroke 0.2s' }} />
              {([
                [2,2,'h8'], [2,2,'v8'],
                [98,2,'h-8'], [98,2,'v8'],
                [2,61,'h8'], [2,61,'v-8'],
                [98,61,'h-8'], [98,61,'v-8'],
              ] as [number,number,string][]).map(([x,y,d],i) => (
                <path key={i} d={`M${x} ${y} ${d}`}
                  stroke={guideColor} strokeWidth="2" strokeLinecap="round"
                  style={{ transition: 'stroke 0.2s' }} />
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
        <p className={`camera-scan-label ${ready ? 'ok' : 'warn'}`}>
          {!isIdCapture && detectorFailed
            ? 'Auto-detect unavailable. Align your face and tap Capture'
            : guidance}
        </p>
      )}
      {phase === 'analyzing' && <p className="camera-scan-label analyzing">Capturing…</p>}

      {showManual && (
        <button className="id-capture-btn" onClick={manualCapture}>
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