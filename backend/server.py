import os
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pymongo import MongoClient
from bson import ObjectId
from pydantic import BaseModel
from typing import Optional
import random

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "flashbot_dashboard")

client = MongoClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="FlashBot Dashboard API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def serialize_doc(doc):
    if doc is None:
        return None
    doc["id"] = str(doc.pop("_id"))
    return doc


def serialize_docs(docs):
    return [serialize_doc(d) for d in docs]


# ---- Models ----
class SettingsUpdate(BaseModel):
    max_gas_price_gwei: Optional[float] = None
    min_profit_threshold: Optional[float] = None
    max_flash_loan_amount: Optional[float] = None
    slippage_buffer: Optional[float] = None
    scan_interval_ms: Optional[int] = None
    scan_amount: Optional[str] = None
    profit_threshold: Optional[float] = None
    z_score_threshold: Optional[float] = None
    bot_active: Optional[bool] = None


# ---- Seed Data ----
def seed_initial_data():
    if db.settings.count_documents({}) == 0:
        db.settings.insert_one({
            "max_gas_price_gwei": 0.1,
            "min_profit_threshold": 0.001,
            "max_flash_loan_amount": 100.0,
            "slippage_buffer": 0.001,
            "scan_interval_ms": 4000,
            "scan_amount": "1",
            "profit_threshold": 0.4,
            "z_score_threshold": 2.5,
            "bot_active": True,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })

    if db.bot_status.count_documents({}) == 0:
        db.bot_status.insert_one({
            "status": "idle",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "last_scan_at": datetime.now(timezone.utc).isoformat(),
            "scans_count": 0,
            "paths_loaded": 0,
            "wallet_address": "Not Connected",
            "wallet_balance_eth": "0.0",
            "network": "base",
            "uptime_seconds": 0,
        })

    if db.opportunities.count_documents({}) == 0:
        tokens = ["WETH", "USDC", "USDbC", "DAI", "cbETH", "AERO", "DEGEN", "BRETT"]
        dexes = ["Uniswap V3", "Aerodrome", "PancakeSwap", "Odos"]
        sample_opps = []
        for i in range(15):
            t1, t2, t3 = random.sample(tokens, 3)
            profit = round(random.uniform(0.001, 0.5), 4)
            sample_opps.append({
                "detected_at": (datetime.now(timezone.utc) - timedelta(minutes=random.randint(1, 120))).isoformat(),
                "path": f"{t1} -> {t2} -> {t3} -> {t1}",
                "dexes": f"{random.choice(dexes)} / {random.choice(dexes)}",
                "flash_loan_asset": t1,
                "flash_loan_amount": str(round(random.uniform(1, 50), 2)),
                "estimated_profit": str(profit),
                "estimated_profit_usd": str(round(profit * 2500, 2)),
                "gas_cost_estimate": str(round(random.uniform(0.0001, 0.005), 5)),
                "status": random.choice(["detected", "evaluating", "expired", "profitable"]),
                "net_profit": str(round(profit - random.uniform(0.0001, 0.002), 4)),
            })
        db.opportunities.insert_many(sample_opps)

    if db.trades.count_documents({}) == 0:
        tokens = ["WETH", "USDC", "USDbC", "DAI", "cbETH"]
        sample_trades = []
        for i in range(10):
            t1, t2, t3 = random.sample(tokens, 3)
            profit = round(random.uniform(-0.01, 0.3), 4)
            sample_trades.append({
                "executed_at": (datetime.now(timezone.utc) - timedelta(hours=random.randint(1, 72))).isoformat(),
                "path": f"{t1} -> {t2} -> {t3} -> {t1}",
                "flash_loan_amount": str(round(random.uniform(1, 50), 2)),
                "profit": str(profit),
                "profit_usd": str(round(profit * 2500, 2)),
                "gas_cost": str(round(random.uniform(0.0001, 0.003), 5)),
                "tx_hash": f"0x{''.join(random.choices('abcdef0123456789', k=64))}",
                "status": "success" if profit > 0 else "reverted",
                "block_number": random.randint(25000000, 26000000),
            })
        db.trades.insert_many(sample_trades)

    if db.bot_logs.count_documents({}) == 0:
        levels = ["INFO", "WARN", "ERROR", "PROFIT", "SCAN"]
        messages = [
            "Bot started successfully",
            "Loaded 1247 arbitrage paths",
            "Fetched 23 flash loanable assets from Aave V3",
            "Scanning path: WETH -> USDC -> DAI -> WETH",
            "No profitable opportunity on current scan",
            "Detected opportunity: 0.0234 WETH profit",
            "Transaction simulation successful",
            "Sent transaction: 0xabc123...",
            "Transaction confirmed in block 25123456",
            "Profit realized: 0.0234 WETH ($58.50)",
            "RPC fallback activated: switching to backup node",
            "Gas price spike detected: 0.08 gwei -> pausing",
            "Resuming scans after gas cooldown",
            "Token database refreshed: 342 tokens",
            "Z-score alert: WETH/USDC deviation at 2.7",
        ]
        sample_logs = []
        for i in range(30):
            sample_logs.append({
                "timestamp": (datetime.now(timezone.utc) - timedelta(seconds=random.randint(1, 3600))).isoformat(),
                "level": random.choice(levels),
                "message": random.choice(messages),
            })
        sample_logs.sort(key=lambda x: x["timestamp"])
        db.bot_logs.insert_many(sample_logs)


seed_initial_data()


# ---- API Routes ----

@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "FlashBot Dashboard"}


@app.get("/api/status")
async def get_status():
    status = db.bot_status.find_one({}, {"_id": 0})
    if not status:
        return {"status": "unknown"}
    return status


@app.put("/api/status")
async def update_status(data: dict):
    db.bot_status.update_one({}, {"$set": data}, upsert=True)
    return {"ok": True}


@app.get("/api/opportunities")
async def get_opportunities(limit: int = 50, status: str = None):
    query = {}
    if status:
        query["status"] = status
    opps = list(db.opportunities.find(query, {"_id": 0}).sort("detected_at", -1).limit(limit))
    return {"opportunities": opps, "count": len(opps)}


@app.get("/api/trades")
async def get_trades(limit: int = 50):
    trades = list(db.trades.find({}, {"_id": 0}).sort("executed_at", -1).limit(limit))
    return {"trades": trades, "count": len(trades)}


@app.get("/api/logs")
async def get_logs(limit: int = 100, level: str = None):
    query = {}
    if level:
        query["level"] = level
    logs = list(db.bot_logs.find(query, {"_id": 0}).sort("timestamp", -1).limit(limit))
    return {"logs": logs, "count": len(logs)}


@app.get("/api/settings")
async def get_settings():
    settings = db.settings.find_one({}, {"_id": 0})
    if not settings:
        raise HTTPException(status_code=404, detail="Settings not found")
    return settings


@app.put("/api/settings")
async def update_settings(data: SettingsUpdate):
    update_data = {k: v for k, v in data.dict().items() if v is not None}
    update_data["updated_at"] = datetime.now(timezone.utc).isoformat()
    db.settings.update_one({}, {"$set": update_data}, upsert=True)
    return db.settings.find_one({}, {"_id": 0})


@app.get("/api/stats")
async def get_stats():
    trades = list(db.trades.find({}, {"_id": 0}))
    total_trades = len(trades)
    successful = [t for t in trades if t.get("status") == "success"]
    win_rate = (len(successful) / total_trades * 100) if total_trades > 0 else 0

    total_profit = sum(float(t.get("profit", 0)) for t in successful)
    total_profit_usd = sum(float(t.get("profit_usd", 0)) for t in successful)
    total_gas = sum(float(t.get("gas_cost", 0)) for t in trades)

    best_trade = max(successful, key=lambda t: float(t.get("profit", 0)), default=None)
    worst_trade = min(trades, key=lambda t: float(t.get("profit", 0)), default=None)

    opp_count = db.opportunities.count_documents({})
    profitable_opp_count = db.opportunities.count_documents({"status": "profitable"})

    return {
        "total_trades": total_trades,
        "successful_trades": len(successful),
        "win_rate": round(win_rate, 1),
        "total_profit_eth": round(total_profit, 6),
        "total_profit_usd": round(total_profit_usd, 2),
        "total_gas_spent": round(total_gas, 6),
        "net_profit_eth": round(total_profit - total_gas, 6),
        "best_trade_profit": best_trade.get("profit", "0") if best_trade else "0",
        "best_trade_path": best_trade.get("path", "N/A") if best_trade else "N/A",
        "worst_trade_profit": worst_trade.get("profit", "0") if worst_trade else "0",
        "total_opportunities_detected": opp_count,
        "profitable_opportunities": profitable_opp_count,
        "avg_profit_per_trade": round(total_profit / len(successful), 6) if successful else 0,
    }


@app.post("/api/logs")
async def add_log(data: dict):
    data["timestamp"] = datetime.now(timezone.utc).isoformat()
    db.bot_logs.insert_one(data)
    return {"ok": True}


@app.delete("/api/logs")
async def clear_logs():
    db.bot_logs.delete_many({})
    return {"ok": True, "message": "Logs cleared"}


@app.post("/api/opportunities")
async def add_opportunity(data: dict):
    data["detected_at"] = datetime.now(timezone.utc).isoformat()
    db.opportunities.insert_one(data)
    return {"ok": True}


@app.post("/api/trades")
async def add_trade(data: dict):
    data["executed_at"] = datetime.now(timezone.utc).isoformat()
    db.trades.insert_one(data)
    return {"ok": True}
