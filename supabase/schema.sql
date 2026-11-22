-- Voice Mapping schema: one row per practice day per user, private recordings.
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  prompt_id text,
  prompt_text text,
  finished text check (finished in ('yes', 'partly', 'no')),
  presence int check (presence between 1 and 5),
  note text default '',
  audio_path text,
  audio_type text,
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);
create index if not exists sessions_user_updated on public.sessions (user_id, updated_at);

create table if not exists public.prompts (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  text text not null,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists prompts_user on public.prompts (user_id);

alter table public.sessions enable row level security;
alter table public.prompts enable row level security;

create policy "own sessions" on public.sessions for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own prompts" on public.prompts for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Private bucket; each user may only touch files under their own {user_id}/ folder.
insert into storage.buckets (id, name, public) values ('recordings', 'recordings', false)
  on conflict (id) do nothing;

create policy "own recordings read" on storage.objects for select to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own recordings insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'recordings' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own recordings update" on storage.objects for update to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own recordings delete" on storage.objects for delete to authenticated
  using (bucket_id = 'recordings' and (storage.foldername(name))[1] = (select auth.uid())::text);
