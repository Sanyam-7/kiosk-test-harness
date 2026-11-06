export const API_BASE       = import.meta.env.VITE_API_BASE_URL       || 'https://qa-app.beconversive.com'
export const ADMIN_API_BASE = import.meta.env.VITE_ADMIN_API_BASE_URL || 'https://qa-api.txtbox.in'
// In dev (localhost), use the Vite /v2 proxy to avoid CORS; in prod use the env var or txtbox directly.
export const CONV_API_BASE  = import.meta.env.VITE_CONV_API_BASE_URL || ADMIN_API_BASE
export const CONV_API_PATH  = '/v2/guided-conv'
export const TARGET_ENV     = import.meta.env.VITE_TARGET_ENV         || 'qa'
