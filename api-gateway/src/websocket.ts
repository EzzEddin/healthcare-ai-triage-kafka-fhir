import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config";

// =============================================================================
// WEBSOCKET SERVER
// =============================================================================
// WebSocket provides real-time push from server → browser.
// When our Kafka consumer processes a triage result, it calls
// broadcastToClients() to instantly update every connected dashboard.
//
// This is the final leg of our event pipeline:
// Patient Form → API → Kafka → Python AI → Kafka → Consumer → WebSocket → UI
// =============================================================================

const clients = new Set<WebSocket>();
let wss: WebSocketServer | null = null;

export function startWebSocketServer(): WebSocketServer {
  wss = new WebSocketServer({ port: config.api.wsPort });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    console.log(`🔌 WebSocket client connected (total: ${clients.size})`);

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`🔌 WebSocket client disconnected (total: ${clients.size})`);
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      clients.delete(ws);
    });

    // Send a welcome message with connection confirmation
    ws.send(JSON.stringify({
      type: "CONNECTED",
      payload: { message: "Connected to Steer Health real-time feed" },
    }));
  });

  console.log(`✅ WebSocket server running on ws://localhost:${config.api.wsPort}`);
  return wss;
}

export function broadcastToClients(message: Record<string, unknown>): void {
  const data = JSON.stringify(message);
  let sent = 0;

  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
      sent++;
    }
  }

  if (sent > 0) {
    console.log(`📡 Broadcast to ${sent} WebSocket client(s):`, message.type);
  }
}
