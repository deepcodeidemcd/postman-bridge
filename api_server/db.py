import sqlite3
import json
import time
import os
import secrets
from typing import Optional

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "service.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            plan TEXT DEFAULT 'free',
            api_key TEXT UNIQUE NOT NULL,
            quota_used INTEGER DEFAULT 0,
            quota_reset_at INTEGER,
            created_at INTEGER NOT NULL,
            stripe_customer_id TEXT,
            stripe_sub_id TEXT
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            status TEXT DEFAULT 'pending',
            result_json TEXT,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            completed_at INTEGER,
            error TEXT,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS registered_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            email TEXT,
            username TEXT,
            password TEXT,
            postman_url TEXT,
            status TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (job_id) REFERENCES jobs(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    """)
    conn.close()


def generate_api_key():
    return "pmapi_" + secrets.token_hex(24)


def create_user(email: str, password_hash: str) -> dict:
    conn = get_db()
    api_key = generate_api_key()
    now = int(time.time())
    try:
        conn.execute(
            "INSERT INTO users (email, password_hash, api_key, created_at, quota_reset_at) VALUES (?, ?, ?, ?, ?)",
            (email, password_hash, api_key, now, now + 30 * 86400),
        )
        conn.commit()
        user = dict(conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone())
        return user
    finally:
        conn.close()


def get_user_by_api_key(api_key: str) -> Optional[dict]:
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE api_key = ?", (api_key,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_user_by_email(email: str) -> Optional[dict]:
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()
    return dict(row) if row else None


def check_and_reset_quota(user: dict) -> dict:
    conn = get_db()
    now = int(time.time())
    if user["quota_reset_at"] and now > user["quota_reset_at"]:
        from config import PLANS
        quota = PLANS.get(user["plan"], PLANS["free"])["quota_monthly"]
        conn.execute(
            "UPDATE users SET quota_used = 0, quota_reset_at = ? WHERE id = ?",
            (now + 30 * 86400, user["id"]),
        )
        conn.commit()
        user["quota_used"] = 0
    conn.close()
    return user


def can_create_account(user: dict) -> bool:
    from config import PLANS
    user = check_and_reset_quota(user)
    plan = PLANS.get(user["plan"], PLANS["free"])
    return user["quota_used"] < plan["quota_monthly"]


def create_job(user_id: int) -> int:
    conn = get_db()
    now = int(time.time())
    cur = conn.execute(
        "INSERT INTO jobs (user_id, status, created_at) VALUES (?, 'pending', ?)",
        (user_id, now),
    )
    job_id = cur.lastrowid
    # Reserve quota immediately (released on failure)
    conn.execute("UPDATE users SET quota_used = quota_used + 1 WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
    return job_id


def get_pending_job() -> Optional[dict]:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
    ).fetchone()
    if row:
        conn.execute(
            "UPDATE jobs SET status = 'processing', started_at = ? WHERE id = ?",
            (int(time.time()), row["id"]),
        )
        conn.commit()
    conn.close()
    return dict(row) if row else None


def complete_job(job_id: int, status: str, result: dict = None, error: str = None):
    conn = get_db()
    now = int(time.time())
    conn.execute(
        "UPDATE jobs SET status = ?, result_json = ?, error = ?, completed_at = ? WHERE id = ?",
        (status, json.dumps(result) if result else None, error, now, job_id),
    )
    if status == "completed" and result:
        job = dict(conn.execute("SELECT user_id FROM jobs WHERE id = ?", (job_id,)).fetchone())
        if job:
            conn.execute(
                "INSERT INTO registered_accounts (job_id, user_id, email, username, password, postman_url, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (job_id, job["user_id"], result.get("email"), result.get("username"), result.get("password"), result.get("url"), result.get("status"), now),
            )
            conn.execute("UPDATE users SET quota_used = quota_used + 1 WHERE id = ?", (job["user_id"],))
    conn.commit()
    conn.close()


def get_job(job_id: int) -> Optional[dict]:
    conn = get_db()
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_user_jobs(user_id: int, limit: int = 50) -> list:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
        (user_id, limit),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_user_accounts(user_id: int, limit: int = 50) -> list:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM registered_accounts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
        (user_id, limit),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_user_plan(user_id: int, plan: str):
    conn = get_db()
    conn.execute("UPDATE users SET plan = ? WHERE id = ?", (plan, user_id))
    conn.commit()
    conn.close()


def update_user_stripe(user_id: int, customer_id: str = None, sub_id: str = None):
    conn = get_db()
    if customer_id:
        conn.execute("UPDATE users SET stripe_customer_id = ? WHERE id = ?", (customer_id, user_id))
    if sub_id:
        conn.execute("UPDATE users SET stripe_sub_id = ? WHERE id = ?", (sub_id, user_id))
    conn.commit()
    conn.close()
