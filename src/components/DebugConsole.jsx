import { useState, useEffect, useRef } from 'react'
import { getLogs, subscribeLogs, clearLogs } from '../utils/logger.js'
import { useTranslation } from '../i18n/index.js'
import { Terminal, X, Trash2, Copy, AlertCircle, Info, AlertTriangle, Bug } from 'lucide-react'

const levelIcons = {
  info: Info,
  warn: AlertTriangle,
  error: AlertCircle,
  debug: Bug,
}

const levelColors = {
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
  debug: 'text-purple-400',
}

export default function DebugConsole() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState(getLogs())
  const [filter, setFilter] = useState('all')
  const bottomRef = useRef(null)

  useEffect(() => {
    return subscribeLogs(() => setLogs(getLogs()))
  }, [])

  useEffect(() => {
    if (open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, open])

  const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter)

  const copyAll = () => {
    const text = filtered.map(l => `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.level.toUpperCase()}] ${l.message}${l.details ? ' ' + l.details : ''}`).join('\n')
    navigator.clipboard.writeText(text)
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 bg-dark-800/90 backdrop-blur border border-dark-700 text-dark-300 p-3 rounded-full shadow-lg hover:bg-dark-700 transition-colors"
        title="Debug console"
      >
        <Terminal size={20} />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-3xl h-[80vh] bg-dark-900 rounded-2xl border border-dark-700 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-dark-800">
              <div className="flex items-center gap-2">
                <Terminal className="text-primary-400" size={20} />
                <h3 className="text-white font-bold">{t('debug.console')}</h3>
                <span className="text-xs text-dark-500">{logs.length} {t('debug.logs')}</span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  className="input text-xs py-1"
                >
                  <option value="all">{t('debug.all')}</option>
                  <option value="info">{t('debug.info')}</option>
                  <option value="warn">{t('debug.warn')}</option>
                  <option value="error">{t('debug.error')}</option>
                  <option value="debug">{t('debug.debug')}</option>
                </select>
                <button onClick={copyAll} className="btn-ghost p-2" title={t('debug.copy')}>
                  <Copy size={16} />
                </button>
                <button onClick={clearLogs} className="btn-ghost p-2 text-red-400" title={t('debug.clear')}>
                  <Trash2 size={16} />
                </button>
                <button onClick={() => setOpen(false)} className="btn-ghost p-2">
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-2">
              {filtered.length === 0 ? (
                <p className="text-dark-500 text-center mt-8">{t('debug.no_logs')}</p>
              ) : (
                filtered.map(log => {
                  const Icon = levelIcons[log.level] || Info
                  return (
                    <div key={log.id} className="border-l-2 border-dark-700 pl-2 py-1 hover:bg-dark-800/50 rounded">
                      <div className="flex items-start gap-2">
                        <Icon className={`${levelColors[log.level]} flex-shrink-0 mt-0.5`} size={14} />
                        <div className="flex-1 min-w-0">
                          <span className="text-dark-500">{new Date(log.timestamp).toLocaleTimeString()}</span>
                          <span className={`${levelColors[log.level]} ml-2 font-bold uppercase`}>{log.level}</span>
                          <p className="text-dark-300 mt-0.5 break-words">{log.message}</p>
                          {log.details && (
                            <p className="text-dark-500 mt-0.5 break-words">{log.details}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={bottomRef} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
