# Keep the reading workspace in Viewer

Viewer owns the reading workspace, reading sessions, and their durable reading state. Core retains file access, format-adapter selection, and final resource cleanup; Library owns browsing, import, and relink, and uses host contracts for reading summaries. We chose this over a generic host editor workspace because the requirement is tabbed reading, not multiple editor kinds or split readers; this keeps reading behavior local without enlarging the host interface for hypothetical uses.
