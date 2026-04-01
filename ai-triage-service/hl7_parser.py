"""
HL7 v2.x Message Parser
========================
HL7 v2.x is the older (but still widely used) messaging standard in healthcare.
While FHIR R4 is the modern REST-based standard, many hospital systems still
send ADT (Admit/Discharge/Transfer) messages, lab results, and orders via
HL7 v2.x over TCP/IP (MLLP protocol).

This module demonstrates parsing HL7 v2.x messages into structured data
that can be fed into our AI triage pipeline.

HL7 v2.x MESSAGE STRUCTURE:
- Messages are pipe-delimited (|) text
- Each line is a "segment" starting with a 3-letter code:
  - MSH: Message Header (metadata)
  - PID: Patient Identification
  - PV1: Patient Visit
  - OBX: Observation/Result
  - DG1: Diagnosis
  - EVN: Event Type
- Fields within segments are separated by |
- Components within fields are separated by ^
- Repetitions within fields are separated by ~

Example ADT^A01 (Admit) message:
MSH|^~\\&|EPIC|HOSPITAL|STEER|HEALTH|20240115120000||ADT^A01|MSG001|P|2.5.1
PID|1||MRN123^^^EPIC||DOE^JOHN||19850315|M|||123 MAIN ST^^CHICAGO^IL^60601
PV1|1|E||||||DR^SMITH^JANE|||||||||||V001|||||||||||||||||||||||||20240115120000
OBX|1|TX|CHIEF_COMPLAINT||Severe chest pain radiating to left arm||||||F
DG1|1||R07.9^Chest pain, unspecified^ICD10|||A
"""

from typing import Optional
from dataclasses import dataclass, field


@dataclass
class HL7Patient:
    """Parsed patient data from PID segment."""
    mrn: str = ""
    last_name: str = ""
    first_name: str = ""
    date_of_birth: str = ""
    gender: str = ""
    address: str = ""
    phone: str = ""


@dataclass
class HL7Observation:
    """Parsed observation from OBX segment."""
    set_id: str = ""
    value_type: str = ""
    identifier: str = ""
    value: str = ""
    status: str = ""


@dataclass
class HL7Diagnosis:
    """Parsed diagnosis from DG1 segment."""
    set_id: str = ""
    code: str = ""
    description: str = ""
    coding_system: str = ""
    diagnosis_type: str = ""


@dataclass
class HL7Message:
    """Complete parsed HL7 v2.x message."""
    message_type: str = ""
    trigger_event: str = ""
    message_id: str = ""
    version: str = ""
    sending_facility: str = ""
    receiving_facility: str = ""
    timestamp: str = ""
    patient: HL7Patient = field(default_factory=HL7Patient)
    observations: list[HL7Observation] = field(default_factory=list)
    diagnoses: list[HL7Diagnosis] = field(default_factory=list)
    chief_complaint: str = ""
    visit_number: str = ""
    patient_class: str = ""  # E=Emergency, I=Inpatient, O=Outpatient


def parse_hl7_message(raw_message: str) -> HL7Message:
    """
    Parse a raw HL7 v2.x message string into a structured HL7Message object.
    
    This handles the most common segments found in ADT messages that would
    flow from Epic/athenahealth/eClinicalWorks into Steer Health's platform.
    """
    msg = HL7Message()
    
    # Normalize line endings and split into segments
    lines = raw_message.strip().replace("\r\n", "\n").replace("\r", "\n").split("\n")
    
    for line in lines:
        if not line.strip():
            continue
            
        fields = line.split("|")
        segment_type = fields[0] if fields else ""
        
        if segment_type == "MSH":
            msg = _parse_msh(fields, msg)
        elif segment_type == "PID":
            msg.patient = _parse_pid(fields)
        elif segment_type == "PV1":
            msg = _parse_pv1(fields, msg)
        elif segment_type == "OBX":
            obs = _parse_obx(fields)
            if obs:
                msg.observations.append(obs)
                # Extract chief complaint from OBX
                if obs.identifier and "CHIEF_COMPLAINT" in obs.identifier.upper():
                    msg.chief_complaint = obs.value
        elif segment_type == "DG1":
            dx = _parse_dg1(fields)
            if dx:
                msg.diagnoses.append(dx)
    
    return msg


def _parse_msh(fields: list[str], msg: HL7Message) -> HL7Message:
    """Parse MSH (Message Header) segment."""
    if len(fields) > 2:
        msg.sending_facility = _get_field(fields, 3)
    if len(fields) > 4:
        msg.receiving_facility = _get_field(fields, 5)
    if len(fields) > 6:
        msg.timestamp = _get_field(fields, 7)
    if len(fields) > 8:
        msg_type = _get_field(fields, 9)
        parts = msg_type.split("^")
        msg.message_type = parts[0] if parts else ""
        msg.trigger_event = parts[1] if len(parts) > 1 else ""
    if len(fields) > 9:
        msg.message_id = _get_field(fields, 10)
    if len(fields) > 11:
        msg.version = _get_field(fields, 12)
    return msg


def _parse_pid(fields: list[str]) -> HL7Patient:
    """Parse PID (Patient Identification) segment."""
    patient = HL7Patient()
    
    # PID-3: Patient Identifier List
    if len(fields) > 3:
        id_field = _get_field(fields, 3)
        patient.mrn = id_field.split("^")[0] if id_field else ""
    
    # PID-5: Patient Name (Family^Given^Middle)
    if len(fields) > 5:
        name = _get_field(fields, 5)
        parts = name.split("^")
        patient.last_name = parts[0] if parts else ""
        patient.first_name = parts[1] if len(parts) > 1 else ""
    
    # PID-7: Date of Birth
    if len(fields) > 7:
        dob = _get_field(fields, 7)
        if dob and len(dob) >= 8:
            patient.date_of_birth = f"{dob[:4]}-{dob[4:6]}-{dob[6:8]}"
    
    # PID-8: Sex
    if len(fields) > 8:
        patient.gender = _get_field(fields, 8).lower()
        gender_map = {"m": "male", "f": "female", "o": "other", "u": "unknown"}
        patient.gender = gender_map.get(patient.gender, patient.gender)
    
    # PID-11: Address
    if len(fields) > 11:
        addr = _get_field(fields, 11)
        patient.address = addr.replace("^", ", ")
    
    # PID-13: Phone
    if len(fields) > 13:
        patient.phone = _get_field(fields, 13)
    
    return patient


def _parse_pv1(fields: list[str], msg: HL7Message) -> HL7Message:
    """Parse PV1 (Patient Visit) segment."""
    if len(fields) > 2:
        msg.patient_class = _get_field(fields, 2)
    if len(fields) > 19:
        msg.visit_number = _get_field(fields, 19)
    return msg


def _parse_obx(fields: list[str]) -> Optional[HL7Observation]:
    """Parse OBX (Observation) segment."""
    if len(fields) < 6:
        return None
    
    obs = HL7Observation()
    obs.set_id = _get_field(fields, 1)
    obs.value_type = _get_field(fields, 2)
    obs.identifier = _get_field(fields, 3)
    obs.value = _get_field(fields, 5)
    if len(fields) > 11:
        obs.status = _get_field(fields, 11)
    return obs


def _parse_dg1(fields: list[str]) -> Optional[HL7Diagnosis]:
    """Parse DG1 (Diagnosis) segment."""
    if len(fields) < 4:
        return None
    
    dx = HL7Diagnosis()
    dx.set_id = _get_field(fields, 1)
    
    code_field = _get_field(fields, 3)
    parts = code_field.split("^")
    dx.code = parts[0] if parts else ""
    dx.description = parts[1] if len(parts) > 1 else ""
    dx.coding_system = parts[2] if len(parts) > 2 else ""
    
    if len(fields) > 6:
        dx.diagnosis_type = _get_field(fields, 6)
    
    return dx


def _get_field(fields: list[str], index: int) -> str:
    """Safely get a field value by index."""
    if index < len(fields):
        return fields[index].strip()
    return ""


def hl7_to_intake_data(hl7_msg: HL7Message) -> dict:
    """
    Convert a parsed HL7 message into the format expected by our triage pipeline.
    This bridges the gap between legacy HL7 v2.x systems and our modern
    Kafka-based event pipeline.
    """
    # Combine chief complaint and diagnoses into symptoms string
    symptoms_parts = []
    if hl7_msg.chief_complaint:
        symptoms_parts.append(hl7_msg.chief_complaint)
    for dx in hl7_msg.diagnoses:
        if dx.description:
            symptoms_parts.append(dx.description)
    for obs in hl7_msg.observations:
        if obs.value and "CHIEF_COMPLAINT" not in obs.identifier.upper():
            symptoms_parts.append(obs.value)

    return {
        "first_name": hl7_msg.patient.first_name,
        "last_name": hl7_msg.patient.last_name,
        "date_of_birth": hl7_msg.patient.date_of_birth,
        "gender": hl7_msg.patient.gender,
        "phone": hl7_msg.patient.phone,
        "symptoms": ". ".join(symptoms_parts) if symptoms_parts else "No symptoms reported",
        "source": "hl7_v2",
        "hl7_message_type": f"{hl7_msg.message_type}^{hl7_msg.trigger_event}",
        "hl7_message_id": hl7_msg.message_id,
        "visit_number": hl7_msg.visit_number,
        "patient_class": hl7_msg.patient_class,
    }


# Example usage / test
SAMPLE_HL7_MESSAGE = """MSH|^~\\&|EPIC|MEMORIAL_HOSPITAL|STEER|HEALTH|20240115120000||ADT^A01|MSG00001|P|2.5.1
EVN|A01|20240115120000
PID|1||MRN12345^^^EPIC||DOE^JOHN^A||19850315|M|||123 MAIN ST^^CHICAGO^IL^60601||3125551234
PV1|1|E||||||SMITH^JANE^DR|||||||||||V00123|||||||||||||||||||||||||20240115120000
OBX|1|TX|CHIEF_COMPLAINT||Severe chest pain radiating to left arm, onset 2 hours ago||||||F
OBX|2|NM|PAIN_SCALE||8|/10|||||F
DG1|1||R07.9^Chest pain, unspecified^ICD10|||A"""


if __name__ == "__main__":
    print("=" * 60)
    print("HL7 v2.x Parser Demo")
    print("=" * 60)
    
    parsed = parse_hl7_message(SAMPLE_HL7_MESSAGE)
    
    print(f"\nMessage Type: {parsed.message_type}^{parsed.trigger_event}")
    print(f"Version: {parsed.version}")
    print(f"From: {parsed.sending_facility}")
    print(f"\nPatient: {parsed.patient.first_name} {parsed.patient.last_name}")
    print(f"MRN: {parsed.patient.mrn}")
    print(f"DOB: {parsed.patient.date_of_birth}")
    print(f"Gender: {parsed.patient.gender}")
    print(f"\nChief Complaint: {parsed.chief_complaint}")
    print(f"Diagnoses: {[dx.description for dx in parsed.diagnoses]}")
    
    intake = hl7_to_intake_data(parsed)
    print(f"\nConverted to intake format:")
    for k, v in intake.items():
        print(f"  {k}: {v}")
