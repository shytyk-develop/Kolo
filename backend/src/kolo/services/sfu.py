# src/kolo/services/sfu.py

"""Token for connecting to the LiveKit SFU. The same kind of JWT, but signed with LiveKit's secret."""
from datetime import timedelta

from livekit import api

from kolo.core.config import Settings
from kolo.domain.models import Role, Room


def uses_sfu(settings: Settings, room: Room) -> bool:
    return bool(settings.livekit_url) and room.max_participants > settings.p2p_max_participants


def sfu_token(settings: Settings, room: Room, participant_id: str, name: str, role: Role) -> str:
    grants = api.VideoGrants(
        room_join=True,
        room=room.code,
        can_publish=True,
        can_subscribe=True,
        room_admin=role is Role.HOST,  # the host can mute other participants
    )
    return (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret.get_secret_value())
        .with_identity(participant_id)
        .with_name(name)
        .with_grants(grants)
        # applied when the first token creates the room: a client can enter LiveKit without
        # opening our socket, so PeerSession's capacity check can't stop it
        .with_room_config(api.RoomConfiguration(max_participants=room.max_participants))
        .with_ttl(timedelta(seconds=settings.jwt_ttl_seconds))
        .to_jwt()
    )
