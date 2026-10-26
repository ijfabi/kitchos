-- Local development only. The application connects as kitchos_app, which does
-- NOT own any table and does NOT have BYPASSRLS, so row-level security applies.
CREATE ROLE kitchos_app LOGIN PASSWORD 'kitchos_app_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE kitchos TO kitchos_app;
