# src/kolo/schemas/rooms.py

from datetime import datetime
from pydantic import BaseModel, Field

class CreateRoomRequest(BaseModel):
    name: str | None = Field(default=None, max_length=80)
    max_participants: int | None = Field(default=None, ge=2, le=50)
    lobby_enabled: bool = False

class RoomCreatedResponse(BaseModel):
    code: str
    name: str
    join_url: str
    host_secret: str = Field(description="Show to the creator once, they use it to become host")
    max_participants: int
    lobby_enabled: bool
    expires_at: datetime

class RoomPublicResponse(BaseModel):
    code: str
    name: str
    max_participants: int
    lobby_enabled: bool