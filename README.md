# Steer Health POC — AI-Powered Patient Triage Pipeline

A distributed, event-driven healthcare system that demonstrates end-to-end clinical workflow automation: from patient intake through AI-powered triage to FHIR R4 resource generation — all connected via **Apache Kafka**.

![Architecture](https://img.shields.io/badge/Architecture-Event--Driven-purple)
![Kafka](https://img.shields.io/badge/Kafka-Message%20Bus-black)
![FHIR](https://img.shields.io/badge/FHIR-R4-red)
![AI](https://img.shields.io/badge/AI-Claude%20%2F%20GPT--4o-blue)

---

## What This Demonstrates

| Competency | Implementation |
|---|---|
| **Healthcare / EHR** | FHIR R4 bundles (Patient, Condition, Encounter, RiskAssessment), HL7 v2.x parser, SNOMED CT coding, EHR sync log for Epic/athena/eCW |
| **LLM / AI Agents** | Claude/GPT-4o clinical triage that *reasons* about symptoms using ESI principles — not keyword matching. Structured JSON output with differential considerations. |
| **Distributed Systems** | Kafka-based event pipeline, async processing, consumer groups, at-least-once delivery, dead letter queues, WebSocket real-time push, Redis caching |

---

## Architecture

```
┌─────────────┐     HTTP POST      ┌──────────────────┐    Kafka     ┌─────────────────────┐
│  React/Vite │ ─────────────────► │  Node.js/TS API  │ ──────────► │  Python AI Service  │
│  Dashboard  │                    │  Gateway         │             │  (Kafka Consumer)   │
│             │ ◄── WebSocket ──── │                  │ ◄────────── │                     │
└─────────────┘                    └──────────────────┘    Kafka     └─────────────────────┘
                                     │           │                     │           │
                                     ▼           ▼                     ▼           ▼
                                ┌─────────┐ ┌───────┐           ┌──────────┐ ┌─────────┐
                                │ Postgres│ │ Redis │           │ Claude/  │ │ FHIR R4 │
                                │         │ │ Cache │           │ OpenAI   │ │ Builder │
                                └─────────┘ └───────┘           └──────────┘ └─────────┘
```

### Data Flow (step by step)

1. **Patient** fills out symptoms on the React intake form
2. **API Gateway** (Node.js/TypeScript) saves to PostgreSQL, publishes to Kafka topic `patient.intake`
3. **Kafka** durably stores the event; the Python AI service consumes it
4. **AI Triage Service** (Python) calls Claude or GPT-4o to reason about symptoms
5. **FHIR Builder** generates a compliant R4 Bundle (Patient + Condition + Encounter + RiskAssessment)
6. **Results** published back to Kafka topics `triage.result` and `fhir.bundle`
7. **API Gateway consumer** picks up results, saves to PostgreSQL, caches in Redis
8. **WebSocket** pushes real-time update to all connected dashboards
9. **Dashboard** updates instantly with triage level, AI reasoning, and FHIR resources

---

## Kafka & Distributed Systems — Explained Simply

> *This section is written for someone new to distributed systems.*

### What is Kafka?

Think of Kafka as a **super-reliable conveyor belt system** in a factory:

- **Topics** are named conveyor belts: `patient.intake`, `triage.result`, `fhir.bundle`
- **Producers** place boxes (messages) onto a belt — our Node.js API is a producer
- **Consumers** take boxes off the belt to process them — our Python AI service is a consumer
- Unlike a regular queue, **the boxes stay on the belt** even after being read (configurable retention)

### Why not just use HTTP?

If the API gateway called the Python AI service directly via HTTP:

| Problem | HTTP | Kafka |
|---|---|---|
| AI service is slow (3–5s per triage) | Caller times out, user gets error | Message queues safely, processed when ready |
| AI service crashes | Patient data is **lost** | Message stays in Kafka, re-processed on restart |
| Need to add billing service | Must modify API gateway code | Just add a new consumer — zero changes to existing code |
| 1000 patients submit at once | API gateway overloaded | Kafka absorbs the spike, consumers process at their pace |
| Need audit trail | Must implement logging yourself | Kafka IS the audit trail — every event is stored with timestamps |

### Key Kafka Concepts Used in This POC

#### 1. Topics & Partitions
```
Topic: patient.intake
├── Partition 0: [msg1, msg3, msg5, ...]  ← Patient A's events
├── Partition 1: [msg2, msg4, msg6, ...]  ← Patient B's events
└── Partition 2: [msg7, msg8, msg9, ...]  ← Patient C's events
```
- We use **patient_id as the message key** — Kafka hashes it to determine the partition
- All events for the same patient go to the **same partition** = guaranteed ordering per patient
- Different partitions can be processed in **parallel** by different consumer instances

#### 2. Consumer Groups
```
Consumer Group: "ai-triage-service-group"

Instance 1 (Pod on GKE) ──► reads Partition 0
Instance 2 (Pod on GKE) ──► reads Partition 1
Instance 3 (Pod on GKE) ──► reads Partition 2
```
- Multiple instances of the Python service join the same consumer group
- Kafka **automatically distributes partitions** among group members
- If Instance 2 dies, Kafka **rebalances** — Instance 1 or 3 picks up Partition 1
- This is how you get **horizontal scaling** and **fault tolerance** on GKE

#### 3. Offset Management (At-Least-Once Delivery)
```
Partition 0: [msg1, msg2, msg3, msg4, msg5]
                                  ↑
                          committed offset = 3
                          (consumer has processed up to msg3)
```
- Each consumer tracks its position (offset) in each partition
- We **manually commit** after successful processing (not auto-commit)
- If the consumer crashes before committing → it re-reads from the last committed offset
- Result: a message might be processed **twice**, but never **lost**
- Our database uses `ON CONFLICT DO NOTHING` to handle duplicates safely

#### 4. Dead Letter Queue (DLQ)
```
patient.intake ──► Consumer fails to process ──► patient.intake.dlq
```
- If a message can't be processed (bad data, API error), it goes to a DLQ topic
- Ops team can inspect and replay DLQ messages after fixing the issue
- Critical for healthcare compliance — you never silently drop patient data

### How This Maps to Production (GKE)

| This POC | Production on GCP/GKE |
|---|---|
| Single Kafka broker | 3+ brokers across availability zones |
| `docker-compose up` | Strimzi Kafka operator on GKE |
| 1 partition per topic | 6-12 partitions per topic (parallel processing) |
| Replication factor = 1 | Replication factor = 3 (data survives broker failure) |
| Local PostgreSQL | Cloud SQL with read replicas |
| Local Redis | Memorystore for Redis |
| Manual `npm run dev` | Kubernetes Deployments with HPA (auto-scaling) |

---

## Tech Stack Mapping

| Steer Health Stack | This POC |
|---|---|
| GCP / GKE | Docker Compose (production-ready patterns documented) |
| Kafka | Confluent Kafka (Python) + KafkaJS (Node.js) — full producer/consumer |
| FHIR R4 | Complete Bundle with Patient, Condition, Encounter, RiskAssessment |
| HL7 v2.x | Parser for ADT^A01 messages with segment extraction |
| Node.js / TypeScript | API Gateway: Express + Kafka + WebSocket + PostgreSQL + Redis |
| Python | AI Triage Service: Kafka consumer + LLM orchestration + FHIR builder |
| React | Real-time dashboard with intake form, triage queue, event stream |
| Vite | Build tool for the React frontend |
| OpenAI / Claude APIs | Dual-provider triage with structured JSON output + rule-based fallback |
| PostgreSQL | Patient records, triage results, EHR sync log |
| Redis | Triage result caching + real-time pub/sub |
| Epic / athena / eCW | EHR sync log table tracking FHIR bundle pushes per system |
| ElevenLabs / Deepgram | Architecture supports voice (documented extension point) |
| Twilio | Architecture supports SMS/voice notifications (documented extension point) |

---

## Quick Start

### Prerequisites
- **Docker Desktop** (for Kafka, PostgreSQL, Redis)
- **Node.js 20+**
- **Python 3.11+**
- At least one AI API key: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (optional — falls back to rule-based triage)

### 1. Start Infrastructure

```bash
# From project root
docker-compose up -d
```

Wait ~30 seconds for Kafka to be healthy. You can check at http://localhost:8080 (Kafka UI).

### 2. Set Up Environment

```bash
cp .env.example .env
# Edit .env and add your API keys
```

### 3. Start API Gateway (Node.js)

```bash
cd api-gateway
npm install
npm run dev
```

API runs on http://localhost:3001, WebSocket on ws://localhost:3002.

### 4. Start AI Triage Service (Python)

```bash
cd ai-triage-service
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # Mac/Linux
pip install -r requirements.txt
python main.py
```

### 5. Start Frontend (React/Vite)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

### 6. Demo It

1. Go to **New Intake** tab
2. Fill in patient info and symptoms (try "severe chest pain radiating to left arm")
3. Submit — watch the **Event Pipeline** tab to see events flow through Kafka
4. Switch to **Dashboard** — see the triage result appear in real-time
5. Click a patient row to expand AI reasoning + FHIR R4 bundle

---

## Project Structure

```
steer_health/
├── docker-compose.yml          # Kafka, Zookeeper, PostgreSQL, Redis, Kafka UI
├── init.sql                    # Database schema
├── .env.example                # Environment variables template
│
├── api-gateway/                # Node.js / TypeScript
│   ├── src/
│   │   ├── index.ts            # Express server + startup sequence
│   │   ├── config.ts           # Centralized configuration
│   │   ├── db.ts               # PostgreSQL connection pool
│   │   ├── redis.ts            # Redis client + pub/sub
│   │   ├── websocket.ts        # WebSocket server for real-time push
│   │   ├── kafka/
│   │   │   ├── producer.ts     # Kafka producer (publishes intake events)
│   │   │   └── consumer.ts     # Kafka consumer (processes triage results)
│   │   └── routes/
│   │       ├── intake.ts       # POST /api/intake → Kafka pipeline
│   │       └── patients.ts     # GET endpoints + Redis cache
│   ├── package.json
│   └── tsconfig.json
│
├── ai-triage-service/          # Python
│   ├── main.py                 # Kafka consumer + LLM triage orchestration
│   ├── fhir_builder.py         # FHIR R4 Bundle generator (Patient, Condition, etc.)
│   ├── hl7_parser.py           # HL7 v2.x ADT message parser
│   └── requirements.txt
│
└── frontend/                   # React + Vite + TailwindCSS
    ├── src/
    │   ├── App.tsx             # Dashboard, intake form, event pipeline view
    │   ├── hooks/
    │   │   └── useWebSocket.ts # Auto-reconnecting WebSocket hook
    │   ├── main.tsx
    │   └── index.css           # Tailwind + custom animations
    ├── index.html
    ├── vite.config.ts
    ├── tailwind.config.js
    └── package.json
```

---

## Extending This POC

### Adding Voice AI (Deepgram + ElevenLabs)
The architecture naturally supports this:
1. Add a `/api/voice/intake` endpoint that accepts audio
2. Transcribe with Deepgram's streaming API
3. Publish transcription to `patient.intake` topic (same pipeline)
4. Use ElevenLabs to synthesize the triage response back to the patient

### Adding Twilio SMS Notifications
1. Add a new Kafka consumer subscribed to `triage.result`
2. On emergency/urgent triage → send SMS via Twilio to the patient and care team
3. This is the beauty of event-driven architecture: **zero changes to existing services**

### Adding More EHR Integrations
1. The `ehr.sync` topic is ready for consumers
2. Each EHR (Epic, athena, eCW) gets its own consumer that POSTs the FHIR Bundle to the respective FHIR endpoint
3. The `ehr_sync_log` table tracks success/failure per system

---

## License

Built as a technical demonstration for Steer Health.
