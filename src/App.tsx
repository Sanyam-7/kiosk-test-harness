import { useState } from 'react'
import { TARGET_ENV, API_BASE } from './config'
import { setLogCallback } from './api'
import type { RequestLog } from './types'
import AdminPanel from './components/Admin/AdminPanel'
import KioskScreen from './components/Kiosk/KioskScreen'
import './App.css'

export default function App() {
  const [tab, setTab] = useState<'kiosk' | 'admin'>('kiosk')
  const [logs, setLogs] = useState<RequestLog[]>([])

  setLogCallback(log => setLogs(prev => [log, ...prev].slice(0, 200)))

  return (
    <div className="app">
      <header className="banner">
        <div className="banner-brand">
          <div className="banner-logo">C</div>
          <span className="banner-title">API Channel Harness</span>
          <span className="banner-env">{TARGET_ENV} · {API_BASE}</span>
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
