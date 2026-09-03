import { useSyncExternalStore } from 'react'
import { supabase } from './supabase'

type ClockSnapshot = { nowMs: number; offsetMs: number }

let snapshot: ClockSnapshot = { nowMs: Date.now(), offsetMs: 0 }
let timer: ReturnType<typeof setInterval> | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let syncing = false
const listeners = new Set<() => void>()

function notify() {
  snapshot = { ...snapshot, nowMs: Date.now() }
  listeners.forEach((listener) => listener())
}

async function syncServerClock() {
  if (syncing) return
  syncing = true
  const t0 = Date.now()
  try {
    const { data } = await supabase.rpc('server_now')
    if (data) {
      const rtt = Date.now() - t0
      snapshot = {
        nowMs: Date.now(),
        offsetMs: new Date(data).getTime() + rtt / 2 - Date.now(),
      }
      listeners.forEach((listener) => listener())
    }
  } finally {
    syncing = false
  }
}

function start() {
  if (timer) return
  timer = setInterval(notify, 1000)
  syncTimer = setInterval(syncServerClock, 5 * 60 * 1000)
  void syncServerClock()
}

function stop() {
  if (listeners.size > 0) return
  if (timer) clearInterval(timer)
  if (syncTimer) clearInterval(syncTimer)
  timer = null
  syncTimer = null
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
    stop()
  }
}

export function useSharedClock() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}
