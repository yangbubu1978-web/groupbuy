
-- ============================================================
-- 遷移 20260905_b：storage.media 上傳權限（VIP 庫漏了 storage policies）
-- 症狀：首頁看板上傳圖片出現 RLS 違規
-- ============================================================
create policy "media_public_read" on storage.objects
  for select using (bucket_id = 'media');

create policy "media_admin_write" on storage.objects
  for insert with check (bucket_id = 'media' and public.is_admin());

create policy "media_admin_update" on storage.objects
  for update using (bucket_id = 'media' and public.is_admin());

create policy "media_admin_delete" on storage.objects
  for delete using (bucket_id = 'media' and public.is_admin());
