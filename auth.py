# auth.py

from datetime import datetime, timedelta
import secrets
import uuid

from flask import (
    Blueprint,
    request,
    jsonify,
    make_response
)

from database import db
from models import User, Session
from extensions import bcrypt


auth = Blueprint(
    "auth",
    __name__
)


@auth.route("/register", methods=["POST"])
def register():

    data = request.get_json()

    if not data:
        return jsonify({
            "message": "Invalid request body"
        }), 400


    username = data.get("username")
    email = data.get("email")
    password = data.get("password")


    if not username or not email or not password:
        return jsonify({
            "message": "Username, email and password are required"
        }), 400


    existing_user = User.query.filter(
        (User.email == email) |
        (User.username == username)
    ).first()


    if existing_user:
        return jsonify({
            "message": "User already exists"
        }), 400


    password_hash = bcrypt.generate_password_hash(
        password
    ).decode("utf-8")


    user = User(
        username=username,
        email=email,
        password_hash=password_hash
    )


    db.session.add(user)
    db.session.commit()


    return jsonify({
        "message": "User registered successfully"
    }), 201



@auth.route("/login", methods=["POST"])
def login():

    data = request.get_json()

    if not data:
        return jsonify({
            "message": "Invalid request body"
        }), 400


    email = data.get("email")
    password = data.get("password")


    if not email or not password:
        return jsonify({
            "message": "Email and password are required"
        }), 400


    user = User.query.filter_by(
        email=email
    ).first()


    if not user:
        return jsonify({
            "message": "Invalid credentials"
        }), 401


    password_correct = bcrypt.check_password_hash(
        user.password_hash,
        password
    )


    if not password_correct:
        return jsonify({
            "message": "Invalid credentials"
        }), 401


    # Create server-side session

    session = Session(
        session_id=str(uuid.uuid4()),
        user_id=user.id,
        expires_at=datetime.utcnow() + timedelta(days=7)
    )


    db.session.add(session)
    db.session.commit()


    response = make_response(
        jsonify({
            "message": "Login successful",
            "user": {
                "id": user.id,
                "username": user.username,
                "email": user.email
            }
        })
    )


    response.set_cookie(
        key="session_id",
        value=str(session.session_id),
        httponly=True,
        secure=False,      # Change to True when using HTTPS
        samesite="Lax",
        max_age=7 * 24 * 60 * 60
    )


    return response, 200



@auth.route("/logout", methods=["POST"])
def logout():

    session_id = request.cookies.get(
        "session_id"
    )


    if session_id:

        session = Session.query.filter_by(
            session_id=session_id
        ).first()


        if session:
            db.session.delete(session)
            db.session.commit()


    response = make_response(
        jsonify({
            "message": "Logout successful"
        })
    )


    response.delete_cookie(
        "session_id"
    )


    return response, 200



@auth.route("/me", methods=["GET"])
def me():

    session_id = request.cookies.get(
        "session_id"
    )


    if not session_id:
        return jsonify({
            "message": "Not authenticated"
        }), 401


    session = Session.query.filter_by(
        session_id=session_id
    ).first()


    if not session:
        return jsonify({
            "message": "Invalid session"
        }), 401


    if session.expires_at < datetime.utcnow():

        db.session.delete(session)
        db.session.commit()

        return jsonify({
            "message": "Session expired"
        }), 401


    user = session.user


    return jsonify({
        "id": user.id,
        "username": user.username,
        "email": user.email
    }), 200

