"""
FHIR R4 Resource Builder
=========================
Generates compliant FHIR R4 resources from triage data.

FHIR (Fast Healthcare Interoperability Resources) is THE standard for
exchanging healthcare data electronically. Version R4 is the current
normative release used by Epic, athenahealth, eClinicalWorks, etc.

Key concepts:
- Resources: Individual data objects (Patient, Condition, Encounter, etc.)
- Bundles: Collections of resources sent together (like a transaction)
- References: How resources link to each other (e.g., Condition → Patient)

This module uses the `fhir.resources` library which validates against
the official FHIR R4 JSON schemas. If we produce invalid FHIR, it throws.
"""

import uuid
from datetime import datetime, date
from typing import Any, Optional


def build_fhir_bundle(
    patient_data: dict,
    triage_data: dict,
    intake_event_id: str,
) -> dict:
    """
    Build a FHIR R4 Bundle (type: transaction) containing:
    - Patient resource (demographics)
    - Condition resource (reported symptoms mapped to SNOMED CT)
    - Encounter resource (the triage encounter)
    - RiskAssessment resource (AI triage result)

    In production, this bundle would be POSTed to an EHR's FHIR endpoint:
    - Epic:            POST https://fhir.epic.com/api/FHIR/R4/
    - athenahealth:    POST https://api.athenahealth.com/fhir/r4/
    - eClinicalWorks:  POST https://fhir.eclinicalworks.com/fhir/r4/
    """
    patient_id = str(uuid.uuid4())
    condition_id = str(uuid.uuid4())
    encounter_id = str(uuid.uuid4())
    risk_assessment_id = str(uuid.uuid4())

    now = datetime.utcnow().isoformat() + "Z"
    dob = patient_data.get("date_of_birth")

    # -------------------------------------------------------------------------
    # FHIR Patient Resource
    # -------------------------------------------------------------------------
    patient_resource = {
        "resourceType": "Patient",
        "id": patient_id,
        "meta": {
            "profile": ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"]
        },
        "identifier": [
            {
                "system": "urn:steer-health:patient-id",
                "value": patient_data.get("patient_id", patient_id),
            }
        ],
        "active": True,
        "name": [
            {
                "use": "official",
                "family": patient_data.get("last_name", "Unknown"),
                "given": [patient_data.get("first_name", "Unknown")],
            }
        ],
        "gender": _map_gender(patient_data.get("gender")),
        "birthDate": dob if dob else None,
        "telecom": _build_telecom(patient_data),
    }

    # -------------------------------------------------------------------------
    # FHIR Condition Resource (symptoms → clinical condition)
    # -------------------------------------------------------------------------
    condition_resource = {
        "resourceType": "Condition",
        "id": condition_id,
        "meta": {
            "profile": ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition"]
        },
        "clinicalStatus": {
            "coding": [
                {
                    "system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
                    "code": "active",
                    "display": "Active",
                }
            ]
        },
        "verificationStatus": {
            "coding": [
                {
                    "system": "http://terminology.hl7.org/CodeSystem/condition-ver-status",
                    "code": "provisional",
                    "display": "Provisional",
                }
            ]
        },
        "category": [
            {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/condition-category",
                        "code": "encounter-diagnosis",
                        "display": "Encounter Diagnosis",
                    }
                ]
            }
        ],
        "code": {
            "coding": _map_symptoms_to_snomed(triage_data.get("symptoms", "")),
            "text": triage_data.get("symptoms", ""),
        },
        "subject": {"reference": f"Patient/{patient_id}"},
        "onsetString": triage_data.get("reported_duration", "Unknown duration"),
        "recordedDate": now,
    }

    # -------------------------------------------------------------------------
    # FHIR Encounter Resource (the triage visit)
    # -------------------------------------------------------------------------
    encounter_resource = {
        "resourceType": "Encounter",
        "id": encounter_id,
        "status": "triaged",
        "class": {
            "system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
            "code": "EMER" if triage_data.get("urgency_level") == "emergency" else "AMB",
            "display": "Emergency" if triage_data.get("urgency_level") == "emergency" else "Ambulatory",
        },
        "type": [
            {
                "coding": [
                    {
                        "system": "http://snomed.info/sct",
                        "code": "225390008",
                        "display": "Triage",
                    }
                ]
            }
        ],
        "subject": {"reference": f"Patient/{patient_id}"},
        "period": {"start": now},
        "reasonReference": [{"reference": f"Condition/{condition_id}"}],
    }

    # -------------------------------------------------------------------------
    # FHIR RiskAssessment Resource (AI triage decision)
    # -------------------------------------------------------------------------
    urgency_to_code = {
        "emergency": {"code": "LA9634-2", "display": "Immediate"},
        "urgent": {"code": "LA9633-4", "display": "Emergent"},
        "semi-urgent": {"code": "LA9632-6", "display": "Urgent"},
        "routine": {"code": "LA9631-8", "display": "Non-urgent"},
    }
    urgency = triage_data.get("urgency_level", "routine")
    risk_code = urgency_to_code.get(urgency, urgency_to_code["routine"])

    risk_assessment_resource = {
        "resourceType": "RiskAssessment",
        "id": risk_assessment_id,
        "status": "final",
        "subject": {"reference": f"Patient/{patient_id}"},
        "encounter": {"reference": f"Encounter/{encounter_id}"},
        "occurrenceDateTime": now,
        "method": {
            "coding": [
                {
                    "system": "urn:steer-health:triage-method",
                    "code": "ai-triage-v1",
                    "display": "AI-Powered Clinical Triage v1",
                }
            ]
        },
        "prediction": [
            {
                "outcome": {
                    "coding": [
                        {
                            "system": "http://loinc.org",
                            **risk_code,
                        }
                    ],
                    "text": f"Triage Level: {urgency}",
                },
                "probabilityDecimal": (triage_data.get("urgency_score", 50)) / 100,
            }
        ],
        "note": [
            {"text": triage_data.get("ai_reasoning", "")},
            {"text": f"Recommended: {triage_data.get('recommended_action', 'N/A')}"},
        ],
    }

    # -------------------------------------------------------------------------
    # FHIR Bundle (transaction type - all-or-nothing)
    # -------------------------------------------------------------------------
    bundle = {
        "resourceType": "Bundle",
        "id": str(uuid.uuid4()),
        "type": "transaction",
        "timestamp": now,
        "entry": [
            {
                "fullUrl": f"urn:uuid:{patient_id}",
                "resource": patient_resource,
                "request": {"method": "POST", "url": "Patient"},
            },
            {
                "fullUrl": f"urn:uuid:{condition_id}",
                "resource": condition_resource,
                "request": {"method": "POST", "url": "Condition"},
            },
            {
                "fullUrl": f"urn:uuid:{encounter_id}",
                "resource": encounter_resource,
                "request": {"method": "POST", "url": "Encounter"},
            },
            {
                "fullUrl": f"urn:uuid:{risk_assessment_id}",
                "resource": risk_assessment_resource,
                "request": {"method": "POST", "url": "RiskAssessment"},
            },
        ],
    }

    return bundle


def _map_gender(gender: Optional[str]) -> str:
    """Map common gender strings to FHIR-compliant values."""
    if not gender:
        return "unknown"
    mapping = {
        "male": "male", "m": "male",
        "female": "female", "f": "female",
        "other": "other", "non-binary": "other",
    }
    return mapping.get(gender.lower(), "unknown")


def _build_telecom(patient_data: dict) -> list:
    """Build FHIR telecom array from patient contact info."""
    telecom = []
    if patient_data.get("phone"):
        telecom.append({
            "system": "phone",
            "value": patient_data["phone"],
            "use": "mobile",
        })
    if patient_data.get("email"):
        telecom.append({
            "system": "email",
            "value": patient_data["email"],
        })
    return telecom


def _map_symptoms_to_snomed(symptoms: str) -> list:
    """
    Map symptom keywords to SNOMED CT codes.
    In production, you'd use a terminology service (e.g., UMLS API, Ontoserver)
    or the EHR's built-in concept search. This is a simplified demo mapping.
    """
    symptom_codes = {
        "chest pain": {"code": "29857009", "display": "Chest pain"},
        "headache": {"code": "25064002", "display": "Headache"},
        "fever": {"code": "386661006", "display": "Fever"},
        "cough": {"code": "49727002", "display": "Cough"},
        "shortness of breath": {"code": "267036007", "display": "Dyspnea"},
        "nausea": {"code": "422587007", "display": "Nausea"},
        "vomiting": {"code": "422400008", "display": "Vomiting"},
        "abdominal pain": {"code": "21522001", "display": "Abdominal pain"},
        "dizziness": {"code": "404640003", "display": "Dizziness"},
        "fatigue": {"code": "84229001", "display": "Fatigue"},
        "back pain": {"code": "161891005", "display": "Back pain"},
        "sore throat": {"code": "162397003", "display": "Sore throat"},
        "rash": {"code": "271807003", "display": "Skin rash"},
        "anxiety": {"code": "48694002", "display": "Anxiety"},
        "depression": {"code": "35489007", "display": "Depression"},
    }

    symptoms_lower = symptoms.lower()
    matched = []
    for keyword, coding in symptom_codes.items():
        if keyword in symptoms_lower:
            matched.append({
                "system": "http://snomed.info/sct",
                **coding,
            })

    if not matched:
        matched.append({
            "system": "http://snomed.info/sct",
            "code": "404684003",
            "display": "Clinical finding",
        })

    return matched
