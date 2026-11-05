-- One row per recurring job. Whichever server locks the row while it is due does the work, in
-- that same transaction, so several servers cannot run a job twice and a failed or killed run
-- rolls back to still due. No organization: a job spans them and the row holds only times.

-- Up Migration
create table app.scheduled_jobs (
  name text primary key check (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz
);

alter table app.scheduled_jobs enable row level security;

revoke all on app.scheduled_jobs from drefyn_app;
grant select, update on app.scheduled_jobs to drefyn_auth;

create policy auth_access on app.scheduled_jobs to drefyn_auth using (true) with check (true);

-- Before force, because the owner matches no policy. The auth role cannot insert, so a job
-- exists only if a migration says so.
insert into app.scheduled_jobs (name) values ('auth_expiry');

alter table app.scheduled_jobs force row level security;

-- Down Migration
drop table app.scheduled_jobs;
