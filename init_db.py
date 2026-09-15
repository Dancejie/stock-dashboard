"""Idempotent PostgreSQL setup; helpers follow the Cowork fastapi-only template."""
import psycopg

def load_db_props(path='db.properties'):
    props = {}
    try:
        with open(path) as f:
            for line in f:
                line=line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k,_,v=line.partition('='); props[k.strip()]=v.strip()
    except FileNotFoundError:
        pass
    return props

SCHEMA = """
CREATE TABLE IF NOT EXISTS stock_users (
    owner_id TEXT PRIMARY KEY, email TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS stock_workspaces (
    owner_id TEXT PRIMARY KEY REFERENCES stock_users(owner_id), revision INTEGER NOT NULL DEFAULT 0,
    payload JSONB NOT NULL DEFAULT '{"watchlist":[],"portfolios":[]}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

def main():
    p=load_db_props()
    if not p.get('db.host'):
        print('[init_db] waiting for runtime db.properties')
        return
    with psycopg.connect(host=p['db.host'],port=int(p['db.port']),dbname=p['db.database'],user=p['db.username'],password=p['db.password']) as conn:
        conn.execute(SCHEMA)
    print('[init_db] ready')

if __name__ == '__main__':
    main()
