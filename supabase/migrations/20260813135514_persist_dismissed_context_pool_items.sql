create table dismissed_context_pool_items (
  user_id uuid not null references profiles (id) on delete cascade,
  memory_item_id uuid not null references memory_items (id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  primary key (user_id, memory_item_id)
);

create index dismissed_context_pool_items_memory_item_id_idx
  on dismissed_context_pool_items (memory_item_id);

alter table dismissed_context_pool_items enable row level security;

create policy "users manage own dismissed pool items"
  on dismissed_context_pool_items
  for all
  to authenticated
  using (
    user_id = (select auth.uid())
    and memory_item_id in (
      select id
      from memory_items
      where context_space_id in (
        select context_space_id
        from context_space_members
        where user_id = (select auth.uid())
      )
    )
  )
  with check (
    user_id = (select auth.uid())
    and memory_item_id in (
      select id
      from memory_items
      where context_space_id in (
        select context_space_id
        from context_space_members
        where user_id = (select auth.uid())
      )
    )
  );
