import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "voltroute-secret-key-2026-production")

    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL", "sqlite:///ev_charging.db")

    GOOGLE_MAPS_KEY = os.getenv("GOOGLE_MAPS_KEY", "")

    SQLALCHEMY_TRACK_MODIFICATIONS = False

    SESSION_COOKIE_HTTPONLY = True

    SESSION_COOKIE_SAMESITE = "Lax"

    # Enable this when using HTTPSkj
    SESSION_COOKIE_SECURE = False

    # Configurable EV & Recommendation Defaults
    DEFAULT_SAFETY_MARGIN_PERCENT = float(os.getenv("DEFAULT_SAFETY_MARGIN_PERCENT", "15.0"))
    DEFAULT_BATTERY_CAPACITY_KWH = float(os.getenv("DEFAULT_BATTERY_CAPACITY_KWH", "60.0"))
    DEFAULT_EFFICIENCY_KM_PER_KWH = float(os.getenv("DEFAULT_EFFICIENCY_KM_PER_KWH", "5.5"))

    # Configurable Urgency Thresholds
    URGENCY_CRITICAL_THRESHOLD = float(os.getenv("URGENCY_CRITICAL_THRESHOLD", "80.0"))
    URGENCY_HIGH_THRESHOLD = float(os.getenv("URGENCY_HIGH_THRESHOLD", "60.0"))
    URGENCY_MODERATE_THRESHOLD = float(os.getenv("URGENCY_MODERATE_THRESHOLD", "30.0"))

    # Configurable Forecasting Parameters
    ARIMA_ORDER_P = int(os.getenv("ARIMA_ORDER_P", "1"))
    ARIMA_ORDER_D = int(os.getenv("ARIMA_ORDER_D", "1"))
    ARIMA_ORDER_Q = int(os.getenv("ARIMA_ORDER_Q", "1"))
    MIN_OBSERVATIONS_FOR_ARIMA = int(os.getenv("MIN_OBSERVATIONS_FOR_ARIMA", "15"))

    # Reward system rate (points awarded per minute of wait-time reduction)
    REWARD_POINTS_PER_MIN_SAVED = float(os.getenv("REWARD_POINTS_PER_MIN_SAVED", "2.0"))
