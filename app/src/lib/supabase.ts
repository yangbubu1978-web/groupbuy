import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!url || !anonKey) {
  console.warn(
    '[groupbuy] 尚未設定 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY，' +
      '請複製 .env.example 為 .env.local 並填入 Supabase 專案資訊。',
  )
}

export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
})

/** 登入 email 規則：手機號碼 → phone@phone.groupbuy.local */
export function phoneToEmail(phone: string): string {
  return `${phone.trim()}@phone.groupbuy.local`
}
