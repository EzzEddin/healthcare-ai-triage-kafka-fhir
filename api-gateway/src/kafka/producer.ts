import { Kafka, Producer, ProducerRecord } from "kafkajs";
import { config } from "../config";

// =============================================================================
// KAFKA PRODUCER
// =============================================================================
// The producer is the "sender" side of Kafka. It publishes messages to topics.
//
// KEY CONCEPTS:
// - acks: "all" means the broker waits for ALL replicas to confirm the write.
//   This is the safest setting for healthcare data (no data loss).
//   Options: 0 (fire-and-forget), 1 (leader only), -1/all (all replicas)
//
// - Idempotent producer: ensures exactly-once delivery even if retries occur.
//   Without this, a network hiccup could cause duplicate patient records.
//
// - Message keys: we use patient_id as the key. Kafka guarantees that all
//   messages with the same key go to the same partition, preserving order
//   for that patient's events. This is critical for clinical workflows.
// =============================================================================

let producer: Producer | null = null;

const kafka = new Kafka({
  clientId: config.kafka.clientId,
  brokers: [config.kafka.broker],
  retry: {
    initialRetryTime: 300,
    retries: 10,
  },
});

export async function connectProducer(): Promise<Producer> {
  if (producer) return producer;

  producer = kafka.producer({
    allowAutoTopicCreation: true,
    idempotent: true,        // Exactly-once semantics
    maxInFlightRequests: 1,  // Required for idempotent producer
  });

  await producer.connect();
  console.log("✅ Kafka producer connected");
  return producer;
}

export async function publishEvent(
  topic: string,
  key: string,
  payload: Record<string, unknown>
): Promise<void> {
  const prod = await connectProducer();

  const record: ProducerRecord = {
    topic,
    messages: [
      {
        // Key determines partition assignment - same patient always goes
        // to the same partition, guaranteeing ordered processing.
        key,
        value: JSON.stringify({
          ...payload,
          metadata: {
            timestamp: new Date().toISOString(),
            source: "api-gateway",
            version: "1.0.0",
          },
        }),
        // Headers are like HTTP headers - metadata that consumers can
        // read without deserializing the full message body.
        headers: {
          "content-type": Buffer.from("application/json"),
          "event-source": Buffer.from("api-gateway"),
        },
      },
    ],
  };

  const result = await prod.send(record);
  console.log(`📤 Published to ${topic}:`, {
    partition: result[0].partition,
    offset: result[0].offset,
  });
}

export async function disconnectProducer(): Promise<void> {
  if (producer) {
    await producer.disconnect();
    producer = null;
    console.log("Kafka producer disconnected");
  }
}
