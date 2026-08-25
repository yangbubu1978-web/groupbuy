import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

/**
 * Promise 型確認對話框（取代 window.confirm）
 * 用法：const ask = useConfirm(); if (!(await ask({ title:'刪除', message:'...', danger:true }))) return
 * 由 ConfirmProvider 在全站掛載 modal。
 */
interface AskOpts {
  title: string
  message?: string
  detail?: string
  confirmText?: string
  danger?: boolean
}
type Ask = (opts: AskOpts) => Promise<boolean>

const ConfirmCtx = createContext<Ask>(async () => false)

interface ModalState {
  opts: AskOpts
  resolve: (v: boolean) => void
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [modal, setModal] = useState<ModalState | null>(null)

  const ask = useCallback<Ask>((opts) => new Promise<boolean>((resolve) => {
    setModal({ opts, resolve })
  }), [])

  const close = (value: boolean) => {
    modal?.resolve(value)
    setModal(null)
  }

  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {modal && (
        <div className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-5">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={modal.opts.title}
            className="bg-white rounded-2xl w-full max-w-sm p-6 shadow-xl anim-pop-in"
          >
            <h2 className="text-[15px] font-bold text-ink-900">{modal.opts.title}</h2>
            {modal.opts.message && (
              <p className="text-sm text-ink-500 mt-2 whitespace-pre-line leading-relaxed">{modal.opts.message}</p>
            )}
            {modal.opts.detail && (
              <p className="text-[13px] text-ink-400 mt-1.5 whitespace-pre-line leading-relaxed">{modal.opts.detail}</p>
            )}
            <div className="flex gap-2 mt-6">
              <button
                onClick={() => close(false)}
                className="flex-1 h-11 rounded-xl border border-ink-200 text-sm font-medium text-ink-600 active:scale-[0.98] transition"
              >
                取消
              </button>
              <button
                onClick={() => close(true)}
                className={`flex-1 h-11 rounded-xl text-sm font-semibold text-white active:scale-[0.98] transition ${
                  modal.opts.danger ? 'bg-red-600' : 'bg-accent-500'
                }`}
              >
                {modal.opts.confirmText ?? '確定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  )
}

export function useConfirm(): Ask {
  return useContext(ConfirmCtx)
}