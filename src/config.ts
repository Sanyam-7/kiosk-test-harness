const PROXY_BASE = import.meta.env.PROD ? '/proxy' : ''

export const CONV_API_PATH = '/v2/guided-conv'
export const TARGET_ENV    = import.meta.env.VITE_TARGET_ENV || 'qa'

export type EnvKey = 'qa' | 'staging' | 'aus' | 'eu' | 'us'

export const ENV_CONFIGS: Record<EnvKey, { label: string; apiBase: string; appBase: string }> = {
  qa:      { label: 'QA',      apiBase: 'https://qa-api.txtbox.in',       appBase: 'https://qa-app.beconversive.com' },
  staging: { label: 'Staging', apiBase: 'https://api.txtbox.in',           appBase: 'https://staging-app.beconversive.com' },
  aus:     { label: 'AUS',     apiBase: 'https://aus-api.sms-magic.com',   appBase: 'https://aus-app.beconversive.com' },
  eu:      { label: 'EU',      apiBase: 'https://eu.api.sms-magic.com',    appBase: 'https://eu-app.beconversive.com' },
  us:      { label: 'US',      apiBase: 'https://api.sms-magic.com',       appBase: 'https://app.beconversive.com' },
}

export function getActiveEnv(): EnvKey {
  const stored = localStorage.getItem('harness_env')
  return (stored && stored in ENV_CONFIGS ? stored : TARGET_ENV) as EnvKey
}

export function getActiveApiBase(): string {
  return ENV_CONFIGS[getActiveEnv()].apiBase
}

// Legacy exports for existing code that imports these directly
export const API_BASE       = import.meta.env.VITE_API_BASE_URL       || ENV_CONFIGS.qa.appBase
export const ADMIN_API_BASE = import.meta.env.VITE_ADMIN_API_BASE_URL || (PROXY_BASE || ENV_CONFIGS.qa.apiBase)
export const CONV_API_BASE  = import.meta.env.VITE_CONV_API_BASE_URL  || ADMIN_API_BASE