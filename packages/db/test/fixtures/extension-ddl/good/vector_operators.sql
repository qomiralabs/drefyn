-- Up Migration
select '[1,0]'::extensions.vector operator(extensions.<=>) '[0,1]'::extensions.vector;
select '[1,0]'::vector <=> '[0,1]'::vector;

-- Down Migration
select 1;
