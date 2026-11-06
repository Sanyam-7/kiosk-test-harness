// Prod (Vercel): same-origin /proxy ke through jao, vercel.json rewrite backend ko forward karta hai (CORS nahi lagta).
// Dev: pehle jaisa (Vite proxy / direct URL).
const PROXY_BASE = import.meta.env.PROD ? '/proxy' : ''

export const API_BASE       = import.meta.env.VITE_API_BASE_URL       || 'https://qa-app.beconversive.com'
export const ADMIN_API_BASE = import.meta.env.VITE_ADMIN_API_BASE_URL || (PROXY_BASE || 'https://qa-api.txtbox.in')
// In dev, Vite /v2 proxy use hota hai; in prod /proxy rewrite.
export const CONV_API_BASE  = import.meta.env.VITE_CONV_API_BASE_URL  || ADMIN_API_BASE
export const CONV_API_PATH  = '/v2/guided-conv'
export const TARGET_ENV     = import.meta.env.VITE_TARGET_ENV         || 'qa'