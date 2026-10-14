-- Desk Puzzle: each school picks the color of its "Submitted to ..." pill.
--
-- What this sets up, in plain English:
--   * schools.color  a #rrggbb color for the school's pill on category cards.
--                    New schools start slate grey; CMSRU starts crimson.
--   * set_school_color(school, color)  the only way to change it. The school's
--                    lead or the site owner may; admins and faculty may not.
--                    (Leads can't edit the schools table directly; that stays
--                    the owner's, for names and status.)
--
-- Members already read every school's row, so every pill shows its own color.
-- The public key still can't read the schools table, and active_schools() (the
-- Studio's school list) still gives only slug and name.
-- Safe on the live database: adds one column with a default, changes no rows
-- except CMSRU's color.

alter table public.schools
  add column if not exists color text not null default '#4a5568';
alter table public.schools drop constraint if exists schools_color_hex;
alter table public.schools
  add constraint schools_color_hex check (color ~ '^#[0-9a-f]{6}$');

update public.schools set color = '#9e1b32' where slug = 'cmsru' and color = '#4a5568';

create or replace function public.set_school_color(p_school text, p_color text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  c text := lower(btrim(coalesce(p_color, '')));
begin
  if not private.can_manage_people(p_school) then
    raise exception 'Only this school''s lead or the site owner can change its color' using errcode = '42501';
  end if;
  if c !~ '^#[0-9a-f]{6}$' then
    raise exception 'Pick a color like #9e1b32' using errcode = '22023';
  end if;
  update public.schools set color = c where slug = p_school;
  if not found then
    raise exception 'No such school' using errcode = 'P0002';
  end if;
  return c;
end;
$$;

revoke all on function public.set_school_color(text, text) from public, anon;
grant execute on function public.set_school_color(text, text) to authenticated;
