/** 匯入結果面板 */
export function ImportResultPanel({
  result,
  onClose,
}: {
  result: { ok: number; fail: number; skipped: number; errors: string[] }
  onClose: () => void
}) {
  return (
    <div className={`rounded-2xl border p-4 anim-pop-in ${result.fail > 0 ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-100'}`}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-ink-900">
          匯入完成：成功 {result.ok}｜略過 {result.skipped}｜失敗 {result.fail}
        </p>
        <button onClick={onClose} className="text-xs text-ink-400" aria-label="關閉結果">✕</button>
      </div>
      {result.errors.length > 0 && (
        <ul className="mt-2 space-y-0.5 max-h-32 overflow-y-auto">
          {result.errors.map((e, i) => (
            <li key={i} className="text-[11px] text-red-600">· {e}</li>
          ))}
        </ul>
      )}
    </div>
  )
}


