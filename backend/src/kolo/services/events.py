# src/kolo/services/events.py (Part 1)

from typing import Protocol


class EventSink(Protocol):
    # interface for firing off analytics or audit events
    def emit(self, event: str, data: dict) -> None: ...

class NullEventSink:
    # dummy sink that just throws events into the void (default for local dev)
    def emit(self, event: str, data: dict) -> None:
        return None

class RecordingEventSink:
    """For unit tests: just keeps a list of what got emitted so we can assert on it later."""
    
    def __init__(self) -> None:
        # store everything in memory
        self.events: list[tuple[str, dict]] = []
        
    def emit(self, event: str, data: dict) -> None:
        # toss it in the list to check later in the test
        self.events.append((event, data))