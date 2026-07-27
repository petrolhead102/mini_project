import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY")

    SQLALCHEMY_DATABASE_URI = os.getenv("DATABASE_URL")

    GOOGLE_MAPS_KEY = os.getenv("GOOGLE_MAPS_KEY")

    SQLALCHEMY_TRACK_MODIFICATIONS = False

    SESSION_COOKIE_HTTPONLY = True

    SESSION_COOKIE_SAMESITE = "Lax"

    # Enable this when using HTTPS
    SESSION_COOKIE_SECURE = False

