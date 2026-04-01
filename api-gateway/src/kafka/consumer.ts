import { Kafka, Consumer, EachMessagePayload } from "kafkajs";
import { config } from "../config";
import { pool } from "../db";
import { redisClient, publishToChannel } from "../redis";
import { broadcastToClients } from "../websocket";

// =============================================================================
// KAFKA CONSUMER
// =============================================================================
// The consumer reads messages from Kafka topics and processes them.
//
// CONSUMER GROUPS EXPLAINED:
// - Multiple instances of the API gateway join the same consumer group.
// - Kafka assigns partitions to consumers in the group automatically.
// - If one instance crashes, Kafka "rebalances" its partitions to survivors.
// - This is how you get horizontal scaling + fault tolerance on GKE.
//
// OFFSET MANAGEMENT:
// - Each consumer tracks its "offset" (position) in each partition.
// - After processing a message, we "commit" the offset.
// - If the consumer crashes before committing, it re-reads from the last
//   committed offset on restart. This gives "at-least-once" delivery.
// - For healthcare: better to process a message twice than lose it.
//   Our database uses UPSERT to handle duplicates safely.
// =============================================================================

let consumer: Consumer | null = null;

const kafka = new Kafka({
  clientId: `${config.kafka.clientId}-consumer`,
  brokers: [config.kafka.broker],
});

export async function startConsumer(): Promise<void> {
  consumer = kafka.consumer({
    groupId: config.kafka.consumerGroup,
    // How often to auto-commit offsets (ms). Lower = less re-processing on
    // crash but more overhead. 5s is a good default.
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
  });

  await consumer.connect();
  console.log("✅ Kafka consumer connected");

  // Subscribe to topics that the Python AI service publishes to
  await consumer.subscribe({
    topics: [
      config.kafka.topics.triageResult,
      config.kafka.topics.fhirBundle,
    ],
    fromBeginning: false, // Only process new messages, not historical ones
  });

  await consumer.run({
    // eachMessage processes one message at a time (ordered within partition).
    // For higher throughput, you could use eachBatch instead.
    eachMessage: async (payload: EachMessagePayload) => {
      const { topic, partition, message } = payload;
      const value = message.value?.toString();

      if (!value) return;

      console.log(`📥 Consumed from ${topic} [partition=${partition}, offset=${message.offset}]`);

      try {
        const data = JSON.parse(value);

        switch (topic) {
          case config.kafka.topics.triageResult:
            await handleTriageResult(data, partition, Number(message.offset));
            break;
          case config.kafka.topics.fhirBundle:
            await handleFhirBundle(data);
            break;
          default:
            console.warn(`Unknown topic: ${topic}`);
        }
      } catch (err) {
        // In production, failed messages go to a Dead Letter Queue (DLQ)
        // topic for manual review. Critical for healthcare compliance.
        console.error(`❌ Error processing message from ${topic}:`, err);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Handle triage results from the Python AI service
// ---------------------------------------------------------------------------
async function handleTriageResult(
  data: any,
  partition: number,
  offset: number
): Promise<void> {
  const {
    intake_event_id,
    patient_id,
    urgency_level,
    urgency_score,
    ai_reasoning,
    recommended_action,
    suggested_department,
    ai_model,
    processing_time_ms,
    fhir_bundle,
  } = data;

  // Persist to PostgreSQL
  const result = await pool.query(
    `INSERT INTO triage_results 
     (intake_event_id, patient_id, urgency_level, urgency_score, ai_reasoning,
      recommended_action, suggested_department, ai_model, processing_time_ms,
      fhir_bundle, kafka_topic, kafka_partition, kafka_offset)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      intake_event_id, patient_id, urgency_level, urgency_score, ai_reasoning,
      recommended_action, suggested_department, ai_model, processing_time_ms,
      JSON.stringify(fhir_bundle), "triage.result", partition, offset,
    ]
  );

  if (result.rows.length > 0) {
    // Cache in Redis for fast dashboard access (TTL: 1 hour)
    const cacheKey = `triage:${patient_id}`;
    await redisClient.setex(cacheKey, 3600, JSON.stringify(data));

    // Push real-time update to all connected WebSocket clients
    broadcastToClients({
      type: "TRIAGE_RESULT",
      payload: {
        id: result.rows[0].id,
        intake_event_id,
        patient_id,
        urgency_level,
        urgency_score,
        ai_reasoning,
        recommended_action,
        suggested_department,
        ai_model,
        processing_time_ms,
        created_at: new Date().toISOString(),
      },
    });

    console.log(`💾 Triage result saved for patient ${patient_id}: ${urgency_level}`);
  }
}

// ---------------------------------------------------------------------------
// Handle FHIR bundles - log EHR sync requests
// ---------------------------------------------------------------------------
async function handleFhirBundle(data: any): Promise<void> {
  const { patient_id, triage_result_id: intake_event_id, fhir_bundle } = data;

  // Look up the actual triage_results PK using intake_event_id
  // (the Python service sends intake_event_id as triage_result_id)
  let triageResultId: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const lookup = await pool.query(
      `SELECT id FROM triage_results WHERE intake_event_id = $1 LIMIT 1`,
      [intake_event_id]
    );
    if (lookup.rows.length > 0) {
      triageResultId = lookup.rows[0].id;
      break;
    }
    // Triage result may not be committed yet (race condition) - wait and retry
    await new Promise((r) => setTimeout(r, 500));
  }

  if (triageResultId) {
    // Simulate syncing to all 3 EHR systems
    const ehrSystems = ["epic", "athenahealth", "eclinicalworks"];
    for (const ehr of ehrSystems) {
      // Simulate a sync attempt (in production, this would POST the FHIR bundle
      // to each EHR's FHIR endpoint, e.g., Epic's /api/FHIR/R4/Bundle)
      const syncSuccess = Math.random() > 0.1; // 90% success rate for demo
      await pool.query(
        `INSERT INTO ehr_sync_log 
         (patient_id, triage_result_id, ehr_system, fhir_resource_type, fhir_resource_id, sync_status, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          patient_id,
          triageResultId,
          ehr,
          fhir_bundle?.resourceType || "Bundle",
          fhir_bundle?.id || null,
          syncSuccess ? "synced" : "failed",
          syncSuccess ? new Date().toISOString() : null,
        ]
      );
      console.log(`📋 EHR sync ${syncSuccess ? "✅" : "❌"} ${ehr} for patient ${patient_id}`);
    }
  } else {
    console.warn(`⚠️ Could not find triage result for intake ${intake_event_id}, skipping EHR sync`);
  }

  broadcastToClients({
    type: "FHIR_BUNDLE",
    payload: { patient_id, fhir_bundle },
  });
}

export async function disconnectConsumer(): Promise<void> {
  if (consumer) {
    await consumer.disconnect();
    consumer = null;
    console.log("Kafka consumer disconnected");
  }
}
