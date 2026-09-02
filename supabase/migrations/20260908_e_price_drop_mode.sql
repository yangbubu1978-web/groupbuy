do $$ begin
  if not exists (select 1 from information_schema.columns where table_name='product_follows' and column_name='price_drop_mode') then
    alter table product_follows add column price_drop_mode text not null default 'all' check (price_drop_mode in ('once','all'));
    comment on column product_follows.price_drop_mode is '降價通知模式: once=僅30%, all=30/50/70三階段';
  end if;
end $$;
