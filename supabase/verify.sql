-- =============================================================================
-- Post-install check for schema.sql
--
-- Run this in the Supabase SQL Editor straight after schema.sql. Every row
-- should read PASS. Anything FAIL means that part of the schema did not apply,
-- and the isolation guarantees do not hold yet.
--
-- Note: whether anonymous sign-in is enabled is a dashboard setting, not
-- database state, so it cannot be checked from here. Turn it on under
-- Authentication → Providers → Anonymous sign-ins.
-- =============================================================================

with checks(sort_key, check_name, ok) as (

  -- Extensions -------------------------------------------------------------
  select 1, 'pgcrypto is installed (needed to hash pairing codes)',
         exists (select 1 from pg_extension where extname = 'pgcrypto')

  -- Tables -----------------------------------------------------------------
  union all select 2, 'table public.rooms exists',
         to_regclass('public.rooms') is not null
  union all select 3, 'table public.room_members exists',
         to_regclass('public.room_members') is not null
  union all select 4, 'table public.clipboard_events exists',
         to_regclass('public.clipboard_events') is not null

  -- RLS is the isolation boundary; without it every row is world-readable ---
  union all select 5, 'RLS enabled on rooms',
         coalesce((select c.relrowsecurity from pg_class c
                    where c.oid = to_regclass('public.rooms')), false)
  union all select 6, 'RLS enabled on room_members',
         coalesce((select c.relrowsecurity from pg_class c
                    where c.oid = to_regclass('public.room_members')), false)
  union all select 7, 'RLS enabled on clipboard_events',
         coalesce((select c.relrowsecurity from pg_class c
                    where c.oid = to_regclass('public.clipboard_events')), false)

  -- Policies ---------------------------------------------------------------
  union all select 8, 'clipboard_events has SELECT, INSERT and DELETE policies',
         (select count(distinct cmd) from pg_policies
           where schemaname = 'public' and tablename = 'clipboard_events'
             and cmd in ('SELECT', 'INSERT', 'DELETE')) = 3
  union all select 9, 'clipboard_events has NO update policy (append-only)',
         not exists (select 1 from pg_policies
                      where schemaname = 'public' and tablename = 'clipboard_events'
                        and cmd = 'UPDATE')
  union all select 10, 'room_members has its four policies',
         (select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'room_members') >= 4
  union all select 11, 'rooms has its three policies',
         (select count(*) from pg_policies
           where schemaname = 'public' and tablename = 'rooms') >= 3

  -- Functions --------------------------------------------------------------
  union all select 12, 'function is_room_member() exists',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'is_room_member')
  union all select 13, 'function create_room() exists',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'create_room')
  union all select 14, 'function join_room() exists',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'join_room')
  union all select 15, 'function touch_membership() exists',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'touch_membership')
  union all select 16, 'function purge_expired_clipboard_events() exists',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'purge_expired_clipboard_events')

  -- The pairing RPCs must be SECURITY DEFINER to read rooms past RLS -------
  union all select 17, 'join_room is SECURITY DEFINER',
         coalesce((select bool_and(p.prosecdef) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'join_room'), false)

  -- Realtime ---------------------------------------------------------------
  union all select 18, 'clipboard_events is published to realtime',
         exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'clipboard_events')
  union all select 19, 'room_members is published to realtime',
         exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'room_members')
)
select
  case when ok then 'PASS' else 'FAIL' end as status,
  check_name
from checks
order by ok asc, sort_key asc;
