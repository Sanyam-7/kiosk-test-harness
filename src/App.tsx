import { useState } from 'react'
import { ENV_CONFIGS, getActiveEnv, type EnvKey } from './config'
import { setLogCallback } from './api'
import type { RequestLog } from './types'
import AdminPanel from './components/Admin/AdminPanel'
import KioskScreen from './components/Kiosk/KioskScreen'
import './App.css'

export default function App() {
  const [tab, setTab] = useState<'kiosk' | 'admin'>('kiosk')
  const [logs, setLogs] = useState<RequestLog[]>([])
  const [activeEnv, setActiveEnv] = useState<EnvKey>(getActiveEnv())

  setLogCallback(log => setLogs(prev => [log, ...prev].slice(0, 200)))

  function handleEnvChange(env: EnvKey) {
    localStorage.setItem('harness_env', env)
    setActiveEnv(env)
    // Reset session so new env starts fresh
    localStorage.removeItem('api_harness_session')
    window.location.reload()
  }

  return (
    <div className="app">
      <header className="banner">
        <div className="banner-brand">
          <div className="banner-logo">C</div>
          <span className="banner-title">API Channel Harness</span>
          <select
            className="env-selector"
            value={activeEnv}
            onChange={e => handleEnvChange(e.target.value as EnvKey)}
          >
            {(Object.keys(ENV_CONFIGS) as EnvKey[]).map(key => (
              <option key={key} value={key}>{ENV_CONFIGS[key].label}</option>
            ))}
          </select>
          <span className="banner-env">{ENV_CONFIGS[activeEnv].apiBase}</span>
        </div>
        <nav>
          <button className={tab === 'kiosk' ? 'active' : ''} onClick={() => setTab('kiosk')}>
            Kiosk
          </button>
          <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}>
            Admin
          </button>
        </nav>
      </header>
      <main>
        {tab === 'kiosk' && <KioskScreen logs={logs} />}
        {tab === 'admin' && <AdminPanel />}
      </main>
    </div>
  )
}
