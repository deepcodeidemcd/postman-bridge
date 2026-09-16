import os

SECRET_KEY = os.getenv("SECRET_KEY", "postman-api-service-secret-key-change-in-production")
STRIPE_SECRET = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK = os.getenv("STRIPE_WEBHOOK_SECRET", "")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./accounts.db")
WORKER_INTERVAL = int(os.getenv("WORKER_INTERVAL", "10"))
MAX_CONCURRENT_JOBS = int(os.getenv("MAX_CONCURRENT_JOBS", "3"))

PLANS = {
    "free": {"name": "Free", "price": 0, "quota_monthly": 1, "price_stripe": None},
    "starter": {"name": "Starter", "price": 9, "quota_monthly": 10, "price_stripe": "price_starter_monthly"},
    "pro": {"name": "Pro", "price": 29, "quota_monthly": 50, "price_stripe": "price_pro_monthly"},
    "enterprise": {"name": "Enterprise", "price": 99, "quota_monthly": 9999, "price_stripe": "price_enterprise_monthly"},
}
