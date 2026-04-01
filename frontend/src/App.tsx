import { useState, useEffect, useCallback } from 'react';
import {
  Activity, AlertTriangle, CheckCircle, Clock, Send, Users,
  Zap, Radio, FileJson, Heart, Loader2, ChevronDown, ChevronUp,
  Wifi, WifiOff, Stethoscope, Brain, Database, MessageSquare, Shield
} from 'lucide-react';
import { useWebSocket, WSMessage } from './hooks/useWebSocket';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Patient {
  id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
  phone: string;
  email: string;
  created_at: string;
  symptoms: string;
  severity_self_reported: number;
  intake_event_id: string;
  urgency_level: string | null;
  urgency_score: number | null;
  ai_reasoning: string | null;
  recommended_action: string | null;
  suggested_department: string | null;
  ai_model: string | null;
  processing_time_ms: number | null;
  triage_at: string | null;
}

interface IntakeForm {
  first_name: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
  phone: string;
  email: string;
  symptoms: string;
  reported_duration: string;
  severity_self_reported: number;
}

interface KafkaEvent {
  id: string;
  type: string;
  timestamp: string;
  summary: string;
  direction: 'in' | 'out';
}

const API_BASE = 'http://localhost:3001';
const WS_URL = 'ws://localhost:3002';

const URGENCY_CONFIG: Record<string, { bg: string; text: string; border: string; icon: any; label: string }> = {
  emergency: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-300', icon: AlertTriangle, label: 'Emergency' },
  urgent: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-300', icon: Zap, label: 'Urgent' },
  'semi-urgent': { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-300', icon: Clock, label: 'Semi-Urgent' },
  routine: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-300', icon: CheckCircle, label: 'Routine' },
};

// ---------------------------------------------------------------------------
// App Component
// ---------------------------------------------------------------------------
export default function App() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [kafkaEvents, setKafkaEvents] = useState<KafkaEvent[]>([]);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'intake' | 'pipeline'>('dashboard');
  const [submitting, setSubmitting] = useState(false);
  const [expandedPatient, setExpandedPatient] = useState<string | null>(null);
  const [fhirData, setFhirData] = useState<Record<string, any>>({});
  const [ehrSync, setEhrSync] = useState<Record<string, any[]>>({});
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const { isConnected, lastMessage } = useWebSocket(WS_URL);

  const [form, setForm] = useState<IntakeForm>({
    first_name: '', last_name: '', date_of_birth: '', gender: '',
    phone: '', email: '', symptoms: '', reported_duration: '', severity_self_reported: 5,
  });

  // Fetch patients on mount
  const fetchPatients = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/patients`);
      if (res.ok) {
        const data = await res.json();
        setPatients(data.patients || []);
      }
    } catch (e) {
      console.error('Failed to fetch patients:', e);
    }
  }, []);

  useEffect(() => { fetchPatients(); }, [fetchPatients]);

  // Handle WebSocket messages
  useEffect(() => {
    if (!lastMessage) return;

    const event: KafkaEvent = {
      id: crypto.randomUUID(),
      type: lastMessage.type,
      timestamp: new Date().toISOString(),
      summary: getSummary(lastMessage),
      direction: lastMessage.type === 'NEW_INTAKE' ? 'out' : 'in',
    };
    setKafkaEvents((prev) => [event, ...prev].slice(0, 50));

    if (lastMessage.type === 'TRIAGE_RESULT' || lastMessage.type === 'NEW_INTAKE') {
      fetchPatients();
    }

    if (lastMessage.type === 'FHIR_BUNDLE' && lastMessage.payload?.patient_id) {
      setFhirData((prev) => ({
        ...prev,
        [lastMessage.payload.patient_id]: lastMessage.payload.fhir_bundle,
      }));
    }
  }, [lastMessage, fetchPatients]);

  function getSummary(msg: WSMessage): string {
    switch (msg.type) {
      case 'CONNECTED': return 'WebSocket connected to API Gateway';
      case 'NEW_INTAKE': return `New intake: ${msg.payload?.patient_name} - "${msg.payload?.symptoms?.slice(0, 60)}..."`;
      case 'TRIAGE_RESULT': return `Triage complete: ${msg.payload?.urgency_level?.toUpperCase()} (score: ${msg.payload?.urgency_score}) - ${msg.payload?.ai_model}`;
      case 'FHIR_BUNDLE': return `FHIR R4 Bundle generated for patient ${msg.payload?.patient_id?.slice(0, 8)}...`;
      default: return `Event: ${msg.type}`;
    }
  }

  // Submit intake form
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitSuccess(false);
    try {
      const res = await fetch(`${API_BASE}/api/intake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setSubmitSuccess(true);
        setForm({
          first_name: '', last_name: '', date_of_birth: '', gender: '',
          phone: '', email: '', symptoms: '', reported_duration: '', severity_self_reported: 5,
        });
        setTimeout(() => setSubmitSuccess(false), 5000);
      }
    } catch (e) {
      console.error('Submit error:', e);
    } finally {
      setSubmitting(false);
    }
  }

  // Fetch FHIR bundle for a patient
  async function fetchFhir(patientId: string) {
    try {
      const res = await fetch(`${API_BASE}/api/patients/${patientId}/fhir`);
      if (res.ok) {
        const data = await res.json();
        setFhirData((prev) => ({ ...prev, [patientId]: data }));
      }
    } catch (e) {
      console.error('Failed to fetch FHIR:', e);
    }
  }

  // Fetch EHR sync status for a patient
  async function fetchEhrSync(patientId: string) {
    try {
      const res = await fetch(`${API_BASE}/api/patients/${patientId}/ehr-sync`);
      if (res.ok) {
        const data = await res.json();
        setEhrSync((prev) => ({ ...prev, [patientId]: data.ehr_sync || [] }));
      }
    } catch (e) {
      console.error('Failed to fetch EHR sync:', e);
    }
  }

  // Count urgency levels
  const urgencyCounts = patients.reduce((acc, p) => {
    const level = p.urgency_level || 'pending';
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-600 p-2 rounded-lg">
              <Heart className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Steer Health</h1>
              <p className="text-xs text-gray-500">AI-Powered Patient Triage Pipeline</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Connection Status */}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${
              isConnected ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
            }`}>
              {isConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              {isConnected ? 'Live' : 'Disconnected'}
            </div>

            {/* Nav Tabs */}
            <nav className="flex bg-gray-100 rounded-lg p-1">
              {[
                { key: 'dashboard', label: 'Dashboard', icon: Activity },
                { key: 'intake', label: 'New Intake', icon: Stethoscope },
                { key: 'pipeline', label: 'Event Pipeline', icon: Radio },
              ].map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key as any)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    activeTab === key
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </button>
              ))}
            </nav>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <StatCard icon={Users} label="Total Patients" value={patients.length} color="blue" />
              <StatCard icon={AlertTriangle} label="Emergency" value={urgencyCounts['emergency'] || 0} color="red" />
              <StatCard icon={Zap} label="Urgent" value={urgencyCounts['urgent'] || 0} color="orange" />
              <StatCard icon={Clock} label="Semi-Urgent" value={urgencyCounts['semi-urgent'] || 0} color="yellow" />
              <StatCard icon={CheckCircle} label="Routine" value={urgencyCounts['routine'] || 0} color="green" />
            </div>

            {/* Patient List */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900">Patient Triage Queue</h2>
                <button
                  onClick={fetchPatients}
                  className="text-sm text-emerald-600 hover:text-emerald-700 font-medium"
                >
                  Refresh
                </button>
              </div>

              {patients.length === 0 ? (
                <div className="px-6 py-12 text-center text-gray-500">
                  <Stethoscope className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                  <p className="font-medium">No patients yet</p>
                  <p className="text-sm mt-1">Submit a patient intake to see the pipeline in action</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {patients.map((patient) => (
                    <PatientRow
                      key={patient.id}
                      patient={patient}
                      isExpanded={expandedPatient === patient.id}
                      onToggle={() => {
                        setExpandedPatient(expandedPatient === patient.id ? null : patient.id);
                        if (!fhirData[patient.id]) fetchFhir(patient.id);
                        if (!ehrSync[patient.id]) fetchEhrSync(patient.id);
                      }}
                      fhirBundle={fhirData[patient.id]}
                      ehrSync={ehrSync[patient.id]}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Intake Tab */}
        {activeTab === 'intake' && (
          <div className="max-w-2xl mx-auto">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="bg-emerald-100 p-2 rounded-lg">
                  <Stethoscope className="w-5 h-5 text-emerald-600" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Patient Intake Form</h2>
                  <p className="text-sm text-gray-500">
                    Submit symptoms to trigger the Kafka &rarr; AI Triage &rarr; FHIR pipeline
                  </p>
                </div>
              </div>

              {submitSuccess && (
                <div className="mb-6 p-4 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                  <div>
                    <p className="font-medium text-emerald-800">Intake submitted successfully!</p>
                    <p className="text-sm text-emerald-600 mt-0.5">
                      Event published to Kafka. AI triage processing... Check the Dashboard tab for results.
                    </p>
                  </div>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <InputField label="First Name" required value={form.first_name}
                    onChange={(v) => setForm({ ...form, first_name: v })} placeholder="John" />
                  <InputField label="Last Name" required value={form.last_name}
                    onChange={(v) => setForm({ ...form, last_name: v })} placeholder="Doe" />
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <InputField label="Date of Birth" type="date" value={form.date_of_birth}
                    onChange={(v) => setForm({ ...form, date_of_birth: v })} />
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Gender</label>
                    <select
                      value={form.gender}
                      onChange={(e) => setForm({ ...form, gender: e.target.value })}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                    >
                      <option value="">Select...</option>
                      <option value="male">Male</option>
                      <option value="female">Female</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <InputField label="Phone" value={form.phone}
                    onChange={(v) => setForm({ ...form, phone: v })} placeholder="+1..." />
                </div>
                <InputField label="Email" type="email" value={form.email}
                  onChange={(v) => setForm({ ...form, email: v })} placeholder="patient@email.com" />

                <div className="border-t border-gray-200 pt-4 mt-4">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                    <Brain className="w-4 h-4" /> Clinical Information
                  </h3>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Symptoms / Chief Complaint <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      required
                      rows={4}
                      value={form.symptoms}
                      onChange={(e) => setForm({ ...form, symptoms: e.target.value })}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                      placeholder="Describe symptoms in detail... e.g., Severe chest pain radiating to left arm, started 2 hours ago, difficulty breathing"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4 mt-4">
                    <InputField label="Duration" value={form.reported_duration}
                      onChange={(v) => setForm({ ...form, reported_duration: v })} placeholder="e.g., 2 hours" />
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Pain Severity: {form.severity_self_reported}/10
                      </label>
                      <input
                        type="range" min="1" max="10" value={form.severity_self_reported}
                        onChange={(e) => setForm({ ...form, severity_self_reported: parseInt(e.target.value) })}
                        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                      />
                      <div className="flex justify-between text-xs text-gray-400 mt-1">
                        <span>Mild</span><span>Moderate</span><span>Severe</span>
                      </div>
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? (
                    <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</>
                  ) : (
                    <><Send className="w-4 h-4" /> Submit to Kafka Pipeline</>
                  )}
                </button>
              </form>
            </div>

            {/* Pipeline Visualization */}
            <div className="mt-6 bg-white rounded-xl border border-gray-200 shadow-sm p-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">What happens when you submit:</h3>
              <div className="flex items-center gap-2 text-xs overflow-x-auto pb-2">
                {[
                  { label: 'React Form', icon: '📝', color: 'bg-blue-100 text-blue-700' },
                  { label: 'Node.js API', icon: '🟢', color: 'bg-green-100 text-green-700' },
                  { label: 'Kafka', icon: '📨', color: 'bg-purple-100 text-purple-700' },
                  { label: 'Python AI', icon: '🧠', color: 'bg-amber-100 text-amber-700' },
                  { label: 'Claude/GPT', icon: '🤖', color: 'bg-pink-100 text-pink-700' },
                  { label: 'FHIR R4', icon: '🏥', color: 'bg-red-100 text-red-700' },
                  { label: 'Kafka', icon: '📨', color: 'bg-purple-100 text-purple-700' },
                  { label: 'PostgreSQL', icon: '💾', color: 'bg-indigo-100 text-indigo-700' },
                  { label: 'Redis', icon: '⚡', color: 'bg-orange-100 text-orange-700' },
                  { label: 'WebSocket', icon: '📡', color: 'bg-cyan-100 text-cyan-700' },
                  { label: 'Dashboard', icon: '📊', color: 'bg-emerald-100 text-emerald-700' },
                ].map((step, i) => (
                  <div key={i} className="flex items-center gap-2 flex-shrink-0">
                    <div className={`px-2.5 py-1.5 rounded-md font-medium ${step.color}`}>
                      {step.icon} {step.label}
                    </div>
                    {i < 10 && <span className="text-gray-300">&rarr;</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Pipeline Tab */}
        {activeTab === 'pipeline' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Kafka Event Stream */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
                <Radio className="w-4 h-4 text-purple-600" />
                <h2 className="text-lg font-semibold text-gray-900">Live Kafka Event Stream</h2>
                {isConnected && (
                  <span className="ml-auto flex items-center gap-1 text-xs text-emerald-600">
                    <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                    Live
                  </span>
                )}
              </div>

              <div className="divide-y divide-gray-50 max-h-[600px] overflow-y-auto">
                {kafkaEvents.length === 0 ? (
                  <div className="px-6 py-12 text-center text-gray-500">
                    <Radio className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                    <p className="font-medium">No events yet</p>
                    <p className="text-sm mt-1">Submit an intake to see events flow through Kafka</p>
                  </div>
                ) : (
                  kafkaEvents.map((event) => (
                    <div key={event.id} className="px-6 py-3 animate-slide-in hover:bg-gray-50">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs font-mono px-2 py-0.5 rounded ${
                          event.type === 'TRIAGE_RESULT' ? 'bg-emerald-100 text-emerald-700' :
                          event.type === 'NEW_INTAKE' ? 'bg-blue-100 text-blue-700' :
                          event.type === 'FHIR_BUNDLE' ? 'bg-purple-100 text-purple-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>
                          {event.direction === 'out' ? '📤' : '📥'} {event.type}
                        </span>
                        <span className="text-xs text-gray-400 ml-auto">
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600">{event.summary}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Architecture Diagram */}
            <div className="space-y-6">
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <Database className="w-5 h-5 text-gray-600" />
                  System Architecture
                </h2>
                <div className="space-y-3 text-sm">
                  <ArchRow icon="📝" label="Frontend" tech="React + Vite + TailwindCSS" desc="Patient intake UI & real-time dashboard" />
                  <ArchRow icon="🟢" label="API Gateway" tech="Node.js / TypeScript / Express" desc="REST API + Kafka producer/consumer + WebSocket" />
                  <ArchRow icon="📨" label="Message Bus" tech="Apache Kafka" desc="Event-driven async pipeline (patient.intake, triage.result, fhir.bundle)" />
                  <ArchRow icon="🧠" label="AI Triage" tech="Python + Claude/OpenAI" desc="LLM-powered clinical reasoning (not keyword matching)" />
                  <ArchRow icon="🏥" label="FHIR Engine" tech="FHIR R4 + HL7 v2.x" desc="Generates Patient, Condition, Encounter, RiskAssessment resources" />
                  <ArchRow icon="💾" label="Database" tech="PostgreSQL" desc="Persistent storage for patients, triage, EHR sync log" />
                  <ArchRow icon="⚡" label="Cache" tech="Redis" desc="Triage result caching + real-time pub/sub" />
                  <ArchRow icon="📡" label="Real-time" tech="WebSocket" desc="Push triage updates to connected dashboards" />
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <MessageSquare className="w-5 h-5 text-gray-600" />
                  Kafka Topics
                </h2>
                <div className="space-y-2 text-sm">
                  <TopicRow name="patient.intake" desc="New patient symptom submissions from API gateway" color="blue" />
                  <TopicRow name="triage.result" desc="AI triage decisions from Python service" color="emerald" />
                  <TopicRow name="fhir.bundle" desc="Generated FHIR R4 resource bundles" color="purple" />
                  <TopicRow name="ehr.sync" desc="EHR sync requests (Epic, athena, eCW)" color="orange" />
                  <TopicRow name="patient.intake.dlq" desc="Dead letter queue for failed processing" color="red" />
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-Components
// ---------------------------------------------------------------------------

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: number; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-600',
    red: 'bg-red-50 text-red-600',
    orange: 'bg-orange-50 text-orange-600',
    yellow: 'bg-yellow-50 text-yellow-600',
    green: 'bg-green-50 text-green-600',
  };
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${colors[color]}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          <p className="text-xs text-gray-500">{label}</p>
        </div>
      </div>
    </div>
  );
}

function InputField({ label, required, value, onChange, placeholder, type = 'text' }: {
  label: string; required?: boolean; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <input
        type={type} required={required} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
      />
    </div>
  );
}

function PatientRow({ patient, isExpanded, onToggle, fhirBundle, ehrSync }: {
  patient: Patient; isExpanded: boolean; onToggle: () => void; fhirBundle?: any; ehrSync?: any[];
}) {
  const urgency = patient.urgency_level ? URGENCY_CONFIG[patient.urgency_level] : null;
  const isPending = !patient.urgency_level;

  return (
    <div className="hover:bg-gray-50 transition-colors">
      <div className="px-6 py-4 flex items-center gap-4 cursor-pointer" onClick={onToggle}>
        {/* Urgency Badge */}
        <div className={`flex-shrink-0 w-24 text-center px-2 py-1 rounded-full text-xs font-semibold border ${
          isPending ? 'bg-gray-100 text-gray-500 border-gray-200' :
          `${urgency?.bg} ${urgency?.text} ${urgency?.border}`
        }`}>
          {isPending ? (
            <span className="flex items-center justify-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Pending
            </span>
          ) : (
            urgency?.label
          )}
        </div>

        {/* Patient Info */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-gray-900">
            {patient.first_name} {patient.last_name}
          </p>
          <p className="text-sm text-gray-500 truncate">{patient.symptoms}</p>
        </div>

        {/* Score */}
        {patient.urgency_score && (
          <div className="text-right flex-shrink-0">
            <p className="text-lg font-bold text-gray-900">{patient.urgency_score}</p>
            <p className="text-xs text-gray-400">score</p>
          </div>
        )}

        {/* AI Model */}
        {patient.ai_model && (
          <span className="flex-shrink-0 text-xs font-mono bg-gray-100 px-2 py-1 rounded text-gray-500">
            {patient.ai_model}
          </span>
        )}

        {/* Processing Time */}
        {patient.processing_time_ms && (
          <span className="flex-shrink-0 text-xs text-gray-400">
            {patient.processing_time_ms}ms
          </span>
        )}

        {/* Expand Arrow */}
        <div className="flex-shrink-0 text-gray-400">
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </div>

      {/* Expanded Detail */}
      {isExpanded && (
        <div className="px-6 pb-4 space-y-4 border-t border-gray-100 pt-4 bg-gray-50/50">
          {patient.ai_reasoning && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1 flex items-center gap-1">
                <Brain className="w-3 h-3" /> AI Reasoning
              </h4>
              <p className="text-sm text-gray-700 bg-white p-3 rounded-lg border border-gray-200">
                {patient.ai_reasoning}
              </p>
            </div>
          )}
          {patient.recommended_action && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Recommended Action</h4>
              <p className="text-sm text-gray-700">{patient.recommended_action}</p>
            </div>
          )}
          {patient.suggested_department && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Department</h4>
              <p className="text-sm text-gray-700">{patient.suggested_department}</p>
            </div>
          )}
          {ehrSync && ehrSync.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1 flex items-center gap-1">
                <Shield className="w-3 h-3" /> EHR Sync Status
              </h4>
              <div className="grid grid-cols-3 gap-2">
                {ehrSync.map((sync: any) => {
                  const isOk = sync.sync_status === 'synced';
                  const isFailed = sync.sync_status === 'failed';
                  const ehrLabels: Record<string, string> = {
                    epic: 'Epic',
                    athenahealth: 'athenahealth',
                    eclinicalworks: 'eClinicalWorks',
                  };
                  return (
                    <div
                      key={sync.id}
                      className={`p-3 rounded-lg border text-sm ${
                        isOk ? 'bg-emerald-50 border-emerald-200' :
                        isFailed ? 'bg-red-50 border-red-200' :
                        'bg-yellow-50 border-yellow-200'
                      }`}
                    >
                      <p className="font-semibold text-gray-900">{ehrLabels[sync.ehr_system] || sync.ehr_system}</p>
                      <p className={`text-xs font-medium mt-1 ${
                        isOk ? 'text-emerald-700' : isFailed ? 'text-red-700' : 'text-yellow-700'
                      }`}>
                        {isOk ? '\u2705 Synced' : isFailed ? '\u274C Failed' : '\u23F3 Pending'}
                      </p>
                      {sync.synced_at && (
                        <p className="text-xs text-gray-400 mt-0.5">
                          {new Date(sync.synced_at).toLocaleTimeString()}
                        </p>
                      )}
                      {sync.error_message && (
                        <p className="text-xs text-red-500 mt-0.5">{sync.error_message}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {fhirBundle && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1 flex items-center gap-1">
                <FileJson className="w-3 h-3" /> FHIR R4 Bundle
              </h4>
              <pre className="text-xs text-gray-600 bg-gray-900 text-emerald-400 p-4 rounded-lg overflow-x-auto max-h-64">
                {JSON.stringify(fhirBundle, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ArchRow({ icon, label, tech, desc }: { icon: string; label: string; tech: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 p-2 rounded-lg hover:bg-gray-50">
      <span className="text-lg flex-shrink-0">{icon}</span>
      <div>
        <p className="font-medium text-gray-900">{label} <span className="text-xs font-mono text-gray-400">({tech})</span></p>
        <p className="text-xs text-gray-500">{desc}</p>
      </div>
    </div>
  );
}

function TopicRow({ name, desc, color }: { name: string; desc: string; color: string }) {
  const colors: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-700',
    emerald: 'bg-emerald-100 text-emerald-700',
    purple: 'bg-purple-100 text-purple-700',
    orange: 'bg-orange-100 text-orange-700',
    red: 'bg-red-100 text-red-700',
  };
  return (
    <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50">
      <span className={`text-xs font-mono px-2 py-1 rounded ${colors[color]}`}>{name}</span>
      <span className="text-xs text-gray-500">{desc}</span>
    </div>
  );
}
