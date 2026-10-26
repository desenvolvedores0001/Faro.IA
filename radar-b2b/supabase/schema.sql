-- Radar B2B — schema do banco (rode no Supabase: SQL Editor -> New query -> Run).
-- Cria a tabela de leads e protege por Row Level Security: cada usuário só
-- enxerga e mexe nos próprios leads.

create table if not exists public.leads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  place_id   text not null,            -- id da empresa (Google Place id) p/ dedupe
  name       text not null,
  phone      text,
  niche      text,
  city       text,
  stage      text not null default 'novo',  -- novo | contatado | respondeu | fechado
  message    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, place_id)
);

-- mantém updated_at em dia
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_leads_touch on public.leads;
create trigger trg_leads_touch
  before update on public.leads
  for each row execute function public.touch_updated_at();

-- Row Level Security
alter table public.leads enable row level security;

drop policy if exists "leads_select_own" on public.leads;
create policy "leads_select_own" on public.leads
  for select using (auth.uid() = user_id);

drop policy if exists "leads_insert_own" on public.leads;
create policy "leads_insert_own" on public.leads
  for insert with check (auth.uid() = user_id);

drop policy if exists "leads_update_own" on public.leads;
create policy "leads_update_own" on public.leads
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "leads_delete_own" on public.leads;
create policy "leads_delete_own" on public.leads
  for delete using (auth.uid() = user_id);

create index if not exists leads_user_idx on public.leads (user_id, created_at desc);
