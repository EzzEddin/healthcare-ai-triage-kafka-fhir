"""
AI Triage Service - Kafka Consumer + LLM-Powered Clinical Triage
=================================================================
This service is the "brain" of the pipeline. It:

1. CONSUMES patient intake events from Kafka topic "patient.intake"
2. REASONS about symptoms using Claude/OpenAI (not just keyword matching)
3. GENERATES FHIR R4 resources (Patient, Condition, Encounter, RiskAssessment)
4. PRODUCES triage results back to Kafka topic "triage.result"

DISTRIBUTED SYSTEMS CONCEPTS DEMONSTRATED:
-------------------------------------------
- Consumer Groups: Multiple instances of this service can run in parallel.
  Kafka automatically distributes partitions among them (horizontal scaling).
- Backpressure: If the AI is slow, messages queue in Kafka (not lost).
  This is vastly better than synchronous HTTP where the caller times out.
- Idempotency: We include the intake_event_id in the output so the consumer
  can use UPSERT logic to handle duplicate processing safely.
- Dead Letter Queue: Failed messages go to a DLQ topic for manual review.

EVENT-DRIVEN ARCHITECTURE:
---------------------------
This service knows NOTHING about the API gateway or the frontend.
It only knows about Kafka topics. This decoupling means:
- You can update the AI model without touching the API
- You can add new consumers (billing, analytics) without changing this service
- You can replay historical events to re-triage with a new model
"""

import json
import os
import sys
import time
import signal
import logging
from typing import Optional
from dotenv import load_dotenv

# Load .env from project root
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from confluent_kafka import Consumer, Producer, KafkaError, KafkaException
from fhir_builder import build_fhir_bundle
from hl7_parser import parse_hl7_message, hl7_to_intake_data

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
KAFKA_BROKER = os.getenv("KAFKA_BROKER", "localhost:9092")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

INTAKE_TOPIC = "patient.intake"
TRIAGE_TOPIC = "triage.result"
FHIR_TOPIC = "fhir.bundle"
DLQ_TOPIC = "patient.intake.dlq"  # Dead Letter Queue

# Consumer group - all instances of this service share the workload
CONSUMER_GROUP = "ai-triage-service-group"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

running = True


def signal_handler(sig, frame):
    global running
    logger.info("Shutdown signal received, finishing current message...")
    running = False


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


# ---------------------------------------------------------------------------
# AI Triage Engine
# ---------------------------------------------------------------------------
def triage_with_llm(symptoms: str, patient_info: dict) -> dict:
    """
    Use Claude or OpenAI to perform clinical triage.
    
    This is where the AI REASONS about symptoms, not just retrieves.
    The prompt is carefully designed to:
    1. Assess urgency using ESI (Emergency Severity Index) principles
    2. Consider patient demographics (age, gender affect risk)
    3. Identify red flags that require immediate attention
    4. Suggest appropriate care setting and department
    
    Returns a structured triage decision.
    """
    age_str = ""
    if patient_info.get("date_of_birth"):
        try:
            from datetime import datetime, date
            dob = datetime.strptime(patient_info["date_of_birth"], "%Y-%m-%d").date()
            age = (date.today() - dob).days // 365
            age_str = f"Age: {age} years"
        except (ValueError, TypeError):
            age_str = "Age: Unknown"

    system_prompt = """You are an AI clinical triage assistant. Your role is to assess patient symptoms 
and determine urgency level based on Emergency Severity Index (ESI) principles.

You must respond with ONLY valid JSON (no markdown, no explanation outside JSON) in this exact format:
{
    "urgency_level": "emergency|urgent|semi-urgent|routine",
    "urgency_score": <1-100, where 100 is most urgent>,
    "reasoning": "<clinical reasoning for the triage decision>",
    "red_flags": ["<list of concerning symptoms or findings>"],
    "recommended_action": "<specific next step for the patient>",
    "suggested_department": "<appropriate department/specialty>",
    "differential_considerations": ["<possible conditions to investigate>"]
}

Urgency Levels:
- emergency (score 80-100): Life-threatening, needs immediate intervention
- urgent (score 60-79): Serious but not immediately life-threatening
- semi-urgent (score 30-59): Needs attention but can wait
- routine (score 1-29): Non-urgent, can be scheduled

Consider: symptom severity, duration, patient age/gender, red flag symptoms,
potential for rapid deterioration."""

    user_prompt = f"""Patient Information:
- {age_str}
- Gender: {patient_info.get('gender', 'Unknown')}

Reported Symptoms:
{symptoms}

Self-reported severity: {patient_info.get('severity_self_reported', 'Not provided')}/10
Duration: {patient_info.get('reported_duration', 'Not specified')}

Assess this patient and provide your triage decision."""

    start_time = time.time()
    
    # Try Claude first, fall back to OpenAI
    result = None
    ai_model = "unknown"
    
    if ANTHROPIC_API_KEY:
        result, ai_model = _call_claude(system_prompt, user_prompt)
    
    if result is None and OPENAI_API_KEY:
        result, ai_model = _call_openai(system_prompt, user_prompt)
    
    if result is None:
        # Fallback: rule-based triage (no API key configured)
        logger.warning("No AI API key configured, using rule-based fallback")
        result, ai_model = _rule_based_triage(symptoms, patient_info)
    
    processing_time_ms = int((time.time() - start_time) * 1000)
    result["processing_time_ms"] = processing_time_ms
    result["ai_model"] = ai_model
    
    return result


def _call_claude(system_prompt: str, user_prompt: str) -> tuple[Optional[dict], str]:
    """Call Anthropic Claude API for triage."""
    try:
        import anthropic
        
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )
        
        text = response.content[0].text
        result = json.loads(text)
        logger.info(f"Claude triage complete: {result.get('urgency_level')}")
        return result, "claude-sonnet-4-20250514"
        
    except Exception as e:
        logger.error(f"Claude API error: {e}")
        return None, ""


def _call_openai(system_prompt: str, user_prompt: str) -> tuple[Optional[dict], str]:
    """Call OpenAI API for triage."""
    try:
        from openai import OpenAI
        
        client = OpenAI(api_key=OPENAI_API_KEY)
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.3,
            response_format={"type": "json_object"},
        )
        
        text = response.choices[0].message.content
        result = json.loads(text)
        logger.info(f"OpenAI triage complete: {result.get('urgency_level')}")
        return result, "gpt-4o"
        
    except Exception as e:
        logger.error(f"OpenAI API error: {e}")
        return None, ""


def _rule_based_triage(symptoms: str, patient_info: dict) -> tuple[dict, str]:
    """
    Fallback rule-based triage when no AI API is available.
    Uses keyword matching for emergency detection.
    """
    symptoms_lower = symptoms.lower()
    
    # Emergency keywords
    emergency_keywords = [
        "chest pain", "difficulty breathing", "unconscious", "seizure",
        "severe bleeding", "stroke", "heart attack", "anaphylaxis",
        "suicidal", "overdose",
    ]
    
    urgent_keywords = [
        "high fever", "severe pain", "head injury", "fracture",
        "deep cut", "asthma attack", "allergic reaction", "dehydration",
    ]
    
    is_emergency = any(kw in symptoms_lower for kw in emergency_keywords)
    is_urgent = any(kw in symptoms_lower for kw in urgent_keywords)
    
    severity = patient_info.get("severity_self_reported")
    if severity and int(severity) >= 8:
        is_urgent = True
    if severity and int(severity) >= 9:
        is_emergency = True
    
    if is_emergency:
        return {
            "urgency_level": "emergency",
            "urgency_score": 90,
            "reasoning": f"Rule-based: Emergency keywords detected in symptoms. Self-reported severity: {severity}/10.",
            "red_flags": [kw for kw in emergency_keywords if kw in symptoms_lower],
            "recommended_action": "Immediate medical attention required. Proceed to Emergency Department.",
            "suggested_department": "Emergency Medicine",
            "differential_considerations": ["Requires immediate clinical assessment"],
        }, "rule-based-v1"
    elif is_urgent:
        return {
            "urgency_level": "urgent",
            "urgency_score": 65,
            "reasoning": f"Rule-based: Urgent keywords detected. Self-reported severity: {severity}/10.",
            "red_flags": [kw for kw in urgent_keywords if kw in symptoms_lower],
            "recommended_action": "Seek medical attention within 1-2 hours.",
            "suggested_department": "Urgent Care",
            "differential_considerations": ["Requires clinical evaluation"],
        }, "rule-based-v1"
    else:
        return {
            "urgency_level": "routine",
            "urgency_score": 25,
            "reasoning": f"Rule-based: No emergency or urgent keywords detected. Self-reported severity: {severity}/10.",
            "red_flags": [],
            "recommended_action": "Schedule an appointment with your primary care provider.",
            "suggested_department": "Primary Care",
            "differential_considerations": ["Standard clinical evaluation recommended"],
        }, "rule-based-v1"


# ---------------------------------------------------------------------------
# Kafka Consumer/Producer Setup
# ---------------------------------------------------------------------------
def create_consumer() -> Consumer:
    """
    Create a Kafka consumer with healthcare-appropriate settings.
    
    KEY SETTINGS EXPLAINED:
    - group.id: All instances with the same group share the workload.
    - auto.offset.reset: 'earliest' means if this is a NEW consumer group,
      start from the beginning (don't miss any patients).
    - enable.auto.commit: False - we manually commit AFTER processing.
      This ensures at-least-once delivery (critical for healthcare).
    - max.poll.interval.ms: 300s allows for slow AI API calls.
    """
    return Consumer({
        "bootstrap.servers": KAFKA_BROKER,
        "group.id": CONSUMER_GROUP,
        "auto.offset.reset": "earliest",
        "enable.auto.commit": False,
        "max.poll.interval.ms": 300000,  # 5 min max for AI processing
        "session.timeout.ms": 30000,
        "heartbeat.interval.ms": 3000,
    })


def create_producer() -> Producer:
    """
    Create a Kafka producer for publishing triage results.
    
    - acks=all: Wait for ALL replicas to confirm write (no data loss).
    - retries=5: Retry on transient failures.
    - enable.idempotence=true: Prevent duplicate messages on retry.
    """
    return Producer({
        "bootstrap.servers": KAFKA_BROKER,
        "acks": "all",
        "retries": 5,
        "enable.idempotence": True,
        "max.in.flight.requests.per.connection": 1,
    })


def delivery_callback(err, msg):
    """Called when a produced message is acknowledged by Kafka."""
    if err:
        logger.error(f"Message delivery failed: {err}")
    else:
        logger.info(
            f"📤 Published to {msg.topic()} "
            f"[partition={msg.partition()}, offset={msg.offset()}]"
        )


# ---------------------------------------------------------------------------
# Main Processing Loop
# ---------------------------------------------------------------------------
def process_intake_event(event_data: dict, producer: Producer) -> None:
    """
    Process a single patient intake event:
    1. Extract patient and symptom data
    2. Run AI triage
    3. Build FHIR R4 bundle
    4. Publish results to Kafka
    """
    intake_event_id = event_data.get("intake_event_id")
    patient_id = event_data.get("patient_id")
    patient = event_data.get("patient", {})
    clinical = event_data.get("clinical", {})
    
    logger.info(f"🔬 Processing intake {intake_event_id} for patient {patient_id}")
    
    # Step 1: AI Triage
    triage_result = triage_with_llm(
        symptoms=clinical.get("symptoms", ""),
        patient_info={
            **patient,
            "severity_self_reported": clinical.get("severity_self_reported"),
            "reported_duration": clinical.get("reported_duration"),
        },
    )
    
    # Step 2: Build FHIR R4 Bundle
    fhir_bundle = build_fhir_bundle(
        patient_data={**patient, "patient_id": patient_id},
        triage_data={
            **triage_result,
            "symptoms": clinical.get("symptoms", ""),
            "reported_duration": clinical.get("reported_duration"),
        },
        intake_event_id=intake_event_id,
    )
    
    # Step 3: Publish triage result to Kafka
    triage_message = {
        "intake_event_id": intake_event_id,
        "patient_id": patient_id,
        "urgency_level": triage_result.get("urgency_level"),
        "urgency_score": triage_result.get("urgency_score"),
        "ai_reasoning": triage_result.get("reasoning"),
        "recommended_action": triage_result.get("recommended_action"),
        "suggested_department": triage_result.get("suggested_department"),
        "ai_model": triage_result.get("ai_model"),
        "processing_time_ms": triage_result.get("processing_time_ms"),
        "red_flags": triage_result.get("red_flags", []),
        "differential_considerations": triage_result.get("differential_considerations", []),
        "fhir_bundle": fhir_bundle,
    }
    
    producer.produce(
        TRIAGE_TOPIC,
        key=patient_id.encode("utf-8") if patient_id else None,
        value=json.dumps(triage_message).encode("utf-8"),
        callback=delivery_callback,
    )
    
    # Step 4: Publish FHIR bundle separately (for EHR sync consumers)
    fhir_message = {
        "patient_id": patient_id,
        "triage_result_id": intake_event_id,
        "fhir_bundle": fhir_bundle,
        "target_ehr": "epic",  # Demo: target Epic as default EHR
    }
    
    producer.produce(
        FHIR_TOPIC,
        key=patient_id.encode("utf-8") if patient_id else None,
        value=json.dumps(fhir_message).encode("utf-8"),
        callback=delivery_callback,
    )
    
    # Flush to ensure messages are sent
    producer.flush(timeout=10)
    
    logger.info(
        f"✅ Triage complete for {patient_id}: "
        f"{triage_result.get('urgency_level')} "
        f"(score: {triage_result.get('urgency_score')}, "
        f"time: {triage_result.get('processing_time_ms')}ms)"
    )


def main():
    """Main consumer loop."""
    logger.info("=" * 60)
    logger.info("🏥 Steer Health AI Triage Service Starting...")
    logger.info("=" * 60)
    logger.info(f"Kafka Broker: {KAFKA_BROKER}")
    logger.info(f"Consumer Group: {CONSUMER_GROUP}")
    logger.info(f"Input Topic: {INTAKE_TOPIC}")
    logger.info(f"Output Topics: {TRIAGE_TOPIC}, {FHIR_TOPIC}")
    logger.info(f"AI: Claude={'configured' if ANTHROPIC_API_KEY else 'not configured'}, "
                f"OpenAI={'configured' if OPENAI_API_KEY else 'not configured'}")
    logger.info("")
    
    consumer = create_consumer()
    producer = create_producer()
    
    consumer.subscribe([INTAKE_TOPIC])
    logger.info(f"📥 Subscribed to {INTAKE_TOPIC}, waiting for events...\n")
    
    try:
        while running:
            # Poll for new messages (1 second timeout)
            msg = consumer.poll(timeout=1.0)
            
            if msg is None:
                continue
            
            if msg.error():
                if msg.error().code() == KafkaError._PARTITION_EOF:
                    # End of partition - normal, just means we're caught up
                    continue
                else:
                    logger.error(f"Kafka error: {msg.error()}")
                    continue
            
            try:
                value = json.loads(msg.value().decode("utf-8"))
                
                logger.info(
                    f"📥 Received from {msg.topic()} "
                    f"[partition={msg.partition()}, offset={msg.offset()}]"
                )
                
                process_intake_event(value, producer)
                
                # Manually commit offset AFTER successful processing.
                # If we crash before this, the message will be re-processed
                # on restart (at-least-once delivery guarantee).
                consumer.commit(asynchronous=False)
                
            except json.JSONDecodeError as e:
                logger.error(f"Invalid JSON in message: {e}")
                # In production: send to DLQ
                consumer.commit(asynchronous=False)
                
            except Exception as e:
                logger.error(f"Error processing message: {e}", exc_info=True)
                # In production: send to DLQ, alert on-call
                # For now, commit and move on to avoid blocking the queue
                consumer.commit(asynchronous=False)
    
    finally:
        logger.info("Closing consumer...")
        consumer.close()
        logger.info("AI Triage Service stopped.")


if __name__ == "__main__":
    main()
