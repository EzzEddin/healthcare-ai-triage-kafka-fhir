-- =============================================================================
-- Steer Health POC - Database Schema
-- =============================================================================
-- This schema stores the results of our distributed pipeline:
-- Patient intake → Kafka → AI Triage → Kafka → PostgreSQL
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Patients table: core demographics
CREATE TABLE patients (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    date_of_birth DATE,
    gender VARCHAR(20),
    phone VARCHAR(20),
    email VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Intake events: raw symptom data from the intake form
CREATE TABLE intake_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id UUID REFERENCES patients(id),
    symptoms TEXT NOT NULL,
    reported_duration VARCHAR(100),
    severity_self_reported INTEGER CHECK (severity_self_reported BETWEEN 1 AND 10),
    kafka_topic VARCHAR(100),
    kafka_partition INTEGER,
    kafka_offset BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Triage results: AI-generated triage from our Python service
CREATE TABLE triage_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    intake_event_id UUID REFERENCES intake_events(id),
    patient_id UUID REFERENCES patients(id),
    urgency_level VARCHAR(20) NOT NULL CHECK (urgency_level IN ('emergency', 'urgent', 'semi-urgent', 'routine')),
    urgency_score INTEGER CHECK (urgency_score BETWEEN 1 AND 100),
    ai_reasoning TEXT,
    recommended_action TEXT,
    suggested_department VARCHAR(100),
    ai_model VARCHAR(50),
    processing_time_ms INTEGER,
    fhir_bundle JSONB,
    kafka_topic VARCHAR(100),
    kafka_partition INTEGER,
    kafka_offset BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- EHR sync log: tracks what we've pushed to Epic/athena/eCW
CREATE TABLE ehr_sync_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id UUID REFERENCES patients(id),
    triage_result_id UUID REFERENCES triage_results(id),
    ehr_system VARCHAR(50) NOT NULL CHECK (ehr_system IN ('epic', 'athenahealth', 'eclinicalworks')),
    sync_status VARCHAR(20) DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'failed')),
    fhir_resource_type VARCHAR(50),
    fhir_resource_id VARCHAR(255),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    synced_at TIMESTAMPTZ
);

-- Indexes for common query patterns
CREATE INDEX idx_triage_patient ON triage_results(patient_id);
CREATE INDEX idx_triage_urgency ON triage_results(urgency_level);
CREATE INDEX idx_triage_created ON triage_results(created_at DESC);
CREATE INDEX idx_intake_patient ON intake_events(patient_id);
CREATE INDEX idx_ehr_sync_status ON ehr_sync_log(sync_status);
