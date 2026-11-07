# src/kolo/services/events.py

from typing import Protocol


class EventSink(Protocol):
    # analytics/audit events
    def emit(self, event: str, data: dict) -> None: ...

class NullEventSink:
    # does nothing, default in dev
    def emit(self, event: str, data: dict) -> None:
        return None

class RecordingEventSink:
    """For tests: keeps a list of emitted events."""
    
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []
        
    def emit(self, event: str, data: dict) -> None:
        self.events.append((event, data))