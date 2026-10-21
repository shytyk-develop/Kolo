# src/kolo/schemas/rooms.py

from datetime import datetime
from pydantic import BaseModel, Field, field_validator
from kolo.domain.models import Role

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

class JoinRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=40)
    host_secret: str | None = Field(default=None, max_length=128)

    @field_validator("display_name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        # strip newlines and collapse multiple spaces into one
        cleaned = " ".join(value.split())
        
        # make sure we aren't getting empty strings or weird invisible characters
        if not cleaned or any(not ch.isprintable() for ch in cleaned):
            raise ValueError("Name contains invalid characters")
            
        return cleaned

class IceServer(BaseModel):
    urls: list[str]
    username: str | None = None
    credential: str | None = None

class JoinResponse(BaseModel):
    token: str
    participant_id: str
    role: Role  # role determines if they are host or guest
    ws_path: str
    expires_in: int
    ice_servers: list[IceServer]  # need this to pass TURN/STUN servers to the frontend for WebRTC

    