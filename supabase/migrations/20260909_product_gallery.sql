-- 三圖轮播：新增第二、三张图欄位
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='image_url_2') THEN
    ALTER TABLE public.products ADD COLUMN image_url_2 text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='image_url_3') THEN
    ALTER TABLE public.products ADD COLUMN image_url_3 text;
  END IF;
END $$;
