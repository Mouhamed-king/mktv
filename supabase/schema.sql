create table if not exists public.user_access (
  email text primary key,
  approved boolean not null default false,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_access_approved_created_at
  on public.user_access (approved, created_at);

alter table public.user_access enable row level security;
