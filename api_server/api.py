import time
import secrets
import hashlib
import hmac
import json

from fastapi import FastAPI, HTTPException, Depends, Header, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr
from typing import Optional
import uvicorn

from config import PLANS, STRIPE_SECRET, STRIPE_WEBHOOK, SECRET_KEY
from db import (
    init_db, create_user, get_user_by_api_key, get_user_by_email,
    can_create_account, create_job, get_job, get_user_jobs,
    get_user_accounts, update_user_plan, update_user_stripe,
    check_and_reset_quota, get_db,
)

app = FastAPI(title="Postman Enterprise Registration API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def hash_password(pw: str) -> str:
    return hashlib.sha256((SECRET_KEY + pw).encode()).hexdigest()


def verify_password(pw: str, h: str) -> bool:
    return hmac.compare_digest(hash_password(pw), h)


def auth_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing API key. Use header: Authorization: Bearer pmapi_xxx")
    key = authorization.replace("Bearer ", "").strip()
    user = get_user_by_api_key(key)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid API key")
    user = check_and_reset_quota(user)
    return user


class RegisterRequest(BaseModel):
    pass


class SignupRequest(BaseModel):
    email: EmailStr
    password: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UpgradeRequest(BaseModel):
    plan: str


@app.on_event("startup")
def startup():
    init_db()
    print("[API] Database initialized")


@app.get("/api/health")
def health():
    return {"status": "ok", "time": int(time.time())}


@app.post("/api/auth/signup")
def auth_signup(req: SignupRequest):
    if get_user_by_email(req.email):
        raise HTTPException(status_code=400, detail="Email already registered")
    user = create_user(req.email, hash_password(req.password))
    return {"api_key": user["api_key"], "email": user["email"], "plan": user["plan"]}


@app.post("/api/auth/login")
def auth_login(req: LoginRequest):
    user = get_user_by_email(req.email)
    if not user or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    return {"api_key": user["api_key"], "email": user["email"], "plan": user["plan"]}


@app.get("/api/account/me")
def account_me(user: dict = Depends(auth_user)):
    plan_info = PLANS.get(user["plan"], PLANS["free"])
    return {
        "email": user["email"],
        "plan": user["plan"],
        "quota_used": user["quota_used"],
        "quota_total": plan_info["quota_monthly"],
        "quota_remaining": plan_info["quota_monthly"] - user["quota_used"],
    }


@app.post("/api/enterprise/register")
def register_enterprise(user: dict = Depends(auth_user)):
    if not can_create_account(user):
        plan = PLANS.get(user["plan"], PLANS["free"])
        raise HTTPException(
            status_code=429,
            detail=f"Monthly quota exceeded ({plan['quota_monthly']}). Upgrade plan or wait for reset."
        )
    job_id = create_job(user["id"])
    return {"job_id": job_id, "status": "pending", "message": "Registration job queued"}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: int, user: dict = Depends(auth_user)):
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["user_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Not your job")
    result = None
    if job.get("result_json"):
        try:
            result = json.loads(job["result_json"])
        except Exception:
            result = job["result_json"]
    return {
        "job_id": job["id"],
        "status": job["status"],
        "result": result,
        "error": job.get("error"),
        "created_at": job["created_at"],
        "completed_at": job.get("completed_at"),
    }


@app.get("/api/accounts")
def list_accounts(user: dict = Depends(auth_user), limit: int = 50):
    accounts = get_user_accounts(user["id"], limit)
    return {"accounts": accounts, "total": len(accounts)}


@app.get("/api/plans")
def list_plans():
    return {"plans": {k: {**v, "price_stripe": None} for k, v in PLANS.items()}}


@app.post("/api/upgrade")
def upgrade_plan(req: UpgradeRequest, user: dict = Depends(auth_user)):
    if req.plan not in PLANS:
        raise HTTPException(status_code=400, detail=f"Unknown plan: {req.plan}. Available: {list(PLANS.keys())}")
    if STRIPE_SECRET:
        return {
            "message": "Stripe checkout URL",
            "checkout_url": f"/api/stripe/checkout?plan={req.plan}",
        }
    else:
        update_user_plan(user["id"], req.plan)
        return {"message": f"Plan upgraded to {req.plan} (demo mode)", "plan": req.plan}


@app.get("/api/stripe/checkout")
def stripe_checkout(plan: str, user: dict = Depends(auth_user)):
    if not STRIPE_SECRET:
        raise HTTPException(status_code=500, detail="Stripe not configured")
    import stripe
    stripe.api_key = STRIPE_SECRET
    session = stripe.checkout.Session.create(
        mode="subscription",
        line_items=[{"price": PLANS[plan]["price_stripe"], "quantity": 1}],
        success_url="https://your-domain.com/dashboard?session_id={CHECKOUT_SESSION_ID}",
        cancel_url="https://your-domain.com/dashboard",
        metadata={"user_id": user["id"], "plan": plan},
    )
    return {"url": session.url}


@app.post("/api/stripe/webhook")
async def stripe_webhook(request: Request):
    if not STRIPE_SECRET or not STRIPE_WEBHOOK:
        raise HTTPException(status_code=500, detail="Stripe not configured")
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    import stripe
    stripe.api_key = STRIPE_SECRET
    event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK)

    if event["type"] == "checkout.session.completed":
        user_id = event["data"]["object"]["metadata"]["user_id"]
        plan = event["data"]["object"]["metadata"]["plan"]
        customer_id = event["data"]["object"].get("customer")
        sub_id = event["data"]["object"].get("subscription")
        update_user_plan(int(user_id), plan)
        update_user_stripe(int(user_id), customer_id, sub_id)

    return {"received": True}


@app.get("/api/dashboard", response_class=HTMLResponse)
def dashboard():
    return """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Postman Enterprise API</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; }
        .container { max-width: 800px; margin: 0 auto; padding: 40px 20px; }
        h1 { color: #ff6c37; margin-bottom: 10px; font-size: 28px; }
        .subtitle { color: #888; margin-bottom: 30px; }
        .card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 24px; margin-bottom: 16px; }
        .card h2 { font-size: 16px; margin-bottom: 12px; color: #ff6c37; }
        pre { background: #0d0d0d; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 13px; color: #aaa; border: 1px solid #333; }
        code { color: #ff6c37; }
        .form-group { margin-bottom: 12px; }
        label { display: block; margin-bottom: 4px; color: #888; font-size: 13px; }
        input { width: 100%; padding: 10px; background: #0d0d0d; border: 1px solid #333; border-radius: 4px; color: #e0e0e0; font-size: 14px; }
        button { background: #ff6c37; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 14px; }
        button:hover { background: #e55a28; }
        button:disabled { background: #555; cursor: not-allowed; }
        .result { margin-top: 12px; padding: 12px; border-radius: 4px; font-size: 13px; display: none; }
        .result.success { display: block; background: #0a2a0a; border: 1px solid #2a5a2a; color: #4a4; }
        .result.error { display: block; background: #2a0a0a; border: 1px solid #5a2a2a; color: #a44; }
        .tabs { display: flex; gap: 4px; margin-bottom: 16px; }
        .tab { padding: 8px 16px; border-radius: 4px; background: #1a1a1a; border: 1px solid #333; cursor: pointer; color: #888; }
        .tab.active { background: #ff6c37; color: white; border-color: #ff6c37; }
        .endpoint { color: #4a4; font-weight: bold; }
        .method { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold; margin-right: 6px; }
        .get { background: #1a3a1a; color: #4a4; }
        .post { background: #3a2a1a; color: #a84; }
        .jobs-list { max-height: 300px; overflow-y: auto; }
        .job-item { padding: 8px; border-bottom: 1px solid #222; font-size: 13px; }
        .job-item .status { padding: 2px 8px; border-radius: 10px; font-size: 11px; }
        .status-pending { background: #3a3a1a; color: #aa4; }
        .status-processing { background: #1a3a3a; color: #4aa; }
        .status-completed { background: #1a3a1a; color: #4a4; }
        .status-failed { background: #3a1a1a; color: #a44; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Postman Enterprise Registration API</h1>
        <p class="subtitle">Automated Postman Enterprise Trial Registration Service</p>

        <div class="card">
            <h2>Quick Start</h2>
            <p style="color: #888; font-size: 14px; margin-bottom: 12px;">1. Sign up to get your API key</p>
            <pre><code># Sign up
curl -X POST https://your-domain.com/api/auth/signup \\
  -H "Content-Type: application/json" \\
  -d '{"email": "you@example.com", "password": "yourpass"}'</code></pre>
            <p style="color: #888; font-size: 14px; margin-bottom: 12px;">2. Create an Enterprise account</p>
            <pre><code># Register Postman Enterprise account
curl -X POST https://your-domain.com/api/enterprise/register \\
  -H "Authorization: Bearer pmapi_your_key_here"</code></pre>
            <p style="color: #888; font-size: 14px; margin-bottom: 12px;">3. Poll job status until complete</p>
            <pre><code># Check job status
curl https://your-domain.com/api/jobs/123 \\
  -H "Authorization: Bearer pmapi_your_key_here"</code></pre>
            <p style="color: #888; font-size: 14px;">4. View registered accounts</p>
            <pre><code># List your accounts
curl https://your-domain.com/api/accounts \\
  -H "Authorization: Bearer pmapi_your_key_here"</code></pre>
        </div>

        <div class="card">
            <h2>Plans</h2>
            <table style="width:100%; font-size: 14px;">
                <tr style="color: #888;"><td>Plan</td><td>Price</td><td>Accounts/mo</td></tr>
                <tr><td>Free</td><td>$0</td><td>1</td></tr>
                <tr><td>Starter</td><td>$9/mo</td><td>10</td></tr>
                <tr><td>Pro</td><td>$29/mo</td><td>50</td></tr>
                <tr><td>Enterprise</td><td>$99/mo</td><td>Unlimited</td></tr>
            </table>
        </div>

        <div class="card">
            <h2>API Reference</h2>
            <p style="margin-bottom: 12px;">
                <span class="method post">POST</span>
                <span class="endpoint">/api/auth/signup</span> — Create API account
            </p>
            <p style="margin-bottom: 12px;">
                <span class="method post">POST</span>
                <span class="endpoint">/api/auth/login</span> — Get API key
            </p>
            <p style="margin-bottom: 12px;">
                <span class="method get">GET</span>
                <span class="endpoint">/api/account/me</span> — Your plan & quota
            </p>
            <p style="margin-bottom: 12px;">
                <span class="method post">POST</span>
                <span class="endpoint">/api/enterprise/register</span> — Create Postman Enterprise account
            </p>
            <p style="margin-bottom: 12px;">
                <span class="method get">GET</span>
                <span class="endpoint">/api/jobs/{id}</span> — Poll job status
            </p>
            <p style="margin-bottom: 12px;">
                <span class="method get">GET</span>
                <span class="endpoint">/api/accounts</span> — List registered accounts
            </p>
            <p>
                <span class="method post">POST</span>
                <span class="endpoint">/api/upgrade</span> — Upgrade subscription plan
            </p>
        </div>
    </div>
</body>
</html>"""


if __name__ == "__main__":
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)
