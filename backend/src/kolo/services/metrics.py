# src/kolo/services/metrics.py

from prometheus_client import Counter, Gauge

# track how many users are actively connected right now
WS_CONNECTIONS = Gauge(
    "kolo_ws_connections", 
    "Open WebSocket connections"
)

# total number of rooms spun up over time
ROOMS_CREATED = Counter(
    "kolo_rooms_created_total", 
    "Total rooms created"
)

# track signaling traffic to see what's eating bandwidth (offers, answers, ice, etc.)
SIGNALING_MESSAGES = Counter(
    "kolo_signaling_messages_total", 
    "Signaling messages processed", 
    ["type"]
)

# track failed join attempts (wrong code, full room, expired token, etc.)
JOINS_REJECTED = Counter(
    "kolo_joins_rejected_total", 
    "Rejected join attempts",
    ["reason"]
)