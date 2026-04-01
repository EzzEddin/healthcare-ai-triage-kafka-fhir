import express from "express";
import cors from "cors";
import { config } from "./config";
import { testDbConnection } from "./db";
import { connectProducer, disconnectProducer } from "./kafka/producer";
import { startConsumer, disconnectConsumer } from "./kafka/consumer";
import { startWebSocketServer } from "./websocket";
import intakeRouter from "./routes/intake";
import patientsRouter from "./routes/patients";

const app = express();

// Middleware
app.use(cors({ origin: ["http://localhost:5173", "http://localhost:3000"] }));
app.use(express.json());

// Routes
app.use("/api/intake", intakeRouter);
app.use("/api/patients", patientsRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "api-gateway", timestamp: new Date().toISOString() });
});

// =============================================================================
// STARTUP SEQUENCE
// =============================================================================
// This demonstrates proper service initialization in a distributed system:
// 1. Connect to PostgreSQL (verify persistence layer)
// 2. Connect Kafka producer (ready to publish events)
// 3. Start Kafka consumer (ready to process triage results)
// 4. Start WebSocket server (ready for real-time UI updates)
// 5. Start HTTP server (ready to accept intake requests)
//
// In production on GKE, Kubernetes readiness probes would check each
// of these connections before routing traffic to the pod.
// =============================================================================
async function start(): Promise<void> {
  try {
    console.log("🚀 Starting Steer Health API Gateway...\n");

    // Step 1: Database
    await testDbConnection();

    // Step 2: Kafka Producer
    await connectProducer();

    // Step 3: Kafka Consumer (processes triage results)
    await startConsumer();

    // Step 4: WebSocket
    startWebSocketServer();

    // Step 5: HTTP Server
    app.listen(config.api.port, () => {
      console.log(`\n✅ API Gateway ready on http://localhost:${config.api.port}`);
      console.log(`📡 WebSocket on ws://localhost:${config.api.wsPort}`);
      console.log(`\n📋 Endpoints:`);
      console.log(`   POST /api/intake          - Submit patient symptoms`);
      console.log(`   GET  /api/patients         - List patients + triage`);
      console.log(`   GET  /api/patients/:id/triage - Patient triage history`);
      console.log(`   GET  /api/patients/:id/fhir   - Patient FHIR bundle`);
      console.log(`   GET  /api/patients/dashboard/stats - Dashboard stats\n`);
    });
  } catch (err) {
    console.error("❌ Failed to start API Gateway:", err);
    process.exit(1);
  }
}

// Graceful shutdown - critical in containerized environments (GKE)
// Kubernetes sends SIGTERM, then waits 30s before SIGKILL.
// We use this window to finish processing in-flight messages.
async function shutdown(): Promise<void> {
  console.log("\n🛑 Shutting down gracefully...");
  await disconnectConsumer();
  await disconnectProducer();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start();
