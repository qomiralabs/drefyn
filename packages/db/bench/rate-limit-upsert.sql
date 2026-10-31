-- One sign in reservation, as reserveAuthRateWindows sends it: two windows of one bucket.
-- Keys are spread over 1000 values so rows lock as they would for many clients, with some
-- clients sharing a key.
\set k random(1, 1000)
with w as (
  select w as seconds, to_timestamp(floor(extract(epoch from now()) / w) * w) as start
    from unnest('{600,86400}'::int[]) as w)
insert into app.auth_rate_limits as t (bucket, key_hmac, window_start, window_end, count)
select 'email_send', sha256(:k::text::bytea), w.start, w.start + make_interval(secs => w.seconds), 1
  from w
on conflict (bucket, key_hmac, window_start, window_end)
do update set count = least(t.count + 1, 2147483647)
returning extract(epoch from (window_end - window_start))::int as window_seconds, count,
          greatest(1, ceil(extract(epoch from (window_end - now()))))::int as retry_after;
