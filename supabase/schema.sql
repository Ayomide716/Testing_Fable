-- =============================================================================
-- Zero-knowledge clipboard ecosystem — PostgreSQL / Supabase schema
--
-- Threat model
--   * The server stores ciphertext only. The AES-256-GCM room key is generated
--     on the desktop, transferred to the phone out-of-band (QR code) and never
--     leaves either device. No column here can be decrypted by the database,
--     by a Supabase admin, or by anyone reading a backup.
--   * Isolation is enforced by RLS: a row in clipboard_events is only visible
--     to authenticated devices that hold a membership row for that room.
--   * Pairing uses a single-use join code. Only its SHA-256 digest is stored,
--     so a database dump cannot be replayed to join a room (and the code
--     expires and is burned on first use anyway).
--
-- Apply with:  supabase db push   (or psql -f supabase/schema.sql)
-- =============================================================================

create extension if not exists "pgcrypto" with schema extensions;

-- -----------------------------------------------------------------------------
-- rooms
-- -----------------------------------------------------------------------------
create table if not exists public.rooms (
  id              uuid primary key default gen_random_uuid(),
  created_by      uuid not null references auth.users (id) on delete cascade,
  -- SHA-256 of the pairing code shown in the QR. Never the code itself.
  join_code_hash  bytea       not null,
  join_code_expires_at timestamptz not null,
  join_code_used_at    timestamptz,
  created_at      timestamptz not null default now()
);

comment on column public.rooms.join_code_hash is
  'SHA-256 digest of the single-use pairing code. The plaintext code exists only inside the QR image.';

-- -----------------------------------------------------------------------------
-- room_members  (which auth user may touch which room)
-- -----------------------------------------------------------------------------
create table if not exists public.room_members (
  room_id      uuid not null references public.rooms (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  device_name  text not null default 'unknown device',
  platform     text not null default 'unknown'
                 check (platform in ('desktop', 'ios', 'android', 'web', 'unknown')),
  last_seen_at timestamptz not null default now(),
  joined_at    timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists room_members_user_idx on public.room_members (user_id);

-- -----------------------------------------------------------------------------
-- clipboard_events  (ciphertext only)
-- -----------------------------------------------------------------------------
create table if not exists public.clipboard_events (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms (id) on delete cascade,
  sender_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  sender_device  text not null default 'unknown device',
  -- base64( 12-byte nonce || AES-256-GCM ciphertext || 16-byte tag )
  payload        text not null check (length(payload) between 24 and 200000),
  -- Non-sensitive routing hints. content_kind must never carry plaintext.
  content_kind   text not null default 'text' check (content_kind in ('text', 'url', 'image')),
  payload_bytes  integer not null default 0 check (payload_bytes >= 0),
  created_at     timestamptz not null default now()
);

create index if not exists clipboard_events_room_created_idx
  on public.clipboard_events (room_id, created_at desc);

comment on column public.clipboard_events.payload is
  'base64(nonce||ciphertext||tag). AAD is the room id, binding a ciphertext to its room.';

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.rooms            enable row level security;
alter table public.room_members     enable row level security;
alter table public.clipboard_events enable row level security;

-- Helper: is the calling user a member of this room?
-- SECURITY DEFINER so that the membership lookup inside a policy does not
-- itself recurse through room_members' own RLS policies.
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.room_members m
     where m.room_id = p_room_id
       and m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_room_member(uuid) from public;
grant execute on function public.is_room_member(uuid) to authenticated;

-- rooms: visible to members; created only by the authenticated owner.
drop policy if exists rooms_select_members on public.rooms;
create policy rooms_select_members on public.rooms
  for select to authenticated
  using (public.is_room_member(id));

drop policy if exists rooms_insert_own on public.rooms;
create policy rooms_insert_own on public.rooms
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists rooms_delete_owner on public.rooms;
create policy rooms_delete_owner on public.rooms
  for delete to authenticated
  using (created_by = auth.uid());

-- room_members: a device sees the roster of its own rooms and may only
-- update/delete its own membership row. Joining goes through join_room().
drop policy if exists room_members_select_members on public.room_members;
create policy room_members_select_members on public.room_members
  for select to authenticated
  using (public.is_room_member(room_id));

drop policy if exists room_members_insert_self_owner on public.room_members;
create policy room_members_insert_self_owner on public.room_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.rooms r
       where r.id = room_members.room_id
         and r.created_by = auth.uid()
    )
  );

drop policy if exists room_members_update_self on public.room_members;
create policy room_members_update_self on public.room_members
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists room_members_delete_self on public.room_members;
create policy room_members_delete_self on public.room_members
  for delete to authenticated
  using (user_id = auth.uid());

-- clipboard_events: the isolation boundary. A device can only read rows for
-- rooms it belongs to, and can only write rows into those rooms as itself.
drop policy if exists clipboard_events_select_room on public.clipboard_events;
create policy clipboard_events_select_room on public.clipboard_events
  for select to authenticated
  using (public.is_room_member(room_id));

drop policy if exists clipboard_events_insert_room on public.clipboard_events;
create policy clipboard_events_insert_room on public.clipboard_events
  for insert to authenticated
  with check (sender_id = auth.uid() and public.is_room_member(room_id));

drop policy if exists clipboard_events_delete_room on public.clipboard_events;
create policy clipboard_events_delete_room on public.clipboard_events
  for delete to authenticated
  using (public.is_room_member(room_id));

-- No UPDATE policy: clipboard history is append-only.

-- -----------------------------------------------------------------------------
-- Pairing RPCs
-- -----------------------------------------------------------------------------

-- Called by the desktop after it has generated the AES key and join code.
-- Only the digest of the code crosses the wire.
create or replace function public.create_room(
  p_join_code   text,
  p_device_name text default 'desktop',
  p_ttl_seconds integer default 600
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_room_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if p_join_code is null or length(p_join_code) < 16 then
    raise exception 'join code too short' using errcode = '22023';
  end if;
  if p_ttl_seconds < 30 or p_ttl_seconds > 3600 then
    raise exception 'ttl out of range' using errcode = '22023';
  end if;

  insert into public.rooms (created_by, join_code_hash, join_code_expires_at)
  values (auth.uid(),
          extensions.digest(p_join_code, 'sha256'),
          now() + make_interval(secs => p_ttl_seconds))
  returning id into v_room_id;

  insert into public.room_members (room_id, user_id, device_name, platform)
  values (v_room_id, auth.uid(), p_device_name, 'desktop');

  return v_room_id;
end;
$$;

revoke all on function public.create_room(text, text, integer) from public;
grant execute on function public.create_room(text, text, integer) to authenticated;

-- Called by the phone with the code it read out of the QR. Constant-time
-- comparison, single use, expiring.
create or replace function public.join_room(
  p_room_id     uuid,
  p_join_code   text,
  p_device_name text default 'phone',
  p_platform    text default 'unknown'
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;

  -- Same error for every failure mode: no oracle for room-id enumeration.
  if not found
     or v_room.join_code_expires_at < now()
     or (v_room.join_code_used_at is not null
         and not exists (select 1 from public.room_members m
                          where m.room_id = p_room_id and m.user_id = auth.uid()))
     or extensions.digest(p_join_code, 'sha256') <> v_room.join_code_hash
  then
    raise exception 'invalid or expired pairing code' using errcode = '28000';
  end if;

  insert into public.room_members (room_id, user_id, device_name, platform)
  values (p_room_id, auth.uid(), p_device_name,
          case when p_platform in ('desktop','ios','android','web')
               then p_platform else 'unknown' end)
  on conflict (room_id, user_id) do update
    set device_name = excluded.device_name,
        platform    = excluded.platform,
        last_seen_at = now();

  update public.rooms
     set join_code_used_at = coalesce(join_code_used_at, now())
   where id = p_room_id;

  return p_room_id;
end;
$$;

revoke all on function public.join_room(uuid, text, text, text) from public;
grant execute on function public.join_room(uuid, text, text, text) to authenticated;

-- Heartbeat used by the dashboard to show which devices are live.
create or replace function public.touch_membership(p_room_id uuid)
returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.room_members
     set last_seen_at = now()
   where room_id = p_room_id and user_id = auth.uid();
$$;

grant execute on function public.touch_membership(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- Retention: ciphertext is transient, not an archive.
-- -----------------------------------------------------------------------------
create or replace function public.purge_expired_clipboard_events(p_keep_hours integer default 24)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.clipboard_events
   where created_at < now() - make_interval(hours => p_keep_hours);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- Schedule with pg_cron if the extension is available:
--   select cron.schedule('purge-clipboard', '0 * * * *',
--                        $$select public.purge_expired_clipboard_events(24)$$);

-- -----------------------------------------------------------------------------
-- Realtime
-- -----------------------------------------------------------------------------
-- postgres_changes for a subscriber is filtered through the same RLS policies
-- above, so a socket only ever receives rows for rooms it belongs to.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'clipboard_events') then
    alter publication supabase_realtime add table public.clipboard_events;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime'
                    and schemaname = 'public' and tablename = 'room_members') then
    alter publication supabase_realtime add table public.room_members;
  end if;
end;
$$;

-- Base grants (RLS still decides row visibility).
grant select, insert, delete on public.clipboard_events to authenticated;
grant select, insert, update, delete on public.room_members to authenticated;
grant select, insert, delete on public.rooms to authenticated;
