import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import { storage } from '../../storage'
import type { ApiChannel, ApiKey } from '../../types'
import './Admin.css'

// ── Raw Key Modal ─────────────────────────────────────────────────────────────

interface RawKeyModalProps {
  rawKey: string
  onClose: () => void
}

function RawKeyModal({ rawKey, onClose }: RawKeyModalProps) {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(rawKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>API Key Generated</h3>
        <p className="warning-text">⚠️ Save your API key — it will NOT be shown again.</p>
        <div className="raw-key-box">{rawKey}</div>
        <div className="actions">
          <button className="btn btn-primary" onClick={copy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <button className="btn" onClick={onClose} disabled={!copied}>
            I have saved my key — Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Generate Key Modal ────────────────────────────────────────────────────────

interface GenerateKeyModalProps {
  webId: string
  channelId: string
  flowId: string
  onClose: (rawKey?: string) => void
}

function GenerateKeyModal({ webId, channelId, flowId, onClose }: GenerateKeyModalProps) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { setError('Name is required'); return }
    setError('')
    setLoading(true)
    try {
      const res = await api.generateKey(webId, channelId, name.trim(), [flowId])
      onClose(res.raw_key)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to generate key')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Generate API Key</h3>
        <form className="modal-form" onSubmit={submit}>
          <label>
            Name
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. production"
              autoFocus
            />
          </label>
          {error && <span className="error-text">{error}</span>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => onClose()}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Keys Table ────────────────────────────────────────────────────────────────

interface KeysTableProps {
  webId: string
  channelId: string
  keys: ApiKey[]
  onReload: () => void
}

function KeysTable({ webId, channelId, keys, onReload }: KeysTableProps) {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [rotateKey, setRotateKey] = useState<string | null>(null) // raw key after rotate

  function setKeyError(keyId: string, msg: string) {
    setErrors(prev => ({ ...prev, [keyId]: msg }))
  }

  async function handleRotate(key: ApiKey) {
    setKeyError(key.key_id, '')
    try {
      const res = await api.rotateKey(webId, channelId, key.key_id)
      setRotateKey(res.raw_key)
    } catch (e: unknown) {
      setKeyError(key.key_id, e instanceof Error ? e.message : 'Rotate failed')
    }
  }

  async function handleRevoke(key: ApiKey) {
    setKeyError(key.key_id, '')
    try {
      await api.revokeKey(webId, channelId, key.key_id)
      onReload()
    } catch (e: unknown) {
      setKeyError(key.key_id, e instanceof Error ? e.message : 'Revoke failed')
    }
  }

  return (
    <>
      {rotateKey && (
        <RawKeyModal
          rawKey={rotateKey}
          onClose={() => { setRotateKey(null); onReload() }}
        />
      )}
      <table>
        <thead>
          <tr>
            <th>Prefix</th>
            <th>Name</th>
            <th>Status</th>
            <th>Guided IDs</th>
            <th>Created</th>
            <th>Last Used</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {keys.map(key => (
            <tr key={key.key_id}>
              <td><span className="key-prefix">{key.key_prefix}</span></td>
              <td>{key.name}</td>
              <td><span className={`badge-${key.status}`}>{key.status}</span></td>
              <td><span className="key-prefix">{key.guided_ids.join(', ') || '—'}</span></td>
              <td>{new Date(key.created_at).toLocaleString()}</td>
              <td>{key.last_used_at ? new Date(key.last_used_at).toLocaleString() : '—'}</td>
              <td>
                <div className="actions">
                  {key.status === 'active' && (
                    <button className="btn" onClick={() => handleRotate(key)}>Rotate</button>
                  )}
                  {(key.status === 'active' || key.status === 'rotating') && (
                    <button className="btn btn-danger" onClick={() => handleRevoke(key)}>Revoke</button>
                  )}
                </div>
                {errors[key.key_id] && <div className="error-text">{errors[key.key_id]}</div>}
              </td>
            </tr>
          ))}
          {keys.length === 0 && (
            <tr><td colSpan={7} style={{ textAlign: 'center', color: '#9ca3af' }}>No keys yet</td></tr>
          )}
        </tbody>
      </table>
    </>
  )
}

// ── AdminPanel ────────────────────────────────────────────────────────────────

export function AdminPanel() {
  const [webId, setWebId] = useState(storage.getWebId)
  const [flowId, setFlowId] = useState(storage.getFlowId)
  const [apiKey, setApiKey] = useState(storage.getApiKey)
  const [showKey, setShowKey] = useState(false)

  const [channel, setChannel] = useState<ApiChannel | null>(null)
  const [keys, setKeys] = useState<ApiKey[]>([])

  const [loadError, setLoadError] = useState('')
  const [channelError, setChannelError] = useState('')

  const [showGenModal, setShowGenModal] = useState(false)
  const [pendingRawKey, setPendingRawKey] = useState<string | null>(null)

  // Guard: returns true if invalid
  function guardIds(): boolean {
    if (!webId.trim() || !flowId.trim()) {
      setLoadError('Web ID and Flow ID are required')
      return true
    }
    setLoadError('')
    return false
  }

  const loadKeys = useCallback(async (cid: string) => {
    try {
      const res = await api.listKeys(webId, cid)
      setKeys(res.keys)
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load keys')
    }
  }, [webId])

  const loadChannel = useCallback(async () => {
    if (guardIds()) return
    try {
      const res = await api.listChannels(webId, flowId)
      const ch = res.channels[0] ?? null
      setChannel(ch)
      if (ch) await loadKeys(ch._id)
      else setKeys([])
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load channel')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webId, flowId, loadKeys])

  // Auto-load on mount if config already set
  useEffect(() => {
    if (webId && flowId) loadChannel()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleCreateChannel() {
    if (guardIds()) return
    setChannelError('')
    try {
      const ch = await api.createChannel(webId, flowId)
      setChannel(ch)
      // Auto-generate a default key
      const keyRes = await api.generateKey(webId, ch._id, 'default', [flowId])
      await loadKeys(ch._id)
      setPendingRawKey(keyRes.raw_key)
    } catch (e: unknown) {
      setChannelError(e instanceof Error ? e.message : 'Failed to create channel')
    }
  }

  function handleGenModalClose(rawKey?: string) {
    setShowGenModal(false)
    if (rawKey) {
      setPendingRawKey(rawKey)
    } else if (channel) {
      loadKeys(channel._id)
    }
  }

  function handleRawKeyClose() {
    setPendingRawKey(null)
    if (channel) loadKeys(channel._id)
  }

  return (
    <div className="admin-panel">
      {pendingRawKey && <RawKeyModal rawKey={pendingRawKey} onClose={handleRawKeyClose} />}
      {showGenModal && channel && (
        <GenerateKeyModal
          webId={webId}
          channelId={channel._id}
          flowId={flowId}
          onClose={handleGenModalClose}
        />
      )}

      {/* Config Section */}
      <div className="admin-section">
        <h2>Configuration</h2>
        <div className="config-grid">
          <div className="config-field">
            <label htmlFor="webId">Web ID (account_id)</label>
            <input
              id="webId"
              value={webId}
              onChange={e => { setWebId(e.target.value); storage.setWebId(e.target.value) }}
              placeholder="Enter Web ID"
            />
          </div>
          <div className="config-field">
            <label htmlFor="flowId">Flow ID</label>
            <input
              id="flowId"
              value={flowId}
              onChange={e => { setFlowId(e.target.value); storage.setFlowId(e.target.value) }}
              placeholder="Enter Flow ID"
            />
          </div>
          <div className="config-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="apiKey">API Key</label>
            <div className="api-key-field">
              <input
                id="apiKey"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); storage.setApiKey(e.target.value) }}
                placeholder="cfapi_…"
              />
              <button className="btn" onClick={() => setShowKey(s => !s)}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
        </div>
        {loadError && <div className="error-text" style={{ marginTop: 12 }}>{loadError}</div>}
        <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={loadChannel}>
          Load Channel
        </button>
      </div>

      {/* Channel Section */}
      <div className="admin-section">
        <h2>Channel</h2>
        {!channel ? (
          <>
            <p style={{ color: 'var(--text)', fontSize: 14 }}>No channel found for this Flow ID.</p>
            {channelError && <div className="error-text">{channelError}</div>}
            <button className="btn btn-primary" onClick={handleCreateChannel}>Create Channel</button>
          </>
        ) : (
          <>
            <div className="channel-meta">
              <div className="channel-meta-item">
                <label>Channel ID</label>
                <span>{channel._id}</span>
              </div>
              <div className="channel-meta-item">
                <label>Flow ID</label>
                <span>{channel.flow_id}</span>
              </div>
              <div className="channel-meta-item">
                <label>Rate Limit (RPM)</label>
                <span>{channel.rate_limit_rpm}</span>
              </div>
              <div className="channel-meta-item">
                <label>Session TTL (s)</label>
                <span>{channel.session_ttl_seconds}</span>
              </div>
            </div>

            <KeysTable
              webId={webId}
              channelId={channel._id}
              keys={keys}
              onReload={() => loadKeys(channel._id)}
            />

            <button
              className="btn btn-primary"
              style={{ marginTop: 16 }}
              onClick={() => setShowGenModal(true)}
            >
              Generate Key
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default AdminPanel
