from functools import wraps
from datetime import datetime

from flask import request, jsonify, g

from models import Session


def login_required(func):

    @wraps(func)
    def wrapper(*args, **kwargs):

        session_id = request.cookies.get(
            "session_id"
        )

        if not session_id:
            return jsonify({
                "message": "Authentication required"
            }), 401


        session = Session.query.filter_by(
            session_id=session_id
        ).first()


        if not session:
            return jsonify({
                "message": "Invalid session"
            }), 401


        if session.expires_at < datetime.utcnow():

            return jsonify({
                "message": "Session expired"
            }), 401


        g.user = session.user

        return func(*args, **kwargs)


    return wrapper

