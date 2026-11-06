import { useState, useEffect, useCallback } from 'react'
import * as api from '../../api'
import { storage } from '../../storage'
import type { ApiChannel } from '../../types'
import './Admin.css'

// ── AdminPanel ────────────────────────────────────────────────────────────────

export function AdminPanel() {
  const [flowId, setFlowId] = useState(storage.getFlowId)
  const [apiKey, setApiKey] = useState(storage.getApiKey)
  const [showKey, setShowKey] = useState(false)

  const [channel, setChannel] = useState<ApiChannel | null>(null)

  const [loadError, setLoadError] = useState('')
  const [channelError, setChannelError] = useState('')

  function guardFields(): boolean {
    if (!apiKey.trim() || !flowId.trim()) {
      setLoadError('Account API Key and Flow ID are required')
      return true
    }
    setLoadError('')
    return false
  }

  const loadChannel = useCallback(async () => {
    if (guardFields()) return
    try {
      const res = await api.listChannels(apiKey, flowId)
      setChannel(res.channels[0] ?? null)
    } catch (e: unknown) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load channel')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, flowId])

  useEffect(() => {
    if (apiKey && flowId) loadChannel()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleCreateChannel() {
    if (guardFields()) return
    setChannelError('')
    try {
      const ch = await api.createChannel(apiKey, flowId)
      setChannel(ch)
    } catch (e: unknown) {
      setChannelError(e instanceof Error ? e.message : 'Failed to create channel')
    }
  }

  return (
    <div className="admin-panel">
      {/* Config Section */}
      <div className="admin-section">
        <div className="section-header">
          <h2>Configuration</h2>
        </div>
        <div className="config-grid">
          <div className="config-field">
            <label htmlFor="flowId">Flow ID</label>
            <input
              id="flowId"
              value={flowId}
              onChange={e => { setFlowId(e.target.value); storage.setFlowId(e.target.value) }}
              placeholder="Enter Flow ID"
            />
          </div>
          <div className="config-field">
            <label htmlFor="apiKey">Account API Key</label>
            <div className="api-key-field">
              <input
                id="apiKey"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); storage.setApiKey(e.target.value) }}
                placeholder="Enter your SMS Magic account API key"
              />
              <button className="btn" onClick={() => setShowKey(s => !s)}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
        </div>
        {loadError && <div className="error-banner">{loadError}</div>}
        <div className="section-footer">
          <span />
          <button className="btn btn-primary" onClick={loadChannel}>
            Load Channel
          </button>
        </div>
      </div>

      {/* Channel Section */}
      <div className="admin-section">
        <div className="section-header">
          <h2>Channel</h2>
        </div>
        {!channel ? (
          <div className="no-channel-state">
            <p>No channel found for this Flow ID. Create one to enable API access.</p>
            {channelError && <div className="error-text">{channelError}</div>}
            <button className="btn btn-primary" onClick={handleCreateChannel}>Create Channel</button>
          </div>
        ) : (
          <div className="section-body" style={{ padding: '20px 24px' }}>
            <div className="channel-meta">
              <div className="channel-meta-item">
                <label>Channel ID</label>
                <span>{channel._id}</span>
              </div>
              <div className="channel-meta-item">
                <label>Web ID</label>
                <span>{channel.web_id}</span>
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
          </div>
        )}
      </div>
    </div>
  )
}

export default AdminPanel
