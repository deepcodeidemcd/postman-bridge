import asyncio
import sys
import os
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def run_worker_thread():
    from worker import worker_loop
    loop = asyncio.new_event_loop()
    loop.run_until_complete(worker_loop())


def main():
    print("[MAIN] Starting Postman Enterprise API Service...")
    print("[MAIN] API: http://0.0.0.0:8000")
    print("[MAIN] Dashboard: http://localhost:8000/api/dashboard")

    t = threading.Thread(target=run_worker_thread, daemon=True)
    t.start()

    import uvicorn
    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=False)


if __name__ == "__main__":
    main()
