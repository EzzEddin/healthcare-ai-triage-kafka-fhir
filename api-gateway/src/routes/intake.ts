import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../db";
import { publishEvent } from "../kafka/producer";
import { config } from "../config";
import { broadcastToClients } from "../websocket";

const router = Router();

// =============================================================================
// POST /api/intake - Submit patient intake (symptoms)
// =============================================================================
// This is where the distributed pipeline begins:
// 1. Validate and save to PostgreSQL (source of truth)
// 2. Publish to Kafka topic "patient.intake"
// 3. Python AI service consumes from Kafka, triages, and publishes result
// 4. Our Kafka consumer picks up the result and pushes to WebSocket
// =============================================================================
router.post("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      first_name,
      last_name,
      date_of_birth,
      gender,
      phone,
      email,
      symptoms,
      reported_duration,
      severity_self_reported,
    } = req.body;

    // Validation
    if (!first_name || !last_name || !symptoms) {
      res.status(400).json({
        error: "first_name, last_name, and symptoms are required",
      });
      return;
    }

    // Step 1: Create or find patient
    let patientResult = await pool.query(
      `SELECT id FROM patients WHERE first_name = $1 AND last_name = $2 AND date_of_birth = $3 LIMIT 1`,
      [first_name, last_name, date_of_birth || null]
    );

    let patientId: string;
    if (patientResult.rows.length > 0) {
      patientId = patientResult.rows[0].id;
    } else {
      patientResult = await pool.query(
        `INSERT INTO patients (first_name, last_name, date_of_birth, gender, phone, email)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [first_name, last_name, date_of_birth || null, gender || null, phone || null, email || null]
      );
      patientId = patientResult.rows[0].id;
    }

    // Step 2: Save intake event
    const intakeResult = await pool.query(
      `INSERT INTO intake_events (patient_id, symptoms, reported_duration, severity_self_reported)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [patientId, symptoms, reported_duration || null, severity_self_reported || null]
    );

    const intakeEventId = intakeResult.rows[0].id;
    const createdAt = intakeResult.rows[0].created_at;

    // Step 3: Publish to Kafka
    // The message key is the patient_id - this ensures all events for the
    // same patient go to the same partition (ordered processing per patient).
    await publishEvent(config.kafka.topics.patientIntake, patientId, {
      event_type: "PATIENT_INTAKE",
      intake_event_id: intakeEventId,
      patient_id: patientId,
      patient: {
        first_name,
        last_name,
        date_of_birth,
        gender,
        phone,
        email,
      },
      clinical: {
        symptoms,
        reported_duration,
        severity_self_reported,
      },
    });

    // Notify connected dashboards that a new intake arrived
    broadcastToClients({
      type: "NEW_INTAKE",
      payload: {
        intake_event_id: intakeEventId,
        patient_id: patientId,
        patient_name: `${first_name} ${last_name}`,
        symptoms,
        severity_self_reported,
        status: "processing",
        created_at: createdAt,
      },
    });

    res.status(201).json({
      success: true,
      intake_event_id: intakeEventId,
      patient_id: patientId,
      message: "Intake submitted. AI triage processing via Kafka pipeline.",
    });
  } catch (err) {
    console.error("Intake error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
