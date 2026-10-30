"""Signaling protocol: what messages the client can throw at us over WebSockets."""
from typing import Annotated, Literal

from pydantic import BaseModel, Field, TypeAdapter

PeerId = Annotated[str, Field(min_length=3, max_length=40)]

class OfferMessage(BaseModel):
    type: Literal["offer"]
    to: PeerId
    sdp: str = Field(max_length=32_000)

class AnswerMessage(BaseModel):
    type: Literal["answer"]
    to: PeerId
    sdp: str = Field(max_length=32_000)

class IceMessage(BaseModel):
    type: Literal["ice"]
    to: PeerId
    candidate: dict | None  # None means "we are out of candidates"

class ChatMessage(BaseModel):
    type: Literal["chat"]
    text: str = Field(min_length=1, max_length=2000)

class MediaStateMessage(BaseModel):
    type: Literal["media-state"]
    audio: bool
    video: bool

class AdmitMessage(BaseModel):
    type: Literal["admit"]
    peer_id: PeerId

class DenyMessage(BaseModel):
    type: Literal["deny"]
    peer_id: PeerId

class PingMessage(BaseModel):
    type: Literal["ping"]

# Bundle them all up into a single union type so Pydantic can figure out 
# which model to use based on the "type" discriminator field
ClientMessage = Annotated[
    OfferMessage | AnswerMessage | IceMessage | ChatMessage | MediaStateMessage
    | AdmitMessage | DenyMessage | PingMessage,
    Field(discriminator="type"),
]

client_message_adapter: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)