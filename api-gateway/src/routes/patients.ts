import { Router, Request, Response } from "express";
import { pool } from "../db";
import { redisClient } from "../redis";

const router = Router();

// GET /api/patients - List all patients with their latest triage
router.get("/", async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await pool.query(`
      SELECT 
        p.id, p.first_name, p.last_name, p.date_of_birth, p.gender,
        p.phone, p.email, p.created_at,
        tr.urgency_level, tr.urgency_score, tr.ai_reasoning,
        tr.recommended_action, tr.suggested_department, tr.ai_model,
        tr.processing_time_ms, tr.created_at as triage_at,
        ie.symptoms, ie.severity_self_reported, ie.id as intake_event_id
      FROM patients p
      LEFT JOIN LATERAL (
        SELECT * FROM intake_events ie2
        WHERE ie2.patient_id = p.id
        ORDER BY ie2.created_at DESC LIMIT 1
      ) ie ON true
      LEFT JOIN LATERAL (
        SELECT * FROM triage_results tr2
        WHERE tr2.patient_id = p.id
        ORDER BY tr2.created_at DESC LIMIT 1
      ) tr ON true
      ORDER BY p.created_at DESC
      LIMIT 50
    `);

    res.json({ patients: result.rows });
  } catch (err) {
    console.error("Error fetching patients:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/patients/:id/triage - Get triage history for a patient (checks Redis cache first)
router.get("/:id/triage", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    // Check Redis cache first
    const cached = await redisClient.get(`triage:${id}`);
    if (cached) {
      res.json({ source: "cache", triage: JSON.parse(cached) });
      return;
    }

    // Fall back to PostgreSQL
    const result = await pool.query(
      `SELECT tr.*, ie.symptoms, ie.severity_self_reported
       FROM triage_results tr
       JOIN intake_events ie ON ie.id = tr.intake_event_id
       WHERE tr.patient_id = $1
       ORDER BY tr.created_at DESC`,
      [id]
    );

    res.json({ source: "database", triage: result.rows });
  } catch (err) {
    console.error("Error fetching triage:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/patients/:id/fhir - Get FHIR bundle for a patient
router.get("/:id/fhir", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT fhir_bundle FROM triage_results
       WHERE patient_id = $1 AND fhir_bundle IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "No FHIR bundle found for this patient" });
      return;
    }

    res.json(result.rows[0].fhir_bundle);
  } catch (err) {
    console.error("Error fetching FHIR bundle:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/patients/:id/ehr-sync - Get EHR sync status for a patient
router.get("/:id/ehr-sync", async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT esl.id, esl.ehr_system, esl.sync_status, esl.fhir_resource_type,
              esl.fhir_resource_id, esl.error_message, esl.created_at, esl.synced_at
       FROM ehr_sync_log esl
       WHERE esl.patient_id = $1
       ORDER BY esl.created_at DESC`,
      [id]
    );

    res.json({ ehr_sync: result.rows });
  } catch (err) {
    console.error("Error fetching EHR sync:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/dashboard/stats - Dashboard statistics
router.get("/dashboard/stats", async (_req: Request, res: Response): Promise<void> => {
  try {
    const [totalPatients, triageCounts, recentIntakes] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM patients"),
      pool.query(`
        SELECT urgency_level, COUNT(*) as count
        FROM triage_results
        GROUP BY urgency_level
      `),
      pool.query(`
        SELECT COUNT(*) FROM intake_events
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `),
    ]);

    res.json({
      total_patients: parseInt(totalPatients.rows[0].count),
      triage_breakdown: triageCounts.rows,
      intakes_last_24h: parseInt(recentIntakes.rows[0].count),
    });
  } catch (err) {
    console.error("Error fetching stats:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
