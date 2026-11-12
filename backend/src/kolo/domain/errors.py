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

class TelegramDisabled(KoloError):
    code, status, message = "telegram_disabled", 503, "Telegram invites aren't set up on this server"

class TelegramNotLinked(KoloError):
    code, status, message = "telegram_not_linked", 401, "Connect Telegram first"

class TelegramUnavailable(KoloError):
    code, status, message = "telegram_unavailable", 503, "Telegram isn't answering. Try again in a moment."

class LinkNotFound(KoloError):
    code, status, message = "link_not_found", 404, "This Telegram link has expired. Start again."

# started in another browser: no kolo_tg_link cookie here
class LinkElsewhere(KoloError):
    code, status, message = "link_other_browser", 403, "Open Kolo in the browser where you pressed Connect"

class InviteRateLimited(KoloError):
    code, status, message = "invite_rate_limited", 429, "Too many invites, try again later"

    def __init__(self, retry_after: int = 60) -> None:
        super().__init__()
        self.retry_after = retry_after
