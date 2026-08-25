import { Component, type ReactNode } from 'react'

/** 頂層錯誤邊界：捕捉渲染期錯誤，避免整站白畫面 */
interface Props { children: ReactNode }
interface State { hasError: boolean }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.error('[ErrorBoundary]', error)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-dvh bg-ink-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl border border-ink-100 p-8 text-center shadow-sm max-w-sm">
            <div className="text-3xl mb-3">😵</div>
            <h1 className="text-base font-bold text-ink-900">頁面出了一點狀況</h1>
            <p className="text-sm text-ink-400 mt-1 mb-5">請重新整理；若持續發生，請回報小布。</p>
            <button
              onClick={() => window.location.reload()}
              className="h-10 px-4 rounded-xl bg-accent-500 text-white text-sm font-semibold active:scale-[0.98] transition"
            >
              重新整理
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}