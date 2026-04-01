import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const config = {
  api: {
    port: parseInt(process.env.API_PORT || "3001"),
    wsPort: parseInt(process.env.WS_PORT || "3002"),
  },
  kafka: {
    broker: process.env.KAFKA_BROKER || "localhost:9092",
    clientId: "steer-api-gateway",
    // -----------------------------------------------------------------------
    // KAFKA TOPIC NAMING CONVENTION:
    // Use dot-separated namespaces: <domain>.<event-type>
    // This mirrors how Steer Health would organize clinical event streams.
    // -----------------------------------------------------------------------
    topics: {
      patientIntake: "patient.intake",       // New patient symptom submissions
      triageResult: "triage.result",         // AI triage decisions
      fhirBundle: "fhir.bundle",             // Generated FHIR R4 resources
      ehrSync: "ehr.sync",                   // EHR sync requests (Epic, athena, eCW)
    },
    // Consumer group: all API gateway instances share this group so each
    // message is processed by exactly ONE instance (load balancing).
    consumerGroup: "api-gateway-group",
  },
  postgres: {
    host: process.env.POSTGRES_HOST || "localhost",
    port: parseInt(process.env.POSTGRES_PORT || "5432"),
    database: process.env.POSTGRES_DB || "steer_health",
    user: process.env.POSTGRES_USER || "steer",
    password: process.env.POSTGRES_PASSWORD || "steer_dev_2024",
  },
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
  },
};
