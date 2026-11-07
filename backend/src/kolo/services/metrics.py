# src/kolo/services/metrics.py

from prometheus_client import Counter, Gauge

# connected users right now
WS_CONNECTIONS = Gauge(
    "kolo_ws_connections", 
    "Open WebSocket connections"
)

# rooms created
ROOMS_CREATED = Counter(
    "kolo_rooms_created_total", 
    "Total rooms created"
)

# signaling messages by type
SIGNALING_MESSAGES = Counter(
    "kolo_signaling_messages_total", 
    "Signaling messages processed", 
    ["type"]
)

# failed joins by reason
JOINS_REJECTED = Counter(
    "kolo_joins_rejected_total", 
    "Rejected join attempts",
    ["reason"]
)