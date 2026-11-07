# src/kolo/domain/errors.py

"""Domain errors, no HTTP here."""

class KoloError(Exception):
    code = "kolo_error"
    status = 400
    message = "Something went wrong"

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.message)
        self.message = message or self.message

class RoomNotFound(KoloError):
    code, status, message = "room_not_found", 404, "Room not found"

class RoomExpired(KoloError):
    code, status, message = "room_expired", 410, "Room has expired"

class RoomFull(KoloError):
    code, status, message = "room_full", 409, "Room is full"

class RoomCodeTaken(KoloError):
    code, status, message = "room_code_taken", 409, "Room code is already taken"

class InvalidInput(KoloError):
    code, status, message = "invalid_input", 422, "Invalid input data"

class Unauthorized(KoloError):
    code, status, message = "unauthorized", 401, "Authorization required"

class Forbidden(KoloError):
    code, status, message = "forbidden", 403, "Insufficient permissions"

class RateLimited(KoloError):
    code, status, message = "rate_limited", 429, "Too many requests, please wait a bit"
