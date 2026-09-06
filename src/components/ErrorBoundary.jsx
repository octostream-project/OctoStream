import { Component } from 'react'
import { logError } from '../utils/logger.js'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    logError('ErrorBoundary caught an error', `${error?.message || error}\n${errorInfo?.componentStack || ''}`)
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  handleDismiss = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback({
          error: this.state.error,
          onReload: this.handleReload,
          onDismiss: this.handleDismiss,
        })
      }
      return (
        <div className="flex min-h-screen items-center justify-center bg-dark-950 p-6">
          <div className="max-w-md w-full bg-dark-900 rounded-2xl p-6 border border-dark-800 text-center">
            <h2 className="text-xl font-bold text-white mb-2">Ha ocurrido un error inesperado</h2>
            <p className="text-dark-400 text-sm mb-4">
              {this.state.error?.message || 'Error desconocido'}
            </p>
            <div className="flex gap-2 justify-center">
              <button onClick={this.handleDismiss} className="btn-ghost px-4 py-2">
                Reintentar
              </button>
              <button onClick={this.handleReload} className="btn-primary px-4 py-2">
                Recargar
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
