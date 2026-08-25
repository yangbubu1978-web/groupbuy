import { useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'

/**
 * 白名單批量匯入（.xls / .xlsx / .csv）
 *
 * 欄位格式（第一列為標題）：
 *   姓名（必填）｜手機（必填，09 開頭 10 碼）｜公司（選填，需與後台公司名完全一致）｜密碼（選填，≥6 碼，留空＝888888）
 */

interface ImportRow {
  姓名: string
  手機: string
  公司?: string
  密碼?: string
}

export interface ImportResult {
  ok: number
  fail: number
  skipped: number
  errors: string[]
}

export function useCustomerImport(load: () => Promise<void>) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  /** 下載 .xls 範本 */
  const downloadTemplate = () => {
    const sample = [
      { 姓名: '王小明', 手機: '0912345678', 公司: '總管理處', 密碼: '' },
      { 姓名: '李美美', 手機: '0987654321', 公司: '', 密碼: '' },
    ]
    const ws = XLSX.utils.json_to_sheet(sample)
    ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 12 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '白名單')
    XLSX.writeFile(wb, '白名單範本.xls')
  }

  /** 解析檔案 → 逐筆建立（走 admin Edge Function 建 auth 帳號） */
  const importFile = async (file: File): Promise<void> => {
    setImporting(true)
    setResult(null)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf)
      const ws = wb.Sheets[wb.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<ImportRow>(ws, { defval: '' })

      if (rows.length === 0) throw new Error('檔案內沒有資料')
      if (rows.length > 200) throw new Error('單次最多匯入 200 筆')

      // 現有客戶（手機比對避免重複）
      const { data: existing } = await supabase.from('customers').select('phone, name')
      const existingPhones = new Set((existing ?? []).map((c) => c.phone))
      // 公司名 → id
      const { data: companies } = await supabase.from('companies').select('id, name')
      const companyMap = new Map((companies ?? []).map((c) => [c.name, c.id]))

      let ok = 0
      let fail = 0
      let skipped = 0
      const errors: string[] = []
      const seen = new Set<string>()

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const line = `第 ${i + 2} 列`
        const name = String(row['姓名'] ?? '').trim()
        const phoneRaw = String(row['手機'] ?? '').replace(/[\s-]/g, '')
        let phone = phoneRaw
        if (phone.startsWith('+886')) phone = '0' + phone.slice(4)
        else if (phone.startsWith('886') && phone.length >= 11) phone = '0' + phone.slice(3)

        if (!name) { fail++; errors.push(`${line}：姓名空白`); continue }
        if (phone && !/^09\d{8}$/.test(phone)) { fail++; errors.push(`${line}：${name} 手機格式錯誤（${phone}）`); continue }
        if (phone) {
          if (seen.has(phone)) { skipped++; errors.push(`${line}：${name} 手機重複出現於本檔`); continue }
          if (existingPhones.has(phone)) { skipped++; errors.push(`${line}：${name} 已存在（手機 ${phone}）`); continue }
          seen.add(phone)
        }

        const password = String(row['密碼'] ?? '').trim() || '888888'
        if (password.length < 6) { fail++; errors.push(`${line}：${name} 密碼需 ≥6 碼`); continue }

        const companyName = String(row['公司'] ?? '').trim()
        let companyId = companyMap.get(companyName) ?? null
        // 容錯：Excel 填「吸引力國際股份有限公司」但 DB 只有「吸引力國際」→ 模糊比對
        if (companyName && !companyId) {
          for (const [k, v] of companyMap.entries()) {
            if (companyName.includes(k) || k.includes(companyName)) { companyId = v; break }
          }
        }
        // 仍找不到 → 不直接報錯，後面會 fallback 到第一間公司（避免整批失敗）

        // 建客戶＋auth 帳號（與單筆新增同流程）
        try {
          let authUserId: string | null = null
          const { data: sess } = await supabase.auth.getSession()
          const token = sess.session?.access_token
          const fnBase = import.meta.env.VITE_SUPABASE_URL as string
          const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string
          const resp = await fetch(`${fnBase}/functions/v1/admin`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              apikey: anonKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ action: 'createAuthUser', name, phone: phone || undefined, password }),
          })
          const res = await resp.json().catch(() => null)
          if (!resp.ok || !res?.ok) throw new Error(res?.reason ?? `HTTP ${resp.status}`)
          authUserId = res.userId ?? null

          // 預設公司：找不到對應時用第一間
          let finalCompanyId = companyId
          if (!finalCompanyId) {
            const { data: first } = await supabase.from('companies').select('id').limit(1).single()
            finalCompanyId = first?.id ?? null
          }
          if (!finalCompanyId) throw new Error('系統內沒有任何公司，請先到「公司管理」新增')

          const { error } = await supabase.from('customers').insert({
            name, phone: phone || null, company_id: finalCompanyId,
            status: 'active', role: 'member', auth_user_id: authUserId,
            must_change_password: !!authUserId,
          })
          if (error) throw error
          ok++
        } catch (e) {
          fail++
          errors.push(`${line}：${name} — ${e instanceof Error ? e.message : '建立失敗'}`)
        }
      }

      setResult({ ok, fail, skipped, errors })
      await load()
    } catch (e) {
      setResult({ ok: 0, fail: 0, skipped: 0, errors: [e instanceof Error ? e.message : '讀檔失敗'] })
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return { fileRef, importing, result, downloadTemplate, importFile, setResult }
}
